import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import {
  registerCatalogRoutes,
  type Authenticate,
  type CatalogRepository,
} from "./catalog.js";
import { systemClock, type Clock } from "./clock.js";

/** Port minimal vers la base : l'app ne connaît pas `pg`, ce qui la rend testable. */
export interface Database {
  ping(): Promise<void>;
}

export interface AppOptions {
  db: Database;
  catalog: CatalogRepository;
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
  clock = systemClock,
  authenticate = () => Promise.resolve(null),
  rateLimit: limits = { max: 100, timeWindowMs: 60_000 },
  trustProxy = false,
  logger = true,
}: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger, trustProxy });
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

  return app;
}
