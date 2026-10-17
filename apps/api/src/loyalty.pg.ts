import type { Queryable } from "./db.js";
import type { LoyaltyRepository } from "./loyalty.js";

export function createLoyaltyRepository(db: Queryable): LoyaltyRepository {
  return {
    async getSummary(accountId) {
      const [row] = await db.query<{
        xp: number;
        code: string;
        name: string;
        discount_bps: number;
        since: Date | null;
        next_code: string | null;
        next_name: string | null;
        next_min_xp: number | null;
      }>(
        `SELECT COALESCE(la.xp_total, 0) AS xp, t.code, t.name, t.discount_bps,
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
  };
}
