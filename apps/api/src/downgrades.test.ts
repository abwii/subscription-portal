import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { InvoiceRepository } from "./invoices.js";
import type { SubscriptionForChange } from "./plan-changes.js";
import type { PaymentProvider } from "./payments.js";
import type { PlanPriceRef, SubscriptionRepository } from "./subscriptions.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-17T12:00:00Z");
const clock: Clock = { now: () => NOW };

const SUB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PRO = "22222222-2222-4222-8222-222222222222";
const BASIC = "11111111-1111-4111-8111-111111111111";

// Abonné Pro (rang 2) mensuel.
const sub: SubscriptionForChange = {
  id: SUB_ID,
  status: "active",
  planPriceId: PRO,
  planId: "plan-pro",
  rank: 2,
  interval: "month",
  amountCents: 2000,
  currency: "EUR",
  periodStart: new Date(NOW.getTime() - 15 * DAY),
  periodEnd: new Date(NOW.getTime() + 15 * DAY),
  pendingPlanPriceId: null,
  cancelAtPeriodEnd: false,
  giftId: null,
};

const basicPrice: PlanPriceRef = {
  id: BASIC,
  planId: "plan-basic",
  rank: 1,
  interval: "month",
  amountCents: 1000,
  currency: "EUR",
  active: true,
};

function fakeRepo(over: Partial<SubscriptionRepository> = {}) {
  const scheduled: [string, string][] = [];
  const cleared: [string, string][] = [];
  const repo = {
    findPlanPrice: (id: string) => Promise.resolve(id === BASIC ? basicPrice : null),
    findSubscriptionForChange: (accountId: string, id: string) =>
      Promise.resolve(accountId === "acc-1" && id === SUB_ID ? sub : null),
    findChangeByIdempotencyKey: () => Promise.resolve(null),
    scheduleDowngrade: (subscriptionId: string, planPriceId: string) => {
      scheduled.push([subscriptionId, planPriceId]);
      return Promise.resolve();
    },
    clearScheduledChange: (accountId: string, subscriptionId: string) => {
      cleared.push([accountId, subscriptionId]);
      return Promise.resolve("cleared" as const);
    },
    ...over,
  } as unknown as SubscriptionRepository;
  return { repo, scheduled, cleared };
}

describe("downgrades", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (
    repo: SubscriptionRepository,
    accountId: string | null = "acc-1",
  ) => {
    // Un downgrade ne déplace aucun argent : le fournisseur de paiement ne doit jamais être appelé.
    const payments: PaymentProvider = {
      createPayment: () => Promise.reject(new Error("must not be called")),
    };
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: repo,
      invoices: {} as InvoiceRepository,
      payments,
      clock,
      authenticate: () => Promise.resolve(accountId),
      logger: false,
    });
    apps.push(app);
    return app;
  };
  const change = (
    app: Awaited<ReturnType<typeof buildApp>>,
    planPriceId = BASIC,
  ) =>
    app.inject({
      method: "POST",
      url: `/subscriptions/${SUB_ID}/change-plan`,
      payload: { planPriceId },
      headers: { "idempotency-key": "k1" },
    });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  describe("POST /subscriptions/:id/change-plan to a lower plan", () => {
    it("schedules the change for the end of the period without charging or refunding", async () => {
      const { repo, scheduled } = fakeRepo();
      const res = await change(await make(repo));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        scheduledChange: {
          planPriceId: BASIC,
          effectiveAt: sub.periodEnd.toISOString(),
        },
      });
      expect(scheduled).toEqual([[SUB_ID, BASIC]]);
    });

    it("schedules a yearly to monthly switch on the same plan", async () => {
      const { repo, scheduled } = fakeRepo({
        findSubscriptionForChange: () =>
          Promise.resolve({ ...sub, planId: "plan-basic", rank: 1, interval: "year" as const }),
        findPlanPrice: () => Promise.resolve({ ...basicPrice, planId: "plan-basic" }),
      });
      expect((await change(await make(repo))).statusCode).toBe(200);
      expect(scheduled).toHaveLength(1);
    });

    it("keeps the current rights: nothing is changed besides the pending price", async () => {
      const { repo } = fakeRepo({
        createChangeInvoice: () => Promise.reject(new Error("no invoice for a downgrade")),
      });
      expect((await change(await make(repo))).statusCode).toBe(200);
    });

    it("returns 409 for a subscription that is not active", async () => {
      const { repo, scheduled } = fakeRepo({
        findSubscriptionForChange: () => Promise.resolve({ ...sub, status: "paused" as const }),
      });
      const res = await change(await make(repo));
      expect(res.statusCode).toBe(409);
      expect(scheduled).toHaveLength(0);
    });

    it("returns 422 for the current price", async () => {
      const { repo } = fakeRepo({
        findPlanPrice: () => Promise.resolve({ ...basicPrice, id: PRO }),
      });
      const res = await change(await make(repo), PRO);
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "same_plan" });
    });
  });

  describe("DELETE /subscriptions/:id/scheduled-change", () => {
    const del = (app: Awaited<ReturnType<typeof buildApp>>, id = SUB_ID) =>
      app.inject({ method: "DELETE", url: `/subscriptions/${id}/scheduled-change` });

    it("cancels a scheduled change", async () => {
      const { repo, cleared } = fakeRepo();
      const res = await del(await make(repo));
      expect(res.statusCode).toBe(204);
      expect(cleared).toEqual([["acc-1", SUB_ID]]);
    });

    it("is idempotent when nothing is scheduled", async () => {
      const { repo } = fakeRepo({
        clearScheduledChange: () => Promise.resolve("none" as const),
      });
      expect((await del(await make(repo))).statusCode).toBe(204);
    });

    it("returns 404 for an unknown subscription or another account's, and for a bad id", async () => {
      const { repo } = fakeRepo({
        clearScheduledChange: () => Promise.resolve("not_found" as const),
      });
      expect((await del(await make(repo))).statusCode).toBe(404);
      expect((await del(await make(repo), "not-a-uuid")).statusCode).toBe(404);
    });

    it("returns 401 without an authenticated account", async () => {
      const { repo } = fakeRepo();
      expect((await del(await make(repo, null))).statusCode).toBe(401);
    });
  });
});
