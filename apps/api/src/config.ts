export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  /** Authentification de développement par en-tête `X-Account-Id`. Jamais en production. */
  devAuth: boolean;
  /** Derrière un proxy de confiance (Fly) : l'IP cliente vient de X-Forwarded-For. */
  trustProxy: boolean;
  /** `fake` : fournisseur factice local. `none` : le checkout répond 503 (fournisseur à choisir). */
  paymentProvider: "none" | "fake" | "stripe";
  /** Requis avec `PAYMENT_PROVIDER=stripe` (secrets Fly, jamais dans le dépôt). */
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
}

const nonEmpty = (value: string | undefined) =>
  value === undefined || value === "" ? undefined : value;

export function loadConfig(env: Record<string, string | undefined>): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  const port = Number(env.PORT ?? 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const devAuth = env.DEV_AUTH === "true";
  if (devAuth && env.NODE_ENV === "production") {
    throw new Error("DEV_AUTH must not be enabled in production");
  }

  const stripeSecretKey = nonEmpty(env.STRIPE_SECRET_KEY);
  const stripeWebhookSecret = nonEmpty(env.STRIPE_WEBHOOK_SECRET);
  const paymentProvider = env.PAYMENT_PROVIDER ?? "none";
  if (
    paymentProvider !== "none" &&
    paymentProvider !== "fake" &&
    paymentProvider !== "stripe"
  ) {
    throw new Error("PAYMENT_PROVIDER must be none, fake or stripe");
  }
  if (paymentProvider === "fake" && env.NODE_ENV === "production") {
    throw new Error("PAYMENT_PROVIDER=fake must not be used in production");
  }

  if (paymentProvider === "stripe" && !(stripeSecretKey && stripeWebhookSecret)) {
    throw new Error(
      "STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are required when PAYMENT_PROVIDER=stripe",
    );
  }

  return {
    databaseUrl,
    port,
    host: env.HOST ?? "0.0.0.0",
    devAuth,
    trustProxy: env.TRUST_PROXY === "true",
    paymentProvider,
    stripeSecretKey,
    stripeWebhookSecret,
  };
}
