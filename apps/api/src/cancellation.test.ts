import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { InvoiceRepository } from "./invoices.js";
import type { SubscriptionForChange } from "./plan-changes.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-17T12:00:00Z");
const clock: Clock = { now: () => NOW };
const SUB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const periodEnd = new Date(NOW.getTime() + 15 * DAY);

const base: SubscriptionForChange = {
  id: SUB_ID,
  status: "active",
  planPriceId: "price-pro",
  planId: "plan-pro",
  rank: 2,
  interval: "month",
  amountCents: 1999,
  currency: "EUR",
  periodStart: new Date(NOW.getTime() - 15 * DAY),
  periodEnd,
  pendingPlanPriceId: null,
  cancelAtPeriodEnd: false,
  giftId: null,
};

/** Dépôt factice à état : les routes relisent l'abonnement après l'écriture. */
function statefulRepo(initial: Partial<SubscriptionForChange> = {}) {
  let sub: SubscriptionForChange = { ...base, ...initial };
  const calls: string[] = [];
  const repo = {
    findSubscriptionForChange: (accountId: string, id: string) =>
      Promise.resolve(accountId === "acc-1" && id === SUB_ID ? sub : null),
    scheduleCancellation: (input: { subscriptionId: string; now: Date }) => {
      calls.push("schedule");
      expect(input).toEqual({ subscriptionId: SUB_ID, now: NOW });
      sub = { ...sub, cancelAtPeriodEnd: true };
      return Promise.resolve(true);
    },
    cancelNow: (input: { subscriptionId: string; now: Date }) => {
      calls.push("cancelNow");
      expect(input).toEqual({ subscriptionId: SUB_ID, now: NOW });
      sub = { ...sub, status: "canceled" };
      return Promise.resolve(true);
    },
    revokeCancellation: (input: { subscriptionId: string; now: Date }) => {
      calls.push("revoke");
      expect(input).toEqual({ subscriptionId: SUB_ID, now: NOW });
      sub = { ...sub, cancelAtPeriodEnd: false };
      return Promise.resolve(true);
    },
  } as unknown as SubscriptionRepository;
  return { repo, calls };
}

describe("cancellation routes", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (repo: SubscriptionRepository, accountId: string | null = "acc-1") => {
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: repo,
      invoices: {} as InvoiceRepository,
      clock,
      authenticate: () => Promise.resolve(accountId),
      logger: false,
    });
    apps.push(app);
    return app;
  };
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  describe("POST /subscriptions/:id/cancel", () => {
    const cancel = (app: Awaited<ReturnType<typeof buildApp>>, id = SUB_ID) =>
      app.inject({ method: "POST", url: `/subscriptions/${id}/cancel` });

    it("schedules the cancellation for the end of the period for an active subscription", async () => {
      const { repo, calls } = statefulRepo();
      const res = await cancel(await make(repo));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        subscription: {
          id: SUB_ID,
          status: "active",
          cancelAtPeriodEnd: true,
          currentPeriodEnd: periodEnd.toISOString(),
        },
      });
      expect(calls).toEqual(["schedule"]);
    });

    it("is idempotent when the cancellation is already scheduled (no write)", async () => {
      const { repo, calls } = statefulRepo({ cancelAtPeriodEnd: true });
      const res = await cancel(await make(repo));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ subscription: { cancelAtPeriodEnd: true } });
      expect(calls).toEqual([]);
    });

    it.each(["paused", "past_due"] as const)("cancels a %s subscription immediately", async (status) => {
      const { repo, calls } = statefulRepo({ status });
      const res = await cancel(await make(repo));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ subscription: { status: "canceled" } });
      expect(calls).toEqual(["cancelNow"]);
    });

    it("is idempotent for an already canceled subscription (200, no write)", async () => {
      const { repo, calls } = statefulRepo({ status: "canceled" });
      const res = await cancel(await make(repo));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ subscription: { status: "canceled" } });
      expect(calls).toEqual([]);
    });

    it.each(["pending", "expired"] as const)("returns 409 for a %s subscription", async (status) => {
      const { repo, calls } = statefulRepo({ status });
      const res = await cancel(await make(repo));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "subscription_not_cancellable" });
      expect(calls).toEqual([]);
    });

    it("returns 404 for an unknown or foreign subscription and a bad id; 401 when anonymous", async () => {
      const { repo } = statefulRepo();
      expect((await cancel(await make(repo), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).statusCode).toBe(404);
      expect((await cancel(await make(repo, "acc-2"))).statusCode).toBe(404);
      expect((await cancel(await make(repo), "not-a-uuid")).statusCode).toBe(404);
      expect((await cancel(await make(repo, null))).statusCode).toBe(401);
    });
  });

  describe("DELETE /subscriptions/:id/cancellation", () => {
    const revoke = (app: Awaited<ReturnType<typeof buildApp>>, id = SUB_ID) =>
      app.inject({ method: "DELETE", url: `/subscriptions/${id}/cancellation` });

    it("revokes a scheduled cancellation: the renewal stays planned", async () => {
      const { repo, calls } = statefulRepo({ cancelAtPeriodEnd: true });
      const res = await revoke(await make(repo));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        subscription: { status: "active", cancelAtPeriodEnd: false },
      });
      expect(calls).toEqual(["revoke"]);
    });

    it("is idempotent when no cancellation is scheduled", async () => {
      const { repo, calls } = statefulRepo();
      const res = await revoke(await make(repo));
      expect(res.statusCode).toBe(200);
      expect(calls).toEqual([]);
    });

    it.each(["canceled", "expired", "pending", "paused", "past_due"] as const)(
      "returns 409 for a %s subscription: nothing to revoke",
      async (status) => {
        const { repo, calls } = statefulRepo({ status });
        const res = await revoke(await make(repo));
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: "subscription_not_active" });
        expect(calls).toEqual([]);
      },
    );

    it("returns 404 for an unknown subscription; 401 when anonymous", async () => {
      const { repo } = statefulRepo();
      expect((await revoke(await make(repo), "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).statusCode).toBe(404);
      expect((await revoke(await make(repo, null))).statusCode).toBe(401);
    });
  });
});
