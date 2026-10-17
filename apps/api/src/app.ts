import type { Writable } from "node:stream";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import {
  registerCatalogRoutes,
  type Authenticate,
  type CatalogRepository,
} from "./catalog.js";
import { systemClock, type Clock } from "./clock.js";
import { registerInvoiceRoutes, type InvoiceRepository } from "./invoices.js";
import { generateGiftCode, registerGiftRoutes, type GiftRepository } from "./gifts.js";
import { registerInvoicePaymentRoutes } from "./invoice-payments.js";
import { registerLoyaltyRoutes, type LoyaltyRepository } from "./loyalty.js";
import type { Mailer } from "./mailer.js";
import { registerLifecycleRoutes } from "./lifecycle.js";
import { registerResumeRoutes } from "./resume.js";
import { registerPlanChangeRoutes } from "./plan-changes.js";
import { registerWebhookRoutes } from "./webhooks.js";
import type { PaymentProvider, PaymentWebhookVerifier } from "./payments.js";
import {
  registerSubscriptionRoutes,
  type SubscriptionRepository,
} from "./subscriptions.js";

/** Port minimal vers la base : l'app ne connaît pas `pg`, ce qui la rend testable. */
export interface Database {
  ping(): Promise<void>;
}

export interface AppOptions {
  db: Database;
  catalog: CatalogRepository;
  subscriptions: SubscriptionRepository;
  invoices: InvoiceRepository;
  /** Absent : le checkout répond 503. */
  payments?: PaymentProvider;
  /** Absent : le webhook de paiement répond 503. */
  webhookVerifier?: PaymentWebhookVerifier;
  /** Absent : les routes de cadeaux ne sont pas montées. */
  gifts?: GiftRepository;
  /** Absent : `GET /me/loyalty` n'est pas monté. */
  loyalty?: LoyaltyRepository;
  /** Absent : aucun e-mail n'est envoyé (l'offrant retrouve le code via `GET /gifts`). */
  mailer?: Mailer;
  /** Flux de journalisation (injectable pour les tests) ; remplace `logger`. */
  logStream?: Writable;
  /** Générateur de codes cadeau (injectable pour les tests). */
  giftCode?: () => string;
  clock?: Clock;
  /** Retourne l'id du compte authentifié, ou `null`. Refus par défaut. */
  authenticate?: Authenticate;
  /** Limite par IP (défaut : 100 requêtes / minute). Les sondes /health et /ready en sont exclues. */
  rateLimit?: { max: number; timeWindowMs: number };
  /** À activer derrière un proxy de confiance (Fly) pour limiter par IP cliente et non par IP du proxy. */
  trustProxy?: boolean;
  logger?: boolean;
}

export async function buildApp({
  db,
  catalog,
  subscriptions,
  invoices,
  payments,
  webhookVerifier,
  gifts,
  loyalty,
  mailer,
  giftCode = generateGiftCode,
  clock = systemClock,
  authenticate = () => Promise.resolve(null),
  rateLimit: limits = { max: 100, timeWindowMs: 60_000 },
  trustProxy = false,
  logStream,
  logger = true,
}: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: logStream ? { stream: logStream } : logger, trustProxy });
  await app.register(rateLimit, {
    max: limits.max,
    timeWindow: limits.timeWindowMs,
  });

  // Liveness : le process répond. Ne dépend volontairement pas de la DB,
  // sinon une panne Postgres ferait redémarrer l'API en boucle.
  app.get("/health", { config: { rateLimit: false } }, () => ({ status: "ok" }));

  // Readiness : prêt à servir du trafic (DB joignable).
  app.get("/ready", { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await db.ping();
      return { status: "ready" };
    } catch (err) {
      app.log.error({ err }, "readiness check failed");
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  registerCatalogRoutes(app, { catalog, clock, authenticate });
  registerSubscriptionRoutes(app, { subscriptions, payments, clock, authenticate });
  registerPlanChangeRoutes(app, { subscriptions, payments, clock, authenticate });
  registerLifecycleRoutes(app, { subscriptions, clock, authenticate });
  registerResumeRoutes(app, { subscriptions, payments, clock, authenticate });
  registerInvoicePaymentRoutes(app, { invoices, subscriptions, payments, authenticate });
  registerInvoiceRoutes(app, { invoices, authenticate });
  registerWebhookRoutes(app, { subscriptions, verifier: webhookVerifier, clock, gifts, mailer });
  if (loyalty) registerLoyaltyRoutes(app, { loyalty, authenticate });
  if (gifts) {
    registerGiftRoutes(app, {
      gifts,
      subscriptions,
      payments,
      clock,
      authenticate,
      newCode: giftCode,
    });
  }

  return app;
}
