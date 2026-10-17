import { systemClock } from "./clock.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";
import { createGiftRepository } from "./gifts.pg.js";
import { createLoyaltyRepository } from "./loyalty.pg.js";
import { createPaymentWiring } from "./payment-wiring.js";
import { renewDueSubscriptions } from "./renewals.js";
import { resumeDueSubscriptions } from "./resume.js";
import { expirePendingSubscriptions } from "./subscriptions.js";
import { createSubscriptionRepository } from "./subscriptions.pg.js";

// Jobs périodiques, à planifier hors de l'API (cron, machine planifiée Fly…) :
//   expire-pending : ferme les checkouts, changements et cadeaux non payés après 24 h, et expire les cadeaux périmés
//   renew          : facture les renouvellements échus
//   resume         : reprend les abonnements dont la date de reprise est passée
//   close-ended    : clôt les abonnements dont l'annulation programmée est arrivée à terme
//   break-streaks  : remet à 0 les séries de fidélité des abonnements en retard au-delà de la grâce
// Tous sont rejouables sans risque (idempotents).
const command = process.argv[2];
const config = loadConfig(process.env);
const db = createDatabase(config.databaseUrl);
const repo = createSubscriptionRepository(db);

try {
  if (command === "expire-pending") {
    const expired = await expirePendingSubscriptions(repo, systemClock);
    const expiredGifts = await createGiftRepository(db).expireStale(systemClock.now());
    console.log(`expired: ${String(expired)}, gifts past validity: ${String(expiredGifts)}`);
  } else if (command === "break-streaks") {
    const broken = await createLoyaltyRepository(db).breakExpiredStreaks(systemClock.now());
    console.log(`streaks reset: ${String(broken)}`);
  } else if (command === "close-ended") {
    const closed = await repo.closeEnded(systemClock.now());
    console.log(`closed: ${String(closed)}`);
  } else if (command === "renew" || command === "resume") {
    const { payments } = createPaymentWiring(config);
    if (!payments) {
      console.error(`${command} requires PAYMENT_PROVIDER (fake or stripe)`);
      process.exitCode = 1;
    } else if (command === "renew") {
      const result = await renewDueSubscriptions({ repo, payments, clock: systemClock });
      console.log(`renewed: ${String(result.renewed)}, failed: ${String(result.failed)}`);
      if (result.failed > 0) process.exitCode = 1;
    } else {
      const result = await resumeDueSubscriptions({ repo, payments, clock: systemClock });
      console.log(`resumed: ${String(result.resumed)}, failed: ${String(result.failed)}`);
      if (result.failed > 0) process.exitCode = 1;
    }
  } else {
    console.error("usage: jobs-cli <expire-pending|renew|resume|close-ended|break-streaks>");
    process.exitCode = 1;
  }
} finally {
  await db.close();
}
