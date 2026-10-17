import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { GiftRepository, RedeemResult } from "./gifts.js";
import type { InvoiceRepository } from "./invoices.js";
import type { SubscriptionForChange } from "./plan-changes.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-17T12:00:00Z");
const clock: Clock = { now: () => NOW };
const CODE = "R3wMTGe_rzvbQ1AU0Nfn8Q";
const SUB_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const periodEnd = new Date("2027-01-17T12:00:00Z");

const redeemed: RedeemResult = {
  kind: "redeemed",
  subscriptionId: SUB_ID,
  periodStart: NOW,
  periodEnd,
};

describe("POST /gifts/redeem", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (opts: {
    result?: RedeemResult;
    accountId?: string | null;
    logStream?: Writable;
    calls?: { code: string; accountId: string; now: Date }[];
  }) => {
    const calls = opts.calls ?? [];
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: {} as SubscriptionRepository,
      invoices: {} as InvoiceRepository,
      gifts: {
        redeem: (input: { code: string; accountId: string; now: Date }) => {
          calls.push(input);
          return Promise.resolve(opts.result ?? redeemed);
        },
      } as unknown as GiftRepository,
      clock,
      authenticate: () =>
        Promise.resolve(opts.accountId === undefined ? "acc-1" : opts.accountId),
      ...(opts.logStream ? { logStream: opts.logStream } : { logger: false }),
    });
    apps.push(app);
    return app;
  };
  const redeem = (app: Awaited<ReturnType<typeof buildApp>>, body: object = { code: CODE }) =>
    app.inject({ method: "POST", url: "/gifts/redeem", payload: body });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("activates a subscription for the gifted duration, without payment", async () => {
    const calls: { code: string; accountId: string; now: Date }[] = [];
    const res = await redeem(await make({ calls }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      subscription: {
        id: SUB_ID,
        status: "active",
        currentPeriodEnd: periodEnd.toISOString(),
        giftedUntil: periodEnd.toISOString(),
      },
    });
    expect(calls).toEqual([{ code: CODE, accountId: "acc-1", now: NOW }]);
  });

  it("returns 410 for a gift already redeemed, expired or refunded", async () => {
    const res = await redeem(await make({ result: { kind: "unavailable" } }));
    expect(res.statusCode).toBe(410);
    expect(res.json()).toEqual({ error: "gift_unavailable" });
  });

  it("returns 404 for an unknown code, without saying anything about it", async () => {
    const res = await redeem(await make({ result: { kind: "not_found" } }));
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "gift_not_found" });
    expect(res.body).not.toContain(CODE);
  });

  it("returns 409 when the account already has a live subscription, and the gift stays usable", async () => {
    const res = await redeem(await make({ result: { kind: "live_subscription" } }));
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: "live_subscription_exists" });
  });

  it("returns 401 without an authenticated account, and 400 for a missing or malformed code", async () => {
    expect((await redeem(await make({ accountId: null }))).statusCode).toBe(401);
    const app = await make({});
    expect((await redeem(app, {})).statusCode).toBe(400);
    expect((await redeem(app, { code: "" })).statusCode).toBe(400);
    expect((await redeem(app, { code: "x".repeat(200) })).statusCode).toBe(400);
  });

  it("rate-limits attempts per client: guessing codes is counted whatever the outcome", async () => {
    const app = await make({ result: { kind: "not_found" } });
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await redeem(app)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 404)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });

  it("never writes the code in the logs, whatever the outcome", async () => {
    let logs = "";
    const logStream = new Writable({
      write(chunk: Buffer, _enc, done) {
        logs += chunk.toString();
        done();
      },
    });
    for (const result of [
      redeemed,
      { kind: "not_found" },
      { kind: "unavailable" },
      { kind: "live_subscription" },
    ] as RedeemResult[]) {
      await redeem(await make({ result, logStream }));
    }
    expect(logs).toContain("/gifts/redeem"); // les requêtes sont bien journalisées
    expect(logs).not.toContain(CODE);
  });
});

describe("gifted subscriptions are not billable", () => {
  const gifted: SubscriptionForChange = {
    id: SUB_ID,
    status: "active",
    planPriceId: "price-pro",
    planId: "plan-pro",
    rank: 2,
    interval: "month",
    amountCents: 1999,
    currency: "EUR",
    periodStart: NOW,
    periodEnd: new Date(NOW.getTime() + 90 * DAY),
    pendingPlanPriceId: null,
    cancelAtPeriodEnd: true,
    giftId: "gift-1",
  };
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async () => {
    const writes: string[] = [];
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: {
        findSubscriptionForChange: () => Promise.resolve(gifted),
        findChangeByIdempotencyKey: () => Promise.resolve(null),
        findPlanPrice: () =>
          Promise.resolve({
            id: "22222222-2222-4222-8222-222222222222",
            planId: "plan-max",
            rank: 3,
            interval: "month" as const,
            amountCents: 3999,
            currency: "EUR",
            active: true,
          }),
        countPausesSince: () => Promise.resolve(0),
        pause: () => {
          writes.push("pause");
          return Promise.resolve(true);
        },
        revokeCancellation: () => {
          writes.push("revoke");
          return Promise.resolve(true);
        },
        createChangeInvoice: () => {
          writes.push("change");
          return Promise.reject(new Error("must not be called"));
        },
        scheduleDowngrade: () => {
          writes.push("downgrade");
          return Promise.resolve();
        },
      } as unknown as SubscriptionRepository,
      invoices: {} as InvoiceRepository,
      payments: { createPayment: () => Promise.reject(new Error("must not be called")) },
      clock,
      authenticate: () => Promise.resolve("acc-1"),
      logger: false,
    });
    apps.push(app);
    return { app, writes };
  };
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("refuses to pause, change plan or revoke the end-of-period cancellation", async () => {
    const { app, writes } = await make();
    const pause = await app.inject({
      method: "POST",
      url: `/subscriptions/${SUB_ID}/pause`,
      payload: { resumeAt: new Date(NOW.getTime() + 10 * DAY).toISOString() },
    });
    const change = await app.inject({
      method: "POST",
      url: `/subscriptions/${SUB_ID}/change-plan`,
      payload: { planPriceId: "22222222-2222-4222-8222-222222222222" },
      headers: { "idempotency-key": "k1" },
    });
    const revoke = await app.inject({
      method: "DELETE",
      url: `/subscriptions/${SUB_ID}/cancellation`,
    });
    for (const res of [pause, change, revoke]) {
      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ error: "gifted_subscription" });
    }
    expect(writes).toEqual([]);
  });
});
