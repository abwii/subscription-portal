import type { FastifyInstance } from "fastify";
import type { Authenticate } from "./catalog.js";

export interface LoyaltySummary {
  xp: number;
  tier: { code: string; name: string; discountBps: number; since: Date | null };
  /** `null` au palier le plus haut. */
  nextTier: { code: string; name: string; minXp: number; xpRemaining: number } | null;
}

export interface LoyaltyRepository {
  /** Un compte sans activité est Bronze avec 0 XP. */
  getSummary(accountId: string): Promise<LoyaltySummary>;
}

export function registerLoyaltyRoutes(
  app: FastifyInstance,
  { loyalty, authenticate }: { loyalty: LoyaltyRepository; authenticate: Authenticate },
): void {
  app.get("/me/loyalty", async (req, reply) => {
    const accountId = await authenticate(req);
    if (accountId === null) return reply.code(401).send({ error: "unauthorized" });
    return { loyalty: await loyalty.getSummary(accountId) };
  });
}
