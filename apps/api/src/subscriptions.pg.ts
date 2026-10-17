import type { Queryable } from "./db.js";
import {
  DuplicateIdempotencyKeyError,
  LiveSubscriptionExistsError,
  type CheckoutRecord,
  type PlanPriceRef,
  type SubscriptionRepository,
} from "./subscriptions.js";

const UNIQUE_VIOLATION = "23505";

interface CheckoutRow {
  subscription_id: string;
  status: CheckoutRecord["status"];
  plan_price_id: string;
  invoice_id: string;
  invoice_number: string;
  invoice_status: string;
  total_cents: number;
  currency: string;
}

const toRecord = (row: CheckoutRow): CheckoutRecord => ({
  subscriptionId: row.subscription_id,
  status: row.status,
  planPriceId: row.plan_price_id,
  invoiceId: row.invoice_id,
  invoiceNumber: row.invoice_number,
  invoiceStatus: row.invoice_status,
  totalCents: row.total_cents,
  currency: row.currency.trim(),
});

function constraintOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && typeof constraint === "string"
    ? constraint
    : undefined;
}

// Chaque opération d'écriture est une seule requête (CTE) : atomique sans transaction explicite.
export function createSubscriptionRepository(
  db: Queryable,
): SubscriptionRepository {
  return {
    async findPlanPrice(id) {
      const [row] = await db.query<{
        id: string;
        plan_id: string;
        interval: PlanPriceRef["interval"];
        amount_cents: number;
        currency: string;
        active: boolean;
      }>(
        `SELECT pp.id, pp.plan_id, pp."interval", pp.amount_cents, pp.currency,
                (pp.active AND p.active) AS active
         FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
         WHERE pp.id = $1`,
        [id],
      );
      return row
        ? {
            id: row.id,
            planId: row.plan_id,
            interval: row.interval,
            amountCents: row.amount_cents,
            currency: row.currency.trim(),
            active: row.active,
          }
        : null;
    },

    async findByIdempotencyKey(accountId, key) {
      const [row] = await db.query<CheckoutRow>(
        `SELECT s.id AS subscription_id, s.status, s.plan_price_id,
                i.id AS invoice_id, i.number AS invoice_number, i.status AS invoice_status,
                i.total_cents, i.currency
         FROM subscriptions s
         JOIN invoices i ON i.subscription_id = s.id
         WHERE s.account_id = $1 AND s.idempotency_key = $2
         ORDER BY i.issued_at, i.number
         LIMIT 1`,
        [accountId, key],
      );
      return row ? toRecord(row) : null;
    },

    async createPending(input) {
      try {
        const [row] = await db.query<CheckoutRow>(
          `WITH sub AS (
             INSERT INTO subscriptions
               (account_id, plan_price_id, status, current_period_start, current_period_end,
                created_at, idempotency_key)
             VALUES ($1, $2, 'pending', $6::timestamptz,
                     $6::timestamptz + CASE $7::text WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END,
                     $6::timestamptz, $3)
             RETURNING id, status, plan_price_id
           ), inv AS (
             INSERT INTO invoices (account_id, subscription_id, number, status, total_cents, currency, issued_at)
             SELECT $1, sub.id, 'INV-' || lpad(nextval('invoice_number_seq')::text, 6, '0'),
                    'open', $4, $5, $6::timestamptz
             FROM sub
             RETURNING id, number, status, total_cents, currency
           ), line AS (
             INSERT INTO invoice_lines (invoice_id, type, description, amount_cents)
             SELECT inv.id, 'plan', 'Abonnement', $4 FROM inv
           )
           SELECT sub.id AS subscription_id, sub.status, sub.plan_price_id,
                  inv.id AS invoice_id, inv.number AS invoice_number, inv.status AS invoice_status,
                  inv.total_cents, inv.currency
           FROM sub, inv`,
          [
            input.accountId,
            input.planPriceId,
            input.idempotencyKey,
            input.amountCents,
            input.currency,
            input.now,
            input.interval,
          ],
        );
        if (!row) throw new Error("checkout insert returned no row");
        return toRecord(row);
      } catch (err) {
        switch (constraintOf(err)) {
          case "subscriptions_one_live_per_account":
            throw new LiveSubscriptionExistsError();
          case "subscriptions_idempotency":
            throw new DuplicateIdempotencyKeyError();
          default:
            throw err;
        }
      }
    },

    async recordPayment(invoiceId, providerRef, amountCents) {
      await db.query(
        `INSERT INTO payments (invoice_id, provider_ref, status, amount_cents)
         VALUES ($1, $2, 'pending', $3)
         ON CONFLICT (provider_ref) DO NOTHING`,
        [invoiceId, providerRef, amountCents],
      );
    },

    async activateByProviderRef(providerRef, paidAt) {
      const [row] = await db.query<{ activated: number }>(
        `WITH pay AS (
           UPDATE payments SET status = 'succeeded'
           WHERE provider_ref = $1 AND status = 'pending'
           RETURNING invoice_id
         ), inv AS (
           UPDATE invoices SET status = 'paid', paid_at = $2::timestamptz
           WHERE id IN (SELECT invoice_id FROM pay) AND status = 'open'
           RETURNING subscription_id
         ), sub AS (
           UPDATE subscriptions s
           SET status = 'active',
               current_period_start = $2::timestamptz,
               current_period_end = $2::timestamptz + CASE pp."interval"
                 WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END
           FROM plan_prices pp
           WHERE s.id IN (SELECT subscription_id FROM inv)
             AND s.status = 'pending' AND pp.id = s.plan_price_id
           RETURNING s.id
         )
         SELECT count(*)::int AS activated FROM sub`,
        [providerRef, paidAt],
      );
      return (row?.activated ?? 0) > 0;
    },

    async expirePending(createdBefore) {
      const [row] = await db.query<{ expired: number }>(
        `WITH sub AS (
           UPDATE subscriptions SET status = 'expired'
           WHERE status = 'pending' AND created_at < $1
           RETURNING id
         ), inv AS (
           UPDATE invoices SET status = 'void'
           WHERE subscription_id IN (SELECT id FROM sub) AND status = 'open'
           RETURNING id
         ), pay AS (
           UPDATE payments SET status = 'failed'
           WHERE invoice_id IN (SELECT id FROM inv) AND status = 'pending'
           RETURNING id
         )
         SELECT count(*)::int AS expired FROM sub`,
        [createdBefore],
      );
      return row?.expired ?? 0;
    },
  };
}
