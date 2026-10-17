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

/** Port vers le fournisseur de paiement (choix du fournisseur : voir ADR-001, question 1). */
export interface PaymentProvider {
  createPayment(input: CreatePaymentInput): Promise<PaymentDetails>;
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
