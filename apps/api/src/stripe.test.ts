import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createStripePaymentProvider,
  createStripeWebhookVerifier,
} from "./stripe.js";

const SECRET = "whsec_test_secret";
const NOW = new Date("2026-10-17T12:00:00Z");
const ts = Math.floor(NOW.getTime() / 1000);

const sign = (payload: string, timestamp = ts, secret = SECRET) =>
  `t=${String(timestamp)},v1=${createHmac("sha256", secret)
    .update(`${String(timestamp)}.${payload}`)
    .digest("hex")}`;

const event = (type: string, id = "evt_1", object = "pi_1") =>
  JSON.stringify({ id, type, data: { object: { id: object } } });

describe("Stripe webhook verifier", () => {
  const verifier = createStripeWebhookVerifier({ secret: SECRET });
  const parse = (body: string, signature: string | undefined, at = NOW) =>
    verifier.parse(
      body,
      signature === undefined ? {} : { "stripe-signature": signature },
      at,
    );

  it("accepts a valid signature and maps payment_intent.succeeded", () => {
    const body = event("payment_intent.succeeded");
    expect(parse(body, sign(body))).toEqual({
      id: "evt_1",
      type: "payment.succeeded",
      providerRef: "pi_1",
    });
  });

  it("maps payment_intent.payment_failed", () => {
    const body = event("payment_intent.payment_failed", "evt_2", "pi_2");
    expect(parse(body, sign(body))).toEqual({
      id: "evt_2",
      type: "payment.failed",
      providerRef: "pi_2",
    });
  });

  it("returns 'ignored' for a validly signed event of another type", () => {
    const body = event("customer.created");
    expect(parse(body, sign(body))).toBe("ignored");
  });

  it("rejects a missing, malformed or wrong signature", () => {
    const body = event("payment_intent.succeeded");
    expect(parse(body, undefined)).toBeNull();
    expect(parse(body, "garbage")).toBeNull();
    expect(parse(body, sign(body, ts, "whsec_other"))).toBeNull();
  });

  it("rejects a tampered payload", () => {
    const body = event("payment_intent.succeeded");
    expect(parse(body.replace("pi_1", "pi_2"), sign(body))).toBeNull();
  });

  it("rejects a timestamp outside the 5-minute tolerance", () => {
    const body = event("payment_intent.succeeded");
    expect(parse(body, sign(body, ts - 301))).toBeNull();
    expect(parse(body, sign(body, ts + 301))).toBeNull();
    expect(parse(body, sign(body, ts - 299))).not.toBeNull();
  });

  it("accepts any of several v1 signatures (secret rotation)", () => {
    const body = event("payment_intent.succeeded");
    const good = sign(body).split(",v1=")[1] ?? "";
    expect(parse(body, `t=${String(ts)},v1=${"0".repeat(64)},v1=${good}`)).not.toBeNull();
  });

  it("rejects a validly signed payload that is not a usable event", () => {
    const body = "not json";
    expect(parse(body, sign(body))).toBeNull();
    const noId = JSON.stringify({ type: "payment_intent.succeeded" });
    expect(parse(noId, sign(noId))).toBeNull();
  });
});

describe("Stripe payment provider", () => {
  const input = {
    accountId: "acc-1",
    invoiceId: "inv-1",
    amountCents: 1999,
    currency: "EUR",
    idempotencyKey: "key-1",
  };

  it("creates a PaymentIntent idempotently and returns its reference and client secret", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const provider = createStripePaymentProvider({
      secretKey: "sk_test_x",
      fetchFn: (url, init) => {
        calls.push({
          url: url instanceof Request ? url.url : url.toString(),
          init: init ?? {},
        });
        return Promise.resolve(
          new Response(JSON.stringify({ id: "pi_9", client_secret: "pi_9_secret" }), {
            status: 200,
          }),
        );
      },
    });
    expect(await provider.createPayment(input)).toEqual({
      providerRef: "pi_9",
      clientSecret: "pi_9_secret",
    });
    const call = calls[0];
    expect(call?.url).toBe("https://api.stripe.com/v1/payment_intents");
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_test_x");
    expect(headers["Idempotency-Key"]).toBe("acc-1:key-1");
    const body = new URLSearchParams((call?.init.body as URLSearchParams).toString());
    expect(body.get("amount")).toBe("1999");
    expect(body.get("currency")).toBe("eur");
    expect(body.get("metadata[invoice_id]")).toBe("inv-1");
    expect(body.get("automatic_payment_methods[enabled]")).toBe("true");
  });

  it("fails without leaking the response body when Stripe answers an error", async () => {
    const provider = createStripePaymentProvider({
      secretKey: "sk_test_x",
      fetchFn: () =>
        Promise.resolve(new Response('{"error":{"message":"card secret"}}', { status: 402 })),
    });
    const err = await provider.createPayment(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("402");
    expect((err as Error).message).not.toContain("card secret");
  });
});
