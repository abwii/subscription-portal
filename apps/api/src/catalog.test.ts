import { afterEach, describe, expect, it } from "vitest";
import { buildApp, type Database } from "./app.js";
import {
  grantsEntitlements,
  type CatalogRepository,
  type EntitlementView,
  type PlanView,
  type SubscriptionRef,
} from "./catalog.js";
import type { Clock } from "./clock.js";
import type { InvoiceRepository } from "./invoices.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const clock: Clock = { now: () => NOW };
const db: Database = { ping: () => Promise.resolve() };

const day = 24 * 60 * 60 * 1000;
const sub = (over: Partial<SubscriptionRef> = {}): SubscriptionRef => ({
  status: "active",
  planId: "plan-pro",
  currentPeriodEnd: new Date(NOW.getTime() + 10 * day),
  cancelAtPeriodEnd: false,
  ...over,
});

describe("grantsEntitlements", () => {
  it("grants rights to an active subscription", () => {
    expect(grantsEntitlements(sub(), NOW)).toBe(true);
  });

  it.each(["pending", "paused", "canceled", "expired"] as const)(
    "grants nothing to a %s subscription",
    (status) => {
      expect(grantsEntitlements(sub({ status }), NOW)).toBe(false);
    },
  );

  it("keeps rights for a past_due subscription during the 7-day grace period", () => {
    const pastDue = sub({
      status: "past_due",
      currentPeriodEnd: new Date(NOW.getTime() - 6 * day),
    });
    expect(grantsEntitlements(pastDue, NOW)).toBe(true);
  });

  it("keeps rights until the end of the period when a cancellation is scheduled", () => {
    const cancelling = sub({ cancelAtPeriodEnd: true });
    expect(grantsEntitlements(cancelling, NOW)).toBe(true);
  });

  it("removes rights at the end of the period for a scheduled cancellation, even if the closing job has not run", () => {
    const ended = sub({
      cancelAtPeriodEnd: true,
      currentPeriodEnd: new Date(NOW.getTime() - 1000),
    });
    expect(grantsEntitlements(ended, NOW)).toBe(false);
    const exactlyAtEnd = sub({ cancelAtPeriodEnd: true, currentPeriodEnd: NOW });
    expect(grantsEntitlements(exactlyAtEnd, NOW)).toBe(false);
  });

  it("removes rights once the grace period is over", () => {
    const pastDue = sub({
      status: "past_due",
      currentPeriodEnd: new Date(NOW.getTime() - 8 * day),
    });
    expect(grantsEntitlements(pastDue, NOW)).toBe(false);
  });
});

const entitlements: EntitlementView[] = [
  { code: "projects", kind: "limit", limit: 10 },
  { code: "export", kind: "boolean", limit: null },
];

const plans: PlanView[] = [
  {
    id: "plan-pro",
    code: "pro",
    name: "Pro",
    rank: 2,
    prices: [
      { id: "p-pro-m", interval: "month", amountCents: 1999, currency: "EUR" },
      { id: "p-pro-y", interval: "year", amountCents: 19900, currency: "EUR" },
    ],
    entitlements,
  },
];

function fakeCatalog(over: Partial<CatalogRepository> = {}): CatalogRepository {
  return {
    listPlans: () => Promise.resolve(plans),
    findSubscription: () => Promise.resolve(null),
    listPlanEntitlements: () => Promise.resolve(entitlements),
    ...over,
  };
}

describe("catalog routes", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (
    catalog: CatalogRepository,
    accountId: string | null = "acc-1",
  ) => {
    const app = await buildApp({
      db,
      catalog,
      subscriptions: {} as SubscriptionRepository,
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

  describe("GET /plans", () => {
    it("returns the plans with prices in cents and entitlements", async () => {
      const app = await make(fakeCatalog());
      const res = await app.inject({ method: "GET", url: "/plans" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ plans });
    });

    it("is public: no authentication required", async () => {
      const app = await make(fakeCatalog(), null);
      const res = await app.inject({ method: "GET", url: "/plans" });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("GET /me/entitlements", () => {
    it("returns 401 without an authenticated account", async () => {
      const app = await make(fakeCatalog(), null);
      const res = await app.inject({ method: "GET", url: "/me/entitlements" });
      expect(res.statusCode).toBe(401);
    });

    it("returns the plan entitlements of an active subscription", async () => {
      const asked: string[] = [];
      const app = await make(
        fakeCatalog({
          findSubscription: (accountId) => {
            asked.push(accountId);
            return Promise.resolve(sub());
          },
          listPlanEntitlements: (planId) => {
            expect(planId).toBe("plan-pro");
            return Promise.resolve(entitlements);
          },
        }),
      );
      const res = await app.inject({ method: "GET", url: "/me/entitlements" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ entitlements });
      expect(asked).toEqual(["acc-1"]);
    });

    it("returns an empty list without a live subscription", async () => {
      const app = await make(fakeCatalog());
      const res = await app.inject({ method: "GET", url: "/me/entitlements" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ entitlements: [] });
    });

    it.each(["paused", "expired"] as const)(
      "returns an empty list for a %s subscription",
      async (status) => {
        const app = await make(
          fakeCatalog({
            findSubscription: () => Promise.resolve(sub({ status })),
          }),
        );
        const res = await app.inject({
          method: "GET",
          url: "/me/entitlements",
        });
        expect(res.json()).toEqual({ entitlements: [] });
      },
    );
  });
});
