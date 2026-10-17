import type { FastifyInstance } from "fastify";
import type { Authenticate } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ADR-001 : une pause dure au plus 90 jours, une seule par période de 12 mois. */
export const MAX_PAUSE_DAYS = 90;
export const PAUSE_QUOTA_WINDOW_DAYS = 365;

interface LifecycleRoutesOptions {
  subscriptions: SubscriptionRepository;
  clock: Clock;
  authenticate: Authenticate;
}

export function registerLifecycleRoutes(
  app: FastifyInstance,
  { subscriptions, clock, authenticate }: LifecycleRoutesOptions,
): void {
  // Facturation et droits suspendus ; à la reprise une nouvelle période démarre (pas de prorata).
  app.post<{ Params: { id: string }; Body: { resumeAt: string } }>(
    "/subscriptions/:id/pause",
    {
      schema: {
        body: {
          type: "object",
          required: ["resumeAt"],
          additionalProperties: false,
          properties: { resumeAt: { type: "string", format: "date-time" } },
        },
      },
    },
    async (req, reply) => {
      const accountId = await authenticate(req);
      if (accountId === null) return reply.code(401).send({ error: "unauthorized" });
      // 404 (et non 403) pour l'abonnement d'un autre compte : son existence reste cachée.
      if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });

      const sub = await subscriptions.findSubscriptionForChange(accountId, req.params.id);
      if (!sub) return reply.code(404).send({ error: "not_found" });
      if (sub.status !== "active") {
        return reply.code(409).send({ error: "subscription_not_active" });
      }

      const now = clock.now();
      const resumeAt = new Date(req.body.resumeAt);
      if (resumeAt.getTime() <= now.getTime()) {
        return reply.code(422).send({ error: "resume_in_past" });
      }
      if (resumeAt.getTime() > now.getTime() + MAX_PAUSE_DAYS * DAY_MS) {
        return reply.code(422).send({ error: "pause_too_long" });
      }

      const since = new Date(now.getTime() - PAUSE_QUOTA_WINDOW_DAYS * DAY_MS);
      if ((await subscriptions.countPausesSince(sub.id, since)) > 0) {
        return reply.code(409).send({ error: "pause_limit_reached" });
      }

      const paused = await subscriptions.pause({
        subscriptionId: sub.id,
        now,
        resumeAt,
      });
      // Refusé par la base : état modifié entre-temps, ou facture de renouvellement / changement impayée.
      if (!paused) return reply.code(409).send({ error: "pause_unavailable" });

      return {
        subscription: {
          id: sub.id,
          status: "paused",
          pausedAt: now,
          resumeAt,
        },
      };
    },
  );
}
