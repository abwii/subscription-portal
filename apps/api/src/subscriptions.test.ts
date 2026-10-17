import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { InvoiceRepository } from "./invoices.js";
import type { PaymentProvider } from "./payments.js";
import {
  DuplicateIdempotencyKeyError,
  expirePendingSubscriptions,
  LiveSubscriptionExistsError,
  type CheckoutRecord,
  type PlanPriceRef,
  type SubscriptionRepository,
} from "./subscriptions.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const clock: Clock = { now: () => NOW };
const HOUR = 60 * 60 * 1000;

const PRICE_ID = "11111111-1111-4111-8111-111111111111";
const price: PlanPriceRef = {
  id: PRICE_ID,
  planId: "plan-pro",
  rank: 1,
  interval: "month",
  amountCents: 1999,
  currency: "EUR",
  active: true,
};

function fakeRepo(over: Partial<SubscriptionRepository> = {}) {
  const created: Parameters<SubscriptionRepository["createPending"]>[0][] = [];
  const byKey = new Map<string, CheckoutRecord>();
  const repo: SubscriptionRepository = {
    findPlanPrice: (id) => Promise.resolve(id === PRICE_ID ? price : null),
    findByIdempotencyKey: (accountId, key) =>
      Promise.resolve(byKey.get(`${accountId}:${key}`) ?? null),
    createPending: (input) => {
      created.push(input);
      const record: CheckoutRecord = {
        subscriptionId: `sub-${String(created.length)}`,
        status: "pending",
        planPriceId: input.planPriceId,
        invoiceId: `inv-${String(created.length)}`,
        invoiceNumber: `INV-00000${String(created.length)}`,
        invoiceStatus: "open",
        totalCents: input.amountCents,
        currency: input.currency,
      };
      byKey.set(`${input.accountId}:${input.idempotencyKey}`, record);
      return Promise.resolve(record);
    },
    recordPayment: () => Promise.resolve(),
    applyPaymentEvent: () => Promise.resolve("applied"),
    findSubscriptionForChange: () => Promise.resolve(null),
    findChangeByIdempotencyKey: () => Promise.resolve(null),
    createChangeInvoice: () => Promise.reject(new Error("not used")),
    scheduleDowngrade: () => Promise.resolve(),
    clearScheduledChange: () => Promise.resolve("none"),
    listDueRenewals: () => Promise.resolve([]),
    createRenewalInvoice: () => Promise.resolve(null),
    countPausesSince: () => Promise.resolve(0),
    pause: () => Promise.resolve(true),
    resume: () => Promise.resolve(null),
    listDueResumes: () => Promise.resolve([]),
    scheduleCancellation: () => Promise.resolve(true),
    revokeCancellation: () => Promise.resolve(true),
    cancelNow: () => Promise.resolve(true),
    closeEnded: () => Promise.resolve(0),
    expirePending: () => Promise.resolve(0),
    ...over,
  };
  return { repo, created };
}

function fakePayments(): PaymentProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    createPayment: (input) => {
      calls.push(input.idempotencyKey);
      return Promise.resolve({
        providerRef: `pi_${input.idempotencyKey}`,
        clientSecret: `secret_${input.idempotencyKey}`,
      });
    },
  };
}

describe("POST /subscriptions", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (opts: {
    repo?: SubscriptionRepository;
    payments?: PaymentProvider | undefined;
    accountId?: string | null;
  }) => {
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: opts.repo ?? fakeRepo().repo,
      invoices: {} as InvoiceRepository,
      ...(opts.payments ? { payments: opts.payments } : {}),
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
    body: unknown = { planPriceId: PRICE_ID },
    key: string | null = "key-1",
  ) =>
    app.inject({
      method: "POST",
      url: "/subscriptions",
      payload: body as object,
      headers: key === null ? {} : { "idempotency-key": key },
    });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("creates a pending subscription with an open invoice and payment details", async () => {
    const { repo, created } = fakeRepo();
    const app = await make({ repo, payments: fakePayments() });
    const res = await post(app);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      subscription: { id: "sub-1", status: "pending" },
      invoice: {
        id: "inv-1",
        number: "INV-000001",
        status: "open",
        totalCents: 1999,
        currency: "EUR",
      },
      payment: { providerRef: "pi_key-1", clientSecret: "secret_key-1" },
    });
    expect(created).toEqual([
      {
        accountId: "acc-1",
        planPriceId: PRICE_ID,
        idempotencyKey: "key-1",
        amountCents: 1999,
        currency: "EUR",
        interval: "month",
        now: NOW,
      },
    ]);
  });

  it("returns 401 without an authenticated account", async () => {
    const app = await make({ payments: fakePayments(), accountId: null });
    expect((await post(app)).statusCode).toBe(401);
  });

  it("returns 400 without an Idempotency-Key header or with an invalid body", async () => {
    const app = await make({ payments: fakePayments() });
    expect((await post(app, { planPriceId: PRICE_ID }, null)).statusCode).toBe(400);
    expect((await post(app, {})).statusCode).toBe(400);
    expect((await post(app, { planPriceId: "not-a-uuid" })).statusCode).toBe(400);
  });

  it("returns 422 for an inactive or unknown price and creates nothing", async () => {
    const { repo, created } = fakeRepo({
      findPlanPrice: (id) =>
        Promise.resolve(
          id === PRICE_ID ? { ...price, active: false } : null,
        ),
    });
    const app = await make({ repo, payments: fakePayments() });
    expect((await post(app)).statusCode).toBe(422);
    const unknown = await post(app, {
      planPriceId: "22222222-2222-4222-8222-222222222222",
    });
    expect(unknown.statusCode).toBe(422);
    expect(created).toHaveLength(0);
  });

  it("returns 409 when the account already has a live subscription", async () => {
    const { repo } = fakeRepo({
      createPending: () => Promise.reject(new LiveSubscriptionExistsError()),
    });
    const payments = fakePayments();
    const app = await make({ repo, payments });
    const res = await post(app);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "live_subscription_exists" });
    expect(payments.calls).toHaveLength(0);
  });

  it("creates a single subscription when the same key is replayed", async () => {
    const { repo, created } = fakeRepo();
    const payments = fakePayments();
    const app = await make({ repo, payments });
    const first = await post(app);
    const second = await post(app);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(created).toHaveLength(1);
    // le fournisseur est rappelé avec la même clé : il est idempotent sur celle-ci
    expect(payments.calls).toEqual(["key-1", "key-1"]);
  });

  it("returns 409 when a key is reused for another price", async () => {
    const { repo } = fakeRepo();
    const app = await make({ repo, payments: fakePayments() });
    await post(app);
    const other = "33333333-3333-4333-8333-333333333333";
    const repo2 = fakeRepo({
      findPlanPrice: (id) =>
        Promise.resolve(id === PRICE_ID || id === other ? { ...price, id } : null),
      findByIdempotencyKey: () =>
        Promise.resolve({
          subscriptionId: "sub-1",
          status: "pending",
          planPriceId: PRICE_ID,
          invoiceId: "inv-1",
          invoiceNumber: "INV-000001",
          invoiceStatus: "open",
          totalCents: 1999,
          currency: "EUR",
        }),
    }).repo;
    const app2 = await make({ repo: repo2, payments: fakePayments() });
    const res = await post(app2, { planPriceId: other });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: "idempotency_key_reused" });
  });

  it.each([
    ["live subscription", () => new LiveSubscriptionExistsError()],
    ["idempotency key", () => new DuplicateIdempotencyKeyError()],
  ])(
    "replays the stored result when a concurrent request wins the race (%s violation)",
    async (_name, makeError) => {
      const { repo: base } = fakeRepo();
      const winner: CheckoutRecord = {
        subscriptionId: "sub-w",
        status: "pending",
        planPriceId: PRICE_ID,
        invoiceId: "inv-w",
        invoiceNumber: "INV-000009",
        invoiceStatus: "open",
        totalCents: 1999,
        currency: "EUR",
      };
      let lookups = 0;
      const repo: SubscriptionRepository = {
        ...base,
        findByIdempotencyKey: () =>
          Promise.resolve(++lookups === 1 ? null : winner),
        createPending: () => Promise.reject(makeError()),
      };
      const app = await make({ repo, payments: fakePayments() });
      const res = await post(app);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ subscription: { id: "sub-w" } });
    },
  );

  it("returns 503 when no payment provider is configured", async () => {
    const { repo, created } = fakeRepo();
    const app = await make({ repo });
    const res = await post(app);
    expect(res.statusCode).toBe(503);
    expect(created).toHaveLength(0);
  });

  it("returns 502 when the provider fails, leaving the pending subscription to expire", async () => {
    const { repo, created } = fakeRepo();
    const app = await make({
      repo,
      payments: { createPayment: () => Promise.reject(new Error("boom")) },
    });
    const res = await post(app);
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain("boom");
    expect(created).toHaveLength(1);
  });
});

describe("expirePendingSubscriptions", () => {
  it("expires subscriptions pending for more than 24 hours", async () => {
    let before: Date | undefined;
    const { repo } = fakeRepo({
      expirePending: (d) => {
        before = d;
        return Promise.resolve(3);
      },
    });
    expect(await expirePendingSubscriptions(repo, clock)).toBe(3);
    expect(before).toEqual(new Date(NOW.getTime() - 24 * HOUR));
  });
});
