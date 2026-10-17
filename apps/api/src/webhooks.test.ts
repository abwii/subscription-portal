import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { CatalogRepository } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { InvoiceRepository } from "./invoices.js";
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
