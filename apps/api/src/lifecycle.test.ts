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

const sub: SubscriptionForChange = {
  id: SUB_ID,
  status: "active",
  planPriceId: "price-pro",
  planId: "plan-pro",
  rank: 2,
  interval: "month",
  amountCents: 1999,
  currency: "EUR",
  periodStart: new Date(NOW.getTime() - 15 * DAY),
  periodEnd: new Date(NOW.getTime() + 15 * DAY),
  pendingPlanPriceId: null,
  cancelAtPeriodEnd: false,
};

const inDays = (n: number) => new Date(NOW.getTime() + n * DAY).toISOString();

function fakeRepo(over: Partial<SubscriptionRepository> = {}) {
  const paused: { subscriptionId: string; now: Date; resumeAt: Date }[] = [];
  const pauseCounts: [string, Date][] = [];
  const repo = {
    findSubscriptionForChange: (accountId: string, id: string) =>
      Promise.resolve(accountId === "acc-1" && id === SUB_ID ? sub : null),
    countPausesSince: (subscriptionId: string, since: Date) => {
      pauseCounts.push([subscriptionId, since]);
      return Promise.resolve(0);
    },
    pause: (input: { subscriptionId: string; now: Date; resumeAt: Date }) => {
      paused.push(input);
      return Promise.resolve(true);
    },
    ...over,
  } as unknown as SubscriptionRepository;
  return { repo, paused, pauseCounts };
}

describe("subscription lifecycle routes", () => {
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

  describe("POST /subscriptions/:id/pause", () => {
    const pause = (
      app: Awaited<ReturnType<typeof buildApp>>,
      body: object = { resumeAt: inDays(30) },
      id = SUB_ID,
    ) => app.inject({ method: "POST", url: `/subscriptions/${id}/pause`, payload: body });

    it("pauses an active subscription until the requested date", async () => {
      const { repo, paused } = fakeRepo();
      const res = await pause(await make(repo));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        subscription: {
          id: SUB_ID,
          status: "paused",
          pausedAt: NOW.toISOString(),
          resumeAt: inDays(30),
        },
      });
      expect(paused).toEqual([
        { subscriptionId: SUB_ID, now: NOW, resumeAt: new Date(inDays(30)) },
      ]);
    });

    it("accepts a pause of exactly 90 days and refuses a longer one", async () => {
      const { repo, paused } = fakeRepo();
      const app = await make(repo);
      expect((await pause(app, { resumeAt: inDays(90) })).statusCode).toBe(200);
      const tooLong = await pause(app, { resumeAt: new Date(NOW.getTime() + 90 * DAY + 1000).toISOString() });
      expect(tooLong.statusCode).toBe(422);
      expect(tooLong.json()).toMatchObject({ error: "pause_too_long" });
      expect(paused).toHaveLength(1);
    });

    it("refuses a resume date that is not in the future", async () => {
      const { repo } = fakeRepo();
      const res = await pause(await make(repo), { resumeAt: NOW.toISOString() });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ error: "resume_in_past" });
    });

    it("returns 400 for a missing or malformed resumeAt", async () => {
      const app = await make(fakeRepo().repo);
      expect((await pause(app, {})).statusCode).toBe(400);
      expect((await pause(app, { resumeAt: "tomorrow" })).statusCode).toBe(400);
    });

    it("returns 409 when a pause was already used in the last 12 months", async () => {
      const { repo, paused, pauseCounts } = fakeRepo({
        countPausesSince: (id: string, since: Date) => {
          pauseCounts.push([id, since]);
          return Promise.resolve(1);
        },
      });
      const res = await pause(await make(repo));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "pause_limit_reached" });
      expect(paused).toHaveLength(0);
      expect(pauseCounts[0]?.[1]).toEqual(new Date(NOW.getTime() - 365 * DAY));
    });

    it.each(["pending", "past_due", "paused", "canceled", "expired"] as const)(
      "returns 409 for a %s subscription",
      async (status) => {
        const { repo, paused } = fakeRepo({
          findSubscriptionForChange: () => Promise.resolve({ ...sub, status }),
        });
        const res = await pause(await make(repo));
        expect(res.statusCode).toBe(409);
        expect(res.json()).toMatchObject({ error: "subscription_not_active" });
        expect(paused).toHaveLength(0);
      },
    );

    it("returns 409 when the repository refuses (unpaid invoice or concurrent change)", async () => {
      const { repo } = fakeRepo({ pause: () => Promise.resolve(false) });
      const res = await pause(await make(repo));
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "pause_unavailable" });
    });

    it("returns 404 for an unknown subscription, another account's, or a bad id; 401 when anonymous", async () => {
      const { repo } = fakeRepo();
      expect((await pause(await make(repo), undefined, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).statusCode).toBe(404);
      expect((await pause(await make(repo, "acc-2"))).statusCode).toBe(404);
      expect((await pause(await make(repo), undefined, "not-a-uuid")).statusCode).toBe(404);
      expect((await pause(await make(repo, null))).statusCode).toBe(401);
    });
  });
});
