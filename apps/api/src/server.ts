import { buildApp } from "./app.js";
import { createAuthenticate } from "./auth.js";
import { createCatalogRepository } from "./catalog.pg.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createGiftRepository } from "./gifts.pg.js";
import { createInvoiceRepository } from "./invoices.pg.js";
import { createLoyaltyRepository } from "./loyalty.pg.js";
import { createConsoleMailer } from "./mailer.js";
import { createPaymentWiring } from "./payment-wiring.js";
import { createSubscriptionRepository } from "./subscriptions.pg.js";

const config = loadConfig(process.env);
const db = createDatabase(config.databaseUrl);

const app = await buildApp({
  db,
  catalog: createCatalogRepository(db),
  subscriptions: createSubscriptionRepository(db),
  invoices: createInvoiceRepository(db),
  gifts: createGiftRepository(db),
  loyalty: createLoyaltyRepository(db),
  ...(config.mailer === "console" ? { mailer: createConsoleMailer() } : {}),
  authenticate: createAuthenticate({ devAuth: config.devAuth }),
  trustProxy: config.trustProxy,
  ...createPaymentWiring(config),
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
