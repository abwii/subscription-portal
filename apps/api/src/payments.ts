import { createHash } from "node:crypto";

export interface CreatePaymentInput {
  accountId: string;
  invoiceId: string;
  amountCents: number;
  currency: string;
  /** Le fournisseur doit être idempotent sur cette clé : le même appel rend le même paiement. */
  idempotencyKey: string;
}

export interface PaymentDetails {
  /** Référence côté fournisseur ; clé de rapprochement des webhooks. */
  providerRef: string;
  /** Ce dont le client a besoin pour finaliser le paiement côté navigateur. */
  clientSecret: string;
}

/** Port vers le fournisseur de paiement (Stripe : `stripe.ts`). */
export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<PaymentDetails>;
}

/** Événement de paiement, indépendant du fournisseur. */
export interface PaymentEvent {
  /** Identifiant unique de l'événement chez le fournisseur : clé d'idempotence du webhook. */
  id: string;
  type: "payment.succeeded" | "payment.failed" | "payment.refunded";
  providerRef: string;
}

/**
 * - `applied` : l'événement a eu un effet ;
 * - `duplicate` : déjà reçu, aucun effet ;
 * - `unmatched` : enregistré mais sans effet (paiement inconnu, déjà traité, abonnement expiré…).
 */
export type PaymentEventOutcome = "applied" | "duplicate" | "unmatched";

/** Authentifie et interprète le corps brut d'un webhook. */
export interface PaymentWebhookVerifier {
  /**
   * `null` : signature absente, invalide ou corps inexploitable.
   * `"ignored"` : événement authentique d'un type qu'on ne traite pas.
   */
  parse(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
    now: Date,
  ): PaymentEvent | "ignored" | null;
}

/** Fournisseur factice pour le développement local : déterministe, aucun appel réseau. */
export function createFakePaymentProvider(): PaymentProvider {
  return {
    createPayment({ accountId, idempotencyKey }) {
      const id = createHash("sha256")
        .update(`${accountId}:${idempotencyKey}`)
        .digest("hex")
        .slice(0, 24);
      return Promise.resolve({
        providerRef: `fake_pi_${id}`,
        clientSecret: `fake_secret_${id}`,
      });
    },
  };
}

/**
 * Webhook factice : en-tête `x-fake-signature: fake`, corps `{ id, type, providerRef }`.
 * Local uniquement.
 */
export function createFakeWebhookVerifier(): PaymentWebhookVerifier {
  return {
    parse(rawBody, headers) {
      if (headers["x-fake-signature"] !== "fake") return null;
      try {
        const body = JSON.parse(rawBody) as Partial<PaymentEvent>;
        const { id, type, providerRef } = body;
        if (
          typeof id === "string" &&
          typeof providerRef === "string" &&
          (type === "payment.succeeded" || type === "payment.failed" || type === "payment.refunded")
        ) {
          return { id, type, providerRef };
        }
      } catch {
        // corps non JSON
      }
      return null;
    },
  };
}
