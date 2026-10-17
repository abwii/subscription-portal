import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { GiftRepository } from "./gifts.js";
import type { InvoiceRepository } from "./invoices.js";
import type { Mailer } from "./mailer.js";
import type {
  PaymentEvent,
  PaymentEventOutcome,
  PaymentWebhookVerifier,
} from "./payments.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const NOW = new Date("2026-10-17T12:00:00Z");
const clock: Clock = { now: () => NOW };

const succeeded: PaymentEvent = {
  id: "evt_1",
  type: "payment.succeeded",
  providerRef: "pi_1",
};

/** Vérificateur factice : « valid » → l'événement, « skip » → ignoré, sinon signature invalide. */
const verifier: PaymentWebhookVerifier = {
  parse: (_raw, headers) => {
    const sig = headers["x-test-signature"];
    if (sig === "valid") return succeeded;
    if (sig === "failed")
      return { id: "evt_2", type: "payment.failed", providerRef: "pi_1" };
    if (sig === "refunded")
      return { id: "evt_3", type: "payment.refunded", providerRef: "pi_1" };
    if (sig === "skip") return "ignored";
    return null;
  },
};

describe("POST /webhooks/payments", () => {
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const make = async (
    applied: PaymentEvent[],
    outcome: PaymentEventOutcome = "applied",
    withVerifier = true,
  ) => {
    const subscriptions = {
      applyPaymentEvent: (event: PaymentEvent, now: Date) => {
        applied.push(event);
        expect(now).toEqual(NOW);
        return Promise.resolve(outcome);
      },
    } as unknown as SubscriptionRepository;
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions,
      invoices: {} as InvoiceRepository,
      ...(withVerifier ? { webhookVerifier: verifier } : {}),
      clock,
      logger: false,
    });
    apps.push(app);
    return app;
  };
  const post = (
    app: Awaited<ReturnType<typeof buildApp>>,
    signature: string | undefined,
  ) =>
    app.inject({
      method: "POST",
      url: "/webhooks/payments",
      payload: '{"any":"payload"}',
      headers: {
        "content-type": "application/json",
        ...(signature === undefined ? {} : { "x-test-signature": signature }),
      },
    });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it("applies a validly signed event and answers 200", async () => {
    const applied: PaymentEvent[] = [];
    const app = await make(applied);
    const res = await post(app, "valid");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: true });
    expect(applied).toEqual([succeeded]);
  });

  it("answers 200 without side effect for a duplicate event", async () => {
    const app = await make([], "duplicate");
    const res = await post(app, "valid");
    expect(res.statusCode).toBe(200);
  });

  it("answers 401 and writes nothing for an invalid or missing signature", async () => {
    const applied: PaymentEvent[] = [];
    const app = await make(applied);
    expect((await post(app, "bad")).statusCode).toBe(401);
    expect((await post(app, undefined)).statusCode).toBe(401);
    expect(applied).toHaveLength(0);
  });

  it("acknowledges a validly signed event of an unhandled type without applying it", async () => {
    const applied: PaymentEvent[] = [];
    const app = await make(applied);
    expect((await post(app, "skip")).statusCode).toBe(200);
    expect(applied).toHaveLength(0);
  });

  it("answers 200 for an event matching no payment, so the provider stops retrying", async () => {
    const app = await make([], "unmatched");
    expect((await post(app, "valid")).statusCode).toBe(200);
  });

  it("passes refunds to the repository", async () => {
    const applied: PaymentEvent[] = [];
    const app = await make(applied);
    await post(app, "refunded");
    expect(applied.map((e) => e.type)).toEqual(["payment.refunded"]);
  });

  it("passes failed payments to the repository", async () => {
    const applied: PaymentEvent[] = [];
    const app = await make(applied);
    await post(app, "failed");
    expect(applied.map((e) => e.type)).toEqual(["payment.failed"]);
  });

  it("answers 503 when no webhook verifier is configured", async () => {
    const app = await make([], "applied", false);
    expect((await post(app, "valid")).statusCode).toBe(503);
  });

  it("answers 500 when applying fails, so the provider retries", async () => {
    const subscriptions = {
      applyPaymentEvent: () => Promise.reject(new Error("db down")),
    } as unknown as SubscriptionRepository;
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions,
      invoices: {} as InvoiceRepository,
      webhookVerifier: verifier,
      clock,
      logger: false,
    });
    apps.push(app);
    expect((await post(app, "valid")).statusCode).toBe(500);
  });
});

describe("gift notification after a payment", () => {
  const notification = {
    giftId: "gift-1",
    code: "SECRET-GIFT-CODE",
    recipientEmail: "friend@example.test",
    planName: "Pro",
    durationPeriods: 3,
    expiresAt: new Date("2027-10-17T12:00:00Z"),
  };

  async function setup(opts: {
    outcome?: PaymentEventOutcome;
    notification?: typeof notification | null;
    sendFails?: boolean;
    withMailer?: boolean;
  }) {
    const sent: unknown[] = [];
    const marked: [string, Date][] = [];
    const lookups: string[] = [];
    const app = await buildApp({
      db: { ping: () => Promise.resolve() },
      catalog: {} as CatalogRepository,
      subscriptions: {
        applyPaymentEvent: () => Promise.resolve(opts.outcome ?? "applied"),
      } as unknown as SubscriptionRepository,
      invoices: {} as InvoiceRepository,
      gifts: {
        findNotification: (providerRef: string) => {
          lookups.push(providerRef);
          return Promise.resolve(
            opts.notification === undefined ? notification : opts.notification,
          );
        },
        markNotified: (giftId: string, at: Date) => {
          marked.push([giftId, at]);
          return Promise.resolve();
        },
      } as unknown as GiftRepository,
      ...(opts.withMailer === false
        ? {}
        : {
            mailer: {
              sendGiftEmail: (message: unknown) => {
                sent.push(message);
                return opts.sendFails ? Promise.reject(new Error("smtp down")) : Promise.resolve();
              },
            } satisfies Mailer,
          }),
      webhookVerifier: verifier,
      clock,
      logger: false,
    });
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/payments",
      payload: "{}",
      headers: { "content-type": "application/json", "x-test-signature": "valid" },
    });
    await app.close();
    return { res, sent, marked, lookups };
  }

  it("emails the recipient once the gift is paid, then marks it as notified", async () => {
    const { res, sent, marked, lookups } = await setup({});
    expect(res.statusCode).toBe(200);
    expect(lookups).toEqual(["pi_1"]);
    expect(sent).toEqual([
      {
        to: "friend@example.test",
        code: "SECRET-GIFT-CODE",
        planName: "Pro",
        durationPeriods: 3,
        expiresAt: notification.expiresAt,
      },
    ]);
    expect(marked).toEqual([["gift-1", NOW]]);
  });

  it("does nothing when the payment is not a gift, a duplicate, or unmatched", async () => {
    expect((await setup({ notification: null })).sent).toHaveLength(0);
    expect((await setup({ outcome: "duplicate" })).lookups).toHaveLength(0);
    expect((await setup({ outcome: "unmatched" })).lookups).toHaveLength(0);
  });

  it("still answers 200 and does not mark the gift when the email fails", async () => {
    const { res, marked } = await setup({ sendFails: true });
    expect(res.statusCode).toBe(200);
    expect(marked).toHaveLength(0);
  });

  it("does not look gifts up without a mailer", async () => {
    const { res, lookups } = await setup({ withMailer: false });
    expect(res.statusCode).toBe(200);
    expect(lookups).toHaveLength(0);
  });
});
