import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { InvoiceRepository } from "./invoices.js";
import type { LoyaltySummary } from "./loyalty.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const summary: LoyaltySummary = {
  xp: 640,
  tier: {
    code: "silver",
    name: "Argent",
    discountBps: 200,
    since: new Date("2026-10-17T12:00:00Z"),
  },
  nextTier: { code: "gold", name: "Or", minXp: 2000, xpRemaining: 1360 },
};

describe("GET /me/loyalty", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (opts: { accountId?: string | null; asked?: string[] } = {}) => {
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: {} as SubscriptionRepository,
      invoices: {} as InvoiceRepository,
      loyalty: {
        getSummary: (accountId: string) => {
          opts.asked?.push(accountId);
          return Promise.resolve(summary);
        },
      },
      authenticate: () =>
        Promise.resolve(opts.accountId === undefined ? "acc-1" : opts.accountId),
      logger: false,
    });
    apps.push(app);
    return app;
  };
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("returns the XP, the tier with its discount and the distance to the next tier", async () => {
    const asked: string[] = [];
    const res = await (await make({ asked })).inject({ method: "GET", url: "/me/loyalty" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      loyalty: {
        xp: 640,
        tier: {
          code: "silver",
          name: "Argent",
          discountBps: 200,
          since: "2026-10-17T12:00:00.000Z",
        },
        nextTier: { code: "gold", name: "Or", minXp: 2000, xpRemaining: 1360 },
      },
    });
    expect(asked).toEqual(["acc-1"]);
  });

  it("returns 401 without an authenticated account", async () => {
    const res = await (await make({ accountId: null })).inject({
      method: "GET",
      url: "/me/loyalty",
    });
    expect(res.statusCode).toBe(401);
  });
});
