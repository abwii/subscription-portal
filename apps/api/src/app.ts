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
  logger?: boolean;
}

export async function buildApp({
  db,
  catalog,
  clock = systemClock,
  authenticate = () => Promise.resolve(null),
  logger = true,
}: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger });

  // Liveness : le process répond. Ne dépend volontairement pas de la DB,
  // sinon une panne Postgres ferait redémarrer l'API en boucle.
  app.get("/health", () => ({ status: "ok" }));

  // Readiness : prêt à servir du trafic (DB joignable).
  app.get("/ready", async (_req, reply) => {
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
