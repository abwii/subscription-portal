import { buildApp, type AppOptions } from "./app.js";
import { createAuthenticate } from "./auth.js";
import { createCatalogRepository } from "./catalog.pg.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createInvoiceRepository } from "./invoices.pg.js";
import {
  createFakePaymentProvider,
  createFakeWebhookVerifier,
} from "./payments.js";
import {
  createStripePaymentProvider,
  createStripeWebhookVerifier,
} from "./stripe.js";
import { createSubscriptionRepository } from "./subscriptions.pg.js";

const config = loadConfig(process.env);
const db = createDatabase(config.databaseUrl);

const payment: Pick<AppOptions, "payments" | "webhookVerifier"> = (() => {
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
})();

const app = await buildApp({
  db,
  catalog: createCatalogRepository(db),
  subscriptions: createSubscriptionRepository(db),
  invoices: createInvoiceRepository(db),
  authenticate: createAuthenticate({ devAuth: config.devAuth }),
  trustProxy: config.trustProxy,
  ...payment,
});

async function shutdown(signal: string) {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await db.close();
  process.exit(0);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => void shutdown(signal));
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
