import type { FastifyInstance } from "fastify";
import type { Authenticate } from "./catalog.js";

export interface LoyaltySummary {
  xp: number;
  /** Périodes de facturation consécutives payées dans les délais, et meilleure série. */
  streak: { current: number; best: number };
  tier: { code: string; name: string; discountBps: number; since: Date | null };
  /** `null` au palier le plus haut. */
  nextTier: { code: string; name: string; minXp: number; xpRemaining: number } | null;
}

/** Délai de grâce d'un paiement en retard : au-delà, la série est remise à zéro (comme les droits, ADR-001). */
export const STREAK_GRACE_DAYS = 7;

export interface LoyaltyRepository {
  /** Un compte sans activité est Bronze avec 0 XP et aucune série. */
  getSummary(accountId: string): Promise<LoyaltySummary>;
  /**
   * Remet à 0 la série des comptes dont un abonnement est `past_due` depuis plus que la grâce (`streak_best`
   * est conservé). Retourne leur nombre ; rejouable. À planifier (`jobs:break-streaks`).
   */
  breakExpiredStreaks(now: Date): Promise<number>;
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
