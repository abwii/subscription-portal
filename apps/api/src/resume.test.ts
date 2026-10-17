import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { InvoiceRepository } from "./invoices.js";
import type { PaymentProvider } from "./payments.js";
import type { SubscriptionForChange } from "./plan-changes.js";
import { resumeDueSubscriptions, type ResumedInvoice } from "./resume.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-10T00:00:01Z");
const clock: Clock = { now: () => NOW };
const SUB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const paused: SubscriptionForChange = {
  id: SUB_ID,
  status: "paused",
  planPriceId: "price-pro",
  planId: "plan-pro",
  rank: 2,
  interval: "month",
  amountCents: 1999,
  currency: "EUR",
  periodStart: new Date(NOW.getTime() - 40 * DAY),
  periodEnd: new Date(NOW.getTime() - 10 * DAY),
  pendingPlanPriceId: null,
};

const resumed = (subscriptionId = SUB_ID): ResumedInvoice => ({
  invoiceId: `inv-${subscriptionId}`,
  accountId: "acc-1",
  totalCents: 1999,
  currency: "EUR",
});

function fakeRepo(over: Partial<SubscriptionRepository> = {}) {
  const resumes: { subscriptionId: string; now: Date }[] = [];
  const recorded: [string, string, number][] = [];
  const repo = {
    findSubscriptionForChange: (accountId: string, id: string) =>
      Promise.resolve(accountId === "acc-1" && id === SUB_ID ? paused : null),
    resume: (input: { subscriptionId: string; now: Date }) => {
      resumes.push(input);
      return Promise.resolve(resumed(input.subscriptionId));
    },
    recordPayment: (invoiceId: string, providerRef: string, amount: number) => {
      recorded.push([invoiceId, providerRef, amount]);
      return Promise.resolve();
    },
    ...over,
  } as unknown as SubscriptionRepository;
  return { repo, resumes, recorded };
}

function fakePayments() {
  const calls: { key: string; amount: number }[] = [];
  const provider: PaymentProvider = {
    createPayment: (input) => {
      calls.push({ key: input.idempotencyKey, amount: input.amountCents });
      return Promise.resolve({ providerRef: `pi_${input.invoiceId}`, clientSecret: "secret" });
    },
  };
  return { provider, calls };
}

describe("POST /subscriptions/:id/resume", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (
    repo: SubscriptionRepository,
    opts: { payments?: PaymentProvider | null; accountId?: string | null } = {},
  ) => {
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: repo,
      invoices: {} as InvoiceRepository,
      ...(opts.payments === null ? {} : { payments: opts.payments ?? fakePayments().provider }),
      clock,
      authenticate: () =>
        Promise.resolve(opts.accountId === undefined ? "acc-1" : opts.accountId),
      logger: false,
    });
    apps.push(app);
    return app;
  };
  const resume = (app: Awaited<ReturnType<typeof buildApp>>, id = SUB_ID) =>
    app.inject({ method: "POST", url: `/subscriptions/${id}/resume` });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("reactivates the subscription from now and returns the invoice and payment to settle", async () => {
    const { repo, resumes, recorded } = fakeRepo();
    const { provider, calls } = fakePayments();
    const res = await resume(await make(repo, { payments: provider }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      subscription: { id: SUB_ID, status: "active" },
      invoice: { id: `inv-${SUB_ID}`, status: "open", totalCents: 1999, currency: "EUR" },
      payment: { providerRef: `pi_inv-${SUB_ID}`, clientSecret: "secret" },
    });
    expect(resumes).toEqual([{ subscriptionId: SUB_ID, now: NOW }]);
    expect(calls).toEqual([{ key: `invoice:inv-${SUB_ID}`, amount: 1999 }]);
    expect(recorded).toEqual([[`inv-${SUB_ID}`, `pi_inv-${SUB_ID}`, 1999]]);
  });

  it.each(["active", "pending", "past_due", "canceled", "expired"] as const)(
    "returns 409 for a %s subscription",
    async (status) => {
      const { repo, resumes } = fakeRepo({
        findSubscriptionForChange: () => Promise.resolve({ ...paused, status }),
      });
      const res = await resume(await make(repo));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "subscription_not_paused" });
      expect(resumes).toHaveLength(0);
    },
  );

  it("returns 409 when a concurrent resume won the race", async () => {
    const { repo } = fakeRepo({ resume: () => Promise.resolve(null) });
    const res = await resume(await make(repo));
    expect(res.statusCode).toBe(409);
  });

  it("returns 404 for an unknown or foreign subscription and a bad id; 401 when anonymous; 503 without provider", async () => {
    const { repo } = fakeRepo();
    expect((await resume(await make(repo), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).statusCode).toBe(404);
    expect((await resume(await make(repo, { accountId: "acc-2" }))).statusCode).toBe(404);
    expect((await resume(await make(repo), "not-a-uuid")).statusCode).toBe(404);
    expect((await resume(await make(repo, { accountId: null }))).statusCode).toBe(401);
    expect((await resume(await make(repo, { payments: null }))).statusCode).toBe(503);
  });

  it("returns 502 with the invoice id when the provider fails: the subscription is already resumed", async () => {
    const { repo } = fakeRepo();
    const res = await resume(
      await make(repo, {
        payments: { createPayment: () => Promise.reject(new Error("boom")) },
      }),
    );
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "payment_provider_error", invoiceId: `inv-${SUB_ID}` });
    expect(res.body).not.toContain("boom");
  });
});

describe("resumeDueSubscriptions", () => {
  it("resumes every paused subscription whose resume date has passed", async () => {
    const resumes: string[] = [];
    const { repo, recorded } = fakeRepo({
      listDueResumes: (now: Date, limit: number) => {
        expect(now).toEqual(NOW);
        expect(limit).toBeGreaterThan(0);
        return Promise.resolve(["sub-1", "sub-2"]);
      },
      resume: ({ subscriptionId }: { subscriptionId: string }) => {
        resumes.push(subscriptionId);
        return Promise.resolve(resumed(subscriptionId));
      },
    });
    const { provider } = fakePayments();
    const result = await resumeDueSubscriptions({ repo, payments: provider, clock });
    expect(result).toEqual({ resumed: 2, failed: 0 });
    expect(resumes).toEqual(["sub-1", "sub-2"]);
    expect(recorded).toHaveLength(2);
  });

  it("skips a subscription already resumed by someone else (job run twice)", async () => {
    const { repo } = fakeRepo({
      listDueResumes: () => Promise.resolve(["sub-1"]),
      resume: () => Promise.resolve(null),
    });
    const { provider, calls } = fakePayments();
    expect(await resumeDueSubscriptions({ repo, payments: provider, clock })).toEqual({
      resumed: 0,
      failed: 0,
    });
    expect(calls).toHaveLength(0);
  });

  it("keeps going and counts failures when the provider fails for one subscription", async () => {
    let calls = 0;
    const { repo, recorded } = fakeRepo({
      listDueResumes: () => Promise.resolve(["sub-1", "sub-2"]),
      resume: ({ subscriptionId }: { subscriptionId: string }) =>
        Promise.resolve(resumed(subscriptionId)),
    });
    const payments: PaymentProvider = {
      createPayment: (input) => {
        if (++calls === 1) return Promise.reject(new Error("boom"));
        return Promise.resolve({ providerRef: `pi_${input.invoiceId}`, clientSecret: "s" });
      },
    };
    expect(await resumeDueSubscriptions({ repo, payments, clock })).toEqual({
      resumed: 1,
      failed: 1,
    });
    expect(recorded.map((r) => r[0])).toEqual(["inv-sub-2"]);
  });
});
