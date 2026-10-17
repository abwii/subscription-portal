import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PaymentEvent,
  PaymentProvider,
  PaymentWebhookVerifier,
} from "./payments.js";

const STRIPE_API = "https://api.stripe.com/v1";
const DEFAULT_TOLERANCE_SECONDS = 300;

interface StripeProviderOptions {
  secretKey: string;
  /** Injectable pour les tests. */
  fetchFn?: typeof fetch;
}

/** PaymentIntent Stripe, sans SDK : un seul appel, idempotent grâce à l'en-tête `Idempotency-Key`. */
export function createStripePaymentProvider({
  secretKey,
  fetchFn = fetch,
}: StripeProviderOptions): PaymentProvider {
  return {
    async createPayment({
      accountId,
      invoiceId,
      amountCents,
      currency,
      idempotencyKey,
    }) {
      const body = new URLSearchParams({
        amount: String(amountCents),
        currency: currency.toLowerCase(),
        "automatic_payment_methods[enabled]": "true",
        "metadata[invoice_id]": invoiceId,
        "metadata[account_id]": accountId,
      });
      const res = await fetchFn(`${STRIPE_API}/payment_intents`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          // La clé du client n'est unique que par compte.
          "Idempotency-Key": `${accountId}:${idempotencyKey}`,
        },
        body,
      });
      if (!res.ok) {
        // Le corps de l'erreur n'est volontairement pas relayé (il peut contenir des détails de paiement).
        throw new Error(`Stripe PaymentIntent creation failed: HTTP ${String(res.status)}`);
      }
      const intent = (await res.json()) as {
        id?: unknown;
        client_secret?: unknown;
      };
      if (typeof intent.id !== "string" || typeof intent.client_secret !== "string") {
        throw new Error("Stripe PaymentIntent response is missing id or client_secret");
      }
      return { providerRef: intent.id, clientSecret: intent.client_secret };
    },
  };
}

const EVENT_TYPES: Record<string, PaymentEvent["type"]> = {
  "payment_intent.succeeded": "payment.succeeded",
  "payment_intent.payment_failed": "payment.failed",
};

interface StripeVerifierOptions {
  secret: string;
  toleranceSeconds?: number;
}

/**
 * Vérifie l'en-tête `Stripe-Signature` : `t=<unix>,v1=<hmac-sha256 hex de "<t>.<corps brut>">`.
 * Plusieurs `v1` sont acceptés (rotation du secret). Le corps doit être le texte brut reçu.
 */
export function createStripeWebhookVerifier({
  secret,
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}: StripeVerifierOptions): PaymentWebhookVerifier {
  return {
    parse(rawBody, headers, now) {
      const header = headers["stripe-signature"];
      if (typeof header !== "string") return null;

      let timestamp: string | undefined;
      const signatures: string[] = [];
      for (const part of header.split(",")) {
        const [key, value] = part.split("=", 2);
        if (key === "t" && value) timestamp = value;
        if (key === "v1" && value) signatures.push(value);
      }
      if (!timestamp || signatures.length === 0) return null;

      const t = Number(timestamp);
      if (!Number.isInteger(t)) return null;
      if (Math.abs(now.getTime() / 1000 - t) > toleranceSeconds) return null;

      const expected = createHmac("sha256", secret)
        .update(`${timestamp}.${rawBody}`)
        .digest();
      const valid = signatures.some((sig) => {
        const candidate = Buffer.from(sig, "hex");
        return (
          candidate.length === expected.length &&
          timingSafeEqual(candidate, expected)
        );
      });
      if (!valid) return null;

      let event: { id?: unknown; type?: unknown; data?: { object?: { id?: unknown } } };
      try {
        event = JSON.parse(rawBody) as typeof event;
      } catch {
        return null;
      }
      if (typeof event.id !== "string" || typeof event.type !== "string") return null;

      const type = EVENT_TYPES[event.type];
      if (!type) return "ignored";
      const providerRef = event.data?.object?.id;
      if (typeof providerRef !== "string") return null;
      return { id: event.id, type, providerRef };
    },
  };
}
