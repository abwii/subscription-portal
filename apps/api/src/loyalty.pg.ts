import type { Queryable } from "./db.js";
import { STREAK_GRACE_DAYS, type LoyaltyRepository } from "./loyalty.js";

export function createLoyaltyRepository(db: Queryable): LoyaltyRepository {
  return {
    async getSummary(accountId) {
      const [row] = await db.query<{
        xp: number;
        streak_current: number;
        streak_best: number;
        code: string;
        name: string;
        discount_bps: number;
        since: Date | null;
        next_code: string | null;
        next_name: string | null;
        next_min_xp: number | null;
      }>(
        `SELECT COALESCE(la.xp_total, 0) AS xp,
                COALESCE(la.streak_current, 0) AS streak_current,
                COALESCE(la.streak_best, 0) AS streak_best,
                t.code, t.name, t.discount_bps,
                la.tier_since AS since,
                nt.code AS next_code, nt.name AS next_name, nt.min_xp AS next_min_xp
         FROM (SELECT $1::uuid AS account_id) a
         LEFT JOIN loyalty_accounts la ON la.account_id = a.account_id
         JOIN loyalty_tiers t
           ON t.id = COALESCE(la.tier_id, (SELECT id FROM loyalty_tiers WHERE rank = 0))
         LEFT JOIN LATERAL (
           SELECT code, name, min_xp FROM loyalty_tiers
           WHERE min_xp > COALESCE(la.xp_total, 0) ORDER BY rank LIMIT 1
         ) nt ON true`,
        [accountId],
      );
      if (!row) throw new Error("loyalty tiers are not seeded");
      return {
        xp: row.xp,
        streak: { current: row.streak_current, best: row.streak_best },
        tier: {
          code: row.code,
          name: row.name,
          discountBps: row.discount_bps,
          since: row.since,
        },
        nextTier:
          row.next_code !== null && row.next_name !== null && row.next_min_xp !== null
            ? {
                code: row.next_code,
                name: row.next_name,
                minXp: row.next_min_xp,
                xpRemaining: row.next_min_xp - row.xp,
              }
            : null,
      };
    },

    async breakExpiredStreaks(now) {
      // Un abonnement en pause n'est jamais `past_due` : la pause gèle la série. `streak_run` change pour
      // qu'une nouvelle série regagne ses bonus. Rejouable : seules les séries > 0 sont touchées.
      const [row] = await db.query<{ broken: number }>(
        `WITH b AS (
           UPDATE loyalty_accounts la
           SET streak_current = 0, streak_run = streak_run + 1
           WHERE la.streak_current > 0
             AND EXISTS (
               SELECT 1 FROM subscriptions s
               WHERE s.account_id = la.account_id AND s.status = 'past_due'
                 AND s.current_period_end + make_interval(days => $2) <= $1::timestamptz)
           RETURNING la.account_id
         )
         SELECT count(*)::int AS broken FROM b`,
        [now, STREAK_GRACE_DAYS],
      );
      return row?.broken ?? 0;
    },
  };
}
