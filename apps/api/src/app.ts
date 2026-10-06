import Fastify, { type FastifyInstance } from "fastify";

/** Port minimal vers la base : l'app ne connaît pas `pg`, ce qui la rend testable. */
export interface Database {
  ping(): Promise<void>;
}

export interface AppOptions {
  db: Database;
  logger?: boolean;
}

export async function buildApp({
  db,
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

  return app;
}
