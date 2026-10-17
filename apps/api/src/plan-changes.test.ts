import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { InvoiceRepository } from "./invoices.js";
import {
  ChangeInProgressError,
  type ChangeRecord,
  type SubscriptionForChange,
} from "./plan-changes.js";
import type { PaymentProvider } from "./payments.js";
import {
  DuplicateIdempotencyKeyError,
  type PlanPriceRef,
  type SubscriptionRepository,
} from "./subscriptions.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-17T12:00:00Z");
const clock: Clock = { now: () => NOW };

const SUB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BASIC = "11111111-1111-4111-8111-111111111111";
const PRO = "22222222-2222-4222-8222-222222222222";

const sub: SubscriptionForChange = {
  id: SUB_ID,
  status: "active",
  planPriceId: BASIC,
  planId: "plan-basic",
  rank: 1,
  interval: "month",
  amountCents: 1000,
  currency: "EUR",
  periodStart: new Date(NOW.getTime() - 15 * DAY),
  periodEnd: new Date(NOW.getTime() + 15 * DAY),
};

const proPrice: PlanPriceRef = {
  id: PRO,
  planId: "plan-pro",
  rank: 2,
  interval: "month",
  amountCents: 2000,
  currency: "EUR",
  active: true,
};

function fakeRepo(over: Partial<SubscriptionRepository> = {}) {
  const created: Parameters<SubscriptionRepository["createChangeInvoice"]>[0][] = [];
  const byKey = new Map<string, ChangeRecord>();
  const repo = {
    findPlanPrice: (id: string) => Promise.resolve(id === PRO ? proPrice : null),
    findSubscriptionForChange: (accountId: string, id: string) =>
      Promise.resolve(accountId === "acc-1" && id === SUB_ID ? sub : null),
    findChangeByIdempotencyKey: (accountId: string, key: string) =>
      Promise.resolve(byKey.get(`${accountId}:${key}`) ?? null),
    createChangeInvoice: (input: Parameters<SubscriptionRepository["createChangeInvoice"]>[0]) => {
      created.push(input);
      const record: ChangeRecord = {
        invoiceId: "inv-1",
        invoiceNumber: "INV-000001",
        invoiceStatus: "open",
        totalCents: input.quote.totalCents,
        currency: input.currency,
        subscriptionId: input.subscriptionId,
        targetPlanPriceId: input.targetPlanPriceId,
        lines: input.quote.lines,
      };
      byKey.set(`${input.accountId}:${input.idempotencyKey}`, record);
      return Promise.resolve(record);
    },
    recordPayment: () => Promise.resolve(),
    ...over,
  } as unknown as SubscriptionRepository;
  return { repo, created };
}

function fakePayments() {
  const calls: { key: string; amount: number }[] = [];
  const provider: PaymentProvider = {
    createPayment: (input) => {
      calls.push({ key: input.idempotencyKey, amount: input.amountCents });
      return Promise.resolve({ providerRef: "pi_c", clientSecret: "secret_c" });
    },
  };
  return { provider, calls };
}

describe("POST /subscriptions/:id/change-plan", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (opts: {
    repo?: SubscriptionRepository;
    payments?: PaymentProvider;
    accountId?: string | null;
  }) => {
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: opts.repo ?? fakeRepo().repo,
      invoices: {} as InvoiceRepository,
      ...(opts.payments ? { payments: opts.payments } : { payments: fakePayments().provider }),
      clock,
      authenticate: () =>
        Promise.resolve(opts.accountId === undefined ? "acc-1" : opts.accountId),
      logger: false,
    });
    apps.push(app);
    return app;
  };
  const post = (
    app: Awaited<ReturnType<typeof buildApp>>,
    over: { id?: string; body?: object; key?: string | null } = {},
  ) =>
    app.inject({
      method: "POST",
      url: `/subscriptions/${over.id ?? SUB_ID}/change-plan`,
      payload: over.body ?? { planPriceId: PRO },
      headers: over.key === null ? {} : { "idempotency-key": over.key ?? "k1" },
    });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("creates an open invoice with the proration lines and payment details", async () => {
    const { repo, created } = fakeRepo();
    const { provider, calls } = fakePayments();
    const app = await make({ repo, payments: provider });
    const res = await post(app);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      invoice: {
        id: "inv-1",
        status: "open",
        totalCents: 500,
        currency: "EUR",
        lines: [
          { type: "proration_credit", amountCents: -500 },
          { type: "proration_charge", amountCents: 1000 },
        ],
      },
      payment: { providerRef: "pi_c", clientSecret: "secret_c" },
    });
    expect(created[0]).toMatchObject({
      accountId: "acc-1",
      subscriptionId: SUB_ID,
      targetPlanPriceId: PRO,
      idempotencyKey: "k1",
      now: NOW,
    });
    expect(created[0]?.quote.startsNewPeriod).toBe(false);
    // clé fournisseur distincte de celle du checkout
    expect(calls).toEqual([{ key: "change:k1", amount: 500 }]);
  });

  it("returns 401 without an authenticated account and 400 without Idempotency-Key", async () => {
    expect((await post(await make({ accountId: null }))).statusCode).toBe(401);
    expect((await post(await make({}), { key: null })).statusCode).toBe(400);
    expect((await post(await make({}), { body: {} })).statusCode).toBe(400);
  });

  it("returns 404 for a subscription that is unknown or belongs to another account", async () => {
    const app = await make({});
    const res = await post(app, { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
    expect(res.statusCode).toBe(404);
    expect((await post(await make({ accountId: "acc-2" }))).statusCode).toBe(404);
  });

  it.each(["paused", "canceled", "pending", "past_due", "expired"] as const)(
    "returns 409 for a %s subscription",
    async (status) => {
      const { repo } = fakeRepo({
        findSubscriptionForChange: () => Promise.resolve({ ...sub, status }),
      });
      const res = await post(await make({ repo }));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "subscription_not_active" });
    },
  );

  it("returns 422 for an unknown or inactive target price", async () => {
    const { repo } = fakeRepo({
      findPlanPrice: () => Promise.resolve({ ...proPrice, active: false }),
    });
    expect((await post(await make({ repo }))).statusCode).toBe(422);
    expect(
      (await post(await make({}), { body: { planPriceId: BASIC } })).statusCode,
    ).toBe(422);
  });

  it("returns 422 when the target is not an upgrade", async () => {
    const { repo } = fakeRepo({
      findPlanPrice: () => Promise.resolve({ ...proPrice, rank: 1, planId: "other" }),
    });
    const res = await post(await make({ repo }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "not_an_upgrade" });
  });

  it("returns 422 on a currency mismatch", async () => {
    const { repo } = fakeRepo({
      findPlanPrice: () => Promise.resolve({ ...proPrice, currency: "USD" }),
    });
    const res = await post(await make({ repo }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "currency_mismatch" });
  });

  it("returns 422 when nothing would be due", async () => {
    const { repo, created } = fakeRepo({
      findSubscriptionForChange: () =>
        Promise.resolve({ ...sub, periodEnd: new Date(NOW.getTime() - DAY) }),
    });
    const res = await post(await make({ repo }));
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: "invalid_proration" });
    expect(created).toHaveLength(0);
  });

  it("returns 409 while another change is awaiting payment", async () => {
    const { repo } = fakeRepo({
      createChangeInvoice: () => Promise.reject(new ChangeInProgressError()),
    });
    const { provider, calls } = fakePayments();
    const res = await post(await make({ repo, payments: provider }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "change_in_progress" });
    expect(calls).toHaveLength(0);
  });

  it("creates a single invoice when the same key is replayed", async () => {
    const { repo, created } = fakeRepo();
    const { provider, calls } = fakePayments();
    const app = await make({ repo, payments: provider });
    const first = await post(app);
    const second = await post(app);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(created).toHaveLength(1);
    expect(calls.map((c) => c.key)).toEqual(["change:k1", "change:k1"]);
  });

  it("replays the stored result when a concurrent request wins the key race", async () => {
    const winner: ChangeRecord = {
      invoiceId: "inv-w",
      invoiceNumber: "INV-000009",
      invoiceStatus: "open",
      totalCents: 500,
      currency: "EUR",
      subscriptionId: SUB_ID,
      targetPlanPriceId: PRO,
      lines: [],
    };
    let lookups = 0;
    const { repo } = fakeRepo({
      findChangeByIdempotencyKey: () => Promise.resolve(++lookups === 1 ? null : winner),
      createChangeInvoice: () => Promise.reject(new DuplicateIdempotencyKeyError()),
    });
    const res = await post(await make({ repo }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ invoice: { id: "inv-w" } });
  });

  it("returns 409 when a key is reused for another target", async () => {
    const { repo } = fakeRepo();
    const app = await make({ repo });
    await post(app);
    const res = await post(app, { body: { planPriceId: "33333333-3333-4333-8333-333333333333" } });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "idempotency_key_reused" });
  });

  it("returns 502 when the provider fails, without leaking the cause", async () => {
    const { repo } = fakeRepo();
    const res = await post(
      await make({
        repo,
        payments: { createPayment: () => Promise.reject(new Error("boom")) },
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("boom");
  });
});
