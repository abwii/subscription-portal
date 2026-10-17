import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createPaymentWiring } from "./payment-wiring.js";
import { renewDueSubscriptions } from "./renewals.js";
import { expirePendingSubscriptions } from "./subscriptions.js";
import { createSubscriptionRepository } from "./subscriptions.pg.js";

// Jobs périodiques, à planifier hors de l'API (cron, machine planifiée Fly…) :
//   expire-pending : ferme les checkouts et changements non payés après 24 h
//   renew          : facture les renouvellements échus
// Les deux sont rejouables sans risque (idempotents).
const command = process.argv[2];
const config = loadConfig(process.env);
const db = createDatabase(config.databaseUrl);
const repo = createSubscriptionRepository(db);

try {
  if (command === "expire-pending") {
    const expired = await expirePendingSubscriptions(repo, systemClock);
    console.log(`expired: ${String(expired)}`);
  } else if (command === "renew") {
    const { payments } = createPaymentWiring(config);
    if (!payments) {
      console.error("renew requires PAYMENT_PROVIDER (fake or stripe)");
      process.exitCode = 1;
    } else {
      const result = await renewDueSubscriptions({ repo, payments, clock: systemClock });
      console.log(`renewed: ${String(result.renewed)}, failed: ${String(result.failed)}`);
      if (result.failed > 0) process.exitCode = 1;
    }
  } else {
    console.error("usage: jobs-cli <expire-pending|renew>");
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
