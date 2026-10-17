import type { CatalogRepository, PlanView } from "./catalog.js";
import type { Queryable } from "./db.js";

interface SubscriptionRow {
  status: "pending" | "active" | "past_due" | "paused" | "canceled" | "expired";
  plan_id: string;
  current_period_end: Date;
  cancel_at_period_end: boolean;
}

export function createCatalogRepository(db: Queryable): CatalogRepository {
  return {
    listPlans: () =>
      db.query<PlanView>(
        `SELECT p.id, p.code, p.name, p.rank,
           (SELECT json_agg(json_build_object(
              'id', pp.id, 'interval', pp."interval",
              'amountCents', pp.amount_cents, 'currency', pp.currency)
              ORDER BY pp."interval", pp.amount_cents)
            FROM plan_prices pp WHERE pp.plan_id = p.id AND pp.active) AS prices,
           COALESCE((
             SELECT json_agg(json_build_object(
               'code', e.code, 'kind', e.kind, 'limit', pe.limit_value) ORDER BY e.code)
             FROM plan_entitlements pe JOIN entitlements e ON e.id = pe.entitlement_id
             WHERE pe.plan_id = p.id
           ), '[]'::json) AS entitlements
         FROM plans p
         WHERE p.active
           AND EXISTS (SELECT 1 FROM plan_prices pp WHERE pp.plan_id = p.id AND pp.active)
         ORDER BY p.rank, p.code`,
      ),

    async findSubscription(accountId) {
      const [row] = await db.query<SubscriptionRow>(
        `SELECT s.status, pp.plan_id, s.current_period_end, s.cancel_at_period_end
         FROM subscriptions s JOIN plan_prices pp ON pp.id = s.plan_price_id
         WHERE s.account_id = $1
           AND s.status IN ('pending', 'active', 'past_due', 'paused')`,
        [accountId],
      );
      return row
        ? {
            status: row.status,
            planId: row.plan_id,
            currentPeriodEnd: row.current_period_end,
            cancelAtPeriodEnd: row.cancel_at_period_end,
          }
        : null;
    },

    listPlanEntitlements: (planId) =>
      db.query(
        `SELECT e.code, e.kind, pe.limit_value AS "limit"
         FROM plan_entitlements pe JOIN entitlements e ON e.id = pe.entitlement_id
         WHERE pe.plan_id = $1
         ORDER BY e.code`,
        [planId],
      ),
  };
}
