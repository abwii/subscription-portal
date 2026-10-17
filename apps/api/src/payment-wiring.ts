import type { Config } from "./config.js";
import {
  createFakePaymentProvider,
  createFakeWebhookVerifier,
  type PaymentProvider,
  type PaymentWebhookVerifier,
} from "./payments.js";
import {
  createStripePaymentProvider,
  createStripeWebhookVerifier,
} from "./stripe.js";

export interface PaymentWiring {
  payments?: PaymentProvider;
  webhookVerifier?: PaymentWebhookVerifier;
}

/** Choisit le fournisseur de paiement selon la configuration (`PAYMENT_PROVIDER`). */
export function createPaymentWiring(config: Config): PaymentWiring {
  switch (config.paymentProvider) {
    case "stripe":
      return {
        // loadConfig garantit la présence des deux secrets avec PAYMENT_PROVIDER=stripe.
        payments: createStripePaymentProvider({
          secretKey: config.stripeSecretKey ?? "",
        }),
        webhookVerifier: createStripeWebhookVerifier({
          secret: config.stripeWebhookSecret ?? "",
        }),
      };
    case "fake":
      return {
        payments: createFakePaymentProvider(),
        webhookVerifier: createFakeWebhookVerifier(),
      };
    case "none":
      return {};
  }
}
