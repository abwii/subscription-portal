import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { Clock } from "./clock.js";
import {
  DuplicateGiftKeyError,
  generateGiftCode,
  type GiftCheckout,
  type GiftRepository,
  type GiftSummary,
} from "./gifts.js";
import type { InvoiceRepository } from "./invoices.js";
import type { PaymentProvider } from "./payments.js";
import type { PlanPriceRef, SubscriptionRepository } from "./subscriptions.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const clock: Clock = { now: () => NOW };
const PRICE_ID = "11111111-1111-4111-8111-111111111111";

const price: PlanPriceRef = {
  id: PRICE_ID,
  planId: "plan-pro",
  rank: 2,
  interval: "month",
  amountCents: 1999,
  currency: "EUR",
  active: true,
};

describe("generateGiftCode", () => {
  it("has at least 128 bits of entropy, is URL-safe and never repeats", () => {
    const codes = new Set(Array.from({ length: 200 }, () => generateGiftCode()));
    expect(codes.size).toBe(200);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Za-z0-9_-]{22,}$/); // 22 caractères base64url = 128 bits
    }
  });
});

function fakeGifts(over: Partial<GiftRepository> = {}) {
  const created: Parameters<GiftRepository["create"]>[0][] = [];
  const byKey = new Map<string, GiftCheckout>();
  const repo = {
    findByIdempotencyKey: (accountId: string, key: string) =>
      Promise.resolve(byKey.get(`${accountId}:${key}`) ?? null),
    create: (input: Parameters<GiftRepository["create"]>[0]) => {
      created.push(input);
      const record: GiftCheckout = {
        giftId: "gift-1",
        status: "awaiting_payment",
        planPriceId: input.planPriceId,
        durationPeriods: input.durationPeriods,
        invoiceId: "inv-1",
        invoiceNumber: "INV-000001",
        invoiceStatus: "open",
        totalCents: input.amountCents * input.durationPeriods,
        currency: input.currency,
      };
      byKey.set(`${input.purchaserAccountId}:${input.idempotencyKey}`, record);
      return Promise.resolve(record);
    },
    listForPurchaser: () => Promise.resolve([]),
    ...over,
  } as unknown as GiftRepository;
  return { repo, created };
}

function fakePayments() {
  const calls: { key: string; amount: number }[] = [];
  const provider: PaymentProvider = {
    createPayment: (input) => {
      calls.push({ key: input.idempotencyKey, amount: input.amountCents });
      return Promise.resolve({ providerRef: "pi_g", clientSecret: "secret_g" });
    },
  };
  return { provider, calls };
}

describe("gift routes", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (opts: {
    gifts?: GiftRepository;
    payments?: PaymentProvider | null;
    accountId?: string | null;
    findPlanPrice?: SubscriptionRepository["findPlanPrice"];
    recorded?: [string, string, number][];
  }) => {
    const recorded = opts.recorded ?? [];
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: {
        findPlanPrice: opts.findPlanPrice ?? ((id: string) => Promise.resolve(id === PRICE_ID ? price : null)),
        recordPayment: (invoiceId: string, ref: string, amount: number) => {
          recorded.push([invoiceId, ref, amount]);
          return Promise.resolve();
        },
      } as unknown as SubscriptionRepository,
      invoices: {} as InvoiceRepository,
      gifts: opts.gifts ?? fakeGifts().repo,
      giftCode: () => "CODE-FROM-TEST-0123456789",
      ...(opts.payments === null ? {} : { payments: opts.payments ?? fakePayments().provider }),
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
    body: object = { planPriceId: PRICE_ID, durationPeriods: 3 },
    key: string | null = "k1",
  ) =>
    app.inject({
      method: "POST",
      url: "/gifts",
      payload: body,
      headers: key === null ? {} : { "idempotency-key": key },
    });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  describe("POST /gifts", () => {
    it("creates a gift awaiting payment with an open invoice, and never reveals the code before payment", async () => {
      const { repo, created } = fakeGifts();
      const { provider, calls } = fakePayments();
      const recorded: [string, string, number][] = [];
      const res = await post(
        await make({ gifts: repo, payments: provider, recorded }),
        { planPriceId: PRICE_ID, durationPeriods: 3, recipientEmail: "friend@example.test" },
      );
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        gift: { id: "gift-1", status: "awaiting_payment", planPriceId: PRICE_ID, durationPeriods: 3 },
        invoice: { id: "inv-1", number: "INV-000001", status: "open", totalCents: 5997, currency: "EUR" },
        payment: { providerRef: "pi_g", clientSecret: "secret_g" },
      });
      expect(res.body).not.toContain("CODE-FROM-TEST");
      expect(created[0]).toEqual({
        purchaserAccountId: "acc-1",
        planPriceId: PRICE_ID,
        durationPeriods: 3,
        recipientEmail: "friend@example.test",
        idempotencyKey: "k1",
        code: "CODE-FROM-TEST-0123456789",
        amountCents: 1999,
        currency: "EUR",
        now: NOW,
      });
      // clé fournisseur distincte de celle du checkout
      expect(calls).toEqual([{ key: "gift:k1", amount: 5997 }]);
      expect(recorded).toEqual([["inv-1", "pi_g", 5997]]);
    });

    it("accepts a gift without recipient email", async () => {
      const { repo, created } = fakeGifts();
      const res = await post(await make({ gifts: repo }));
      expect(res.statusCode).toBe(201);
      expect(created[0]?.recipientEmail).toBeNull();
    });

    it("returns 400 for a missing key, an invalid duration or a bad email", async () => {
      const app = await make({});
      expect((await post(app, undefined, null)).statusCode).toBe(400);
      expect((await post(app, { planPriceId: PRICE_ID, durationPeriods: 0 })).statusCode).toBe(400);
      expect((await post(app, { planPriceId: PRICE_ID, durationPeriods: 13 })).statusCode).toBe(400);
      expect((await post(app, { planPriceId: PRICE_ID, durationPeriods: 1.5 })).statusCode).toBe(400);
      expect(
        (await post(app, { planPriceId: PRICE_ID, durationPeriods: 1, recipientEmail: "nope" })).statusCode,
      ).toBe(400);
    });

    it("returns 422 for an unknown or inactive price", async () => {
      const inactive = await make({
        findPlanPrice: () => Promise.resolve({ ...price, active: false }),
      });
      expect((await post(inactive)).statusCode).toBe(422);
      const unknown = await make({});
      expect(
        (await post(unknown, { planPriceId: "22222222-2222-4222-8222-222222222222", durationPeriods: 1 }))
          .statusCode,
      ).toBe(422);
    });

    it("returns 401 without an authenticated account and 503 without a provider", async () => {
      expect((await post(await make({ accountId: null }))).statusCode).toBe(401);
      expect((await post(await make({ payments: null }))).statusCode).toBe(503);
    });

    it("creates a single gift when the same key is replayed", async () => {
      const { repo, created } = fakeGifts();
      const { provider, calls } = fakePayments();
      const app = await make({ gifts: repo, payments: provider });
      const first = await post(app);
      const second = await post(app);
      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual(first.json());
      expect(created).toHaveLength(1);
      expect(calls.map((c) => c.key)).toEqual(["gift:k1", "gift:k1"]);
    });

    it("returns 409 when a key is reused for another gift", async () => {
      const { repo } = fakeGifts();
      const app = await make({ gifts: repo });
      await post(app);
      const res = await post(app, { planPriceId: PRICE_ID, durationPeriods: 6 });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ error: "idempotency_key_reused" });
    });

    it("replays the stored result when a concurrent request wins the key race", async () => {
      const winner: GiftCheckout = {
        giftId: "gift-w",
        status: "awaiting_payment",
        planPriceId: PRICE_ID,
        durationPeriods: 3,
        invoiceId: "inv-w",
        invoiceNumber: "INV-000009",
        invoiceStatus: "open",
        totalCents: 5997,
        currency: "EUR",
      };
      let lookups = 0;
      const { repo } = fakeGifts({
        findByIdempotencyKey: () => Promise.resolve(++lookups === 1 ? null : winner),
        create: () => Promise.reject(new DuplicateGiftKeyError()),
      });
      const res = await post(await make({ gifts: repo }));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ gift: { id: "gift-w" } });
    });

    it("returns 502 without leaking the cause when the provider fails", async () => {
      const res = await post(
        await make({ payments: { createPayment: () => Promise.reject(new Error("boom")) } }),
      );
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain("boom");
    });
  });

  describe("GET /gifts", () => {
    const summary = (over: Partial<GiftSummary> = {}): GiftSummary => ({
      id: "gift-1",
      status: "pending",
      planPriceId: PRICE_ID,
      durationPeriods: 3,
      recipientEmail: "friend@example.test",
      expiresAt: new Date("2027-10-17T12:00:00Z"),
      redeemedAt: null,
      code: "SECRET-CODE",
      ...over,
    });

    it("lists the purchaser's gifts, showing the code only while it can still be used", async () => {
      const asked: string[] = [];
      const { repo } = fakeGifts({
        listForPurchaser: (accountId: string) => {
          asked.push(accountId);
          return Promise.resolve([
            summary(),
            summary({ id: "g2", status: "awaiting_payment" }),
            summary({ id: "g3", status: "refunded" }),
            summary({ id: "g4", status: "redeemed" }),
            summary({ id: "g5", status: "expired" }),
          ]);
        },
      });
      const res = await (await make({ gifts: repo })).inject({ method: "GET", url: "/gifts" });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ gifts: { id: string; code?: string | null }[] }>();
      expect(asked).toEqual(["acc-1"]);
      expect(body.gifts.map((g) => [g.id, g.code ?? null])).toEqual([
        ["gift-1", "SECRET-CODE"],
        ["g2", null],
        ["g3", null],
        ["g4", null],
        ["g5", null],
      ]);
    });

    it("returns 401 without an authenticated account", async () => {
      const res = await (await make({ accountId: null })).inject({ method: "GET", url: "/gifts" });
      expect(res.statusCode).toBe(401);
    });
  });
});
