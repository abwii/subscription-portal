import type { Queryable } from "./db.js";
import {
  ChangeInProgressError,
  type ChangeRecord,
  type SubscriptionForChange,
} from "./plan-changes.js";
import {
  DuplicateIdempotencyKeyError,
  LiveSubscriptionExistsError,
  type CheckoutRecord,
  type PlanPriceRef,
  type SubscriptionRepository,
} from "./subscriptions.js";

const UNIQUE_VIOLATION = "23505";

interface ChangeRow {
  invoice_id: string;
  invoice_number: string;
  invoice_status: string;
  total_cents: number;
  currency: string;
  subscription_id: string;
  target_plan_price_id: string;
  lines: ChangeRecord["lines"];
}

const toChange = (row: ChangeRow): ChangeRecord => ({
  invoiceId: row.invoice_id,
  invoiceNumber: row.invoice_number,
  invoiceStatus: row.invoice_status,
  totalCents: row.total_cents,
  currency: row.currency.trim(),
  subscriptionId: row.subscription_id,
  targetPlanPriceId: row.target_plan_price_id,
  lines: row.lines,
});

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
        rank: number;
        interval: PlanPriceRef["interval"];
        amount_cents: number;
        currency: string;
        active: boolean;
      }>(
        `SELECT pp.id, pp.plan_id, p.rank, pp."interval", pp.amount_cents, pp.currency,
                (pp.active AND p.active) AS active
         FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
         WHERE pp.id = $1`,
        [id],
      );
      return row
        ? {
            id: row.id,
            planId: row.plan_id,
            rank: row.rank,
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

    async applyPaymentEvent(event, now) {
      // $1 id d'événement, $2 type, $3 référence du paiement, $4 date. L'événement et son effet
      // sont dans la même requête : soit tout est écrit, soit rien (le fournisseur rejoue).
      const record = `ev AS (
           INSERT INTO payment_events (provider_event_id, type, provider_ref, received_at)
           VALUES ($1, $2, $3, $4::timestamptz)
           ON CONFLICT (provider_event_id) DO NOTHING
           RETURNING 1
         )`;
      const succeeded = event.type === "payment.succeeded";
      const sql = succeeded
        ? // Un paiement `failed` peut encore réussir (le client retente avec le même PaymentIntent).
          // Checkout (pas de prix visé) : pending → active, période démarrant au paiement.
          // Changement de plan : le plan bascule ; la période ne repart que si l'intervalle change.
          `WITH ${record}, pay AS (
             UPDATE payments SET status = 'succeeded'
             WHERE provider_ref = $3 AND status IN ('pending', 'failed')
               AND EXISTS (SELECT 1 FROM ev)
             RETURNING invoice_id
           ), inv AS (
             UPDATE invoices SET status = 'paid', paid_at = $4::timestamptz
             WHERE id IN (SELECT invoice_id FROM pay) AND status = 'open'
             RETURNING subscription_id, target_plan_price_id, starts_new_period
           ), sub AS (
             UPDATE subscriptions s
             SET status = 'active',
                 plan_price_id = COALESCE(inv.target_plan_price_id, s.plan_price_id),
                 current_period_start =
                   CASE WHEN inv.target_plan_price_id IS NULL OR inv.starts_new_period
                        THEN $4::timestamptz ELSE s.current_period_start END,
                 current_period_end =
                   CASE WHEN inv.target_plan_price_id IS NULL OR inv.starts_new_period
                        THEN $4::timestamptz + CASE pp."interval"
                               WHEN 'month' THEN interval '1 month' ELSE interval '1 year' END
                        ELSE s.current_period_end END
             FROM inv, plan_prices pp
             WHERE s.id = inv.subscription_id
               AND pp.id = COALESCE(inv.target_plan_price_id, s.plan_price_id)
               AND ((inv.target_plan_price_id IS NULL AND s.status = 'pending')
                    OR (inv.target_plan_price_id IS NOT NULL AND s.status = 'active'))
             RETURNING s.id
           )
           SELECT (SELECT count(*) FROM ev)::int AS recorded,
                  (SELECT count(*) FROM sub)::int AS effects`
        : `WITH ${record}, pay AS (
             UPDATE payments SET status = 'failed'
             WHERE provider_ref = $3 AND status = 'pending' AND EXISTS (SELECT 1 FROM ev)
             RETURNING invoice_id
           ), sub AS (
             -- Un échec de paiement de changement de plan laisse le plan et l'abonnement intacts.
             UPDATE subscriptions s SET status = 'past_due'
             FROM invoices i
             WHERE i.id IN (SELECT invoice_id FROM pay)
               AND i.target_plan_price_id IS NULL
               AND s.id = i.subscription_id AND s.status = 'active'
             RETURNING s.id
           )
           SELECT (SELECT count(*) FROM ev)::int AS recorded,
                  (SELECT count(*) FROM pay)::int AS effects`;
      const [row] = await db.query<{ recorded: number; effects: number }>(sql, [
        event.id,
        event.type,
        event.providerRef,
        now,
      ]);
      if (!row || row.recorded === 0) return "duplicate";
      return row.effects > 0 ? "applied" : "unmatched";
    },

    async findSubscriptionForChange(accountId, subscriptionId) {
      const [row] = await db.query<{
        id: string;
        status: SubscriptionForChange["status"];
        plan_price_id: string;
        plan_id: string;
        rank: number;
        interval: SubscriptionForChange["interval"];
        amount_cents: number;
        currency: string;
        current_period_start: Date;
        current_period_end: Date;
      }>(
        `SELECT s.id, s.status, s.plan_price_id, p.id AS plan_id, p.rank, pp."interval",
                pp.amount_cents, pp.currency, s.current_period_start, s.current_period_end
         FROM subscriptions s
         JOIN plan_prices pp ON pp.id = s.plan_price_id
         JOIN plans p ON p.id = pp.plan_id
         WHERE s.id = $1 AND s.account_id = $2`,
        [subscriptionId, accountId],
      );
      return row
        ? {
            id: row.id,
            status: row.status,
            planPriceId: row.plan_price_id,
            planId: row.plan_id,
            rank: row.rank,
            interval: row.interval,
            amountCents: row.amount_cents,
            currency: row.currency.trim(),
            periodStart: row.current_period_start,
            periodEnd: row.current_period_end,
          }
        : null;
    },

    async findChangeByIdempotencyKey(accountId, key) {
      const [row] = await db.query<ChangeRow>(
        `SELECT i.id AS invoice_id, i.number AS invoice_number, i.status AS invoice_status,
                i.total_cents, i.currency, i.subscription_id, i.target_plan_price_id,
                COALESCE((
                  SELECT json_agg(json_build_object(
                    'type', l.type, 'description', l.description, 'amountCents', l.amount_cents)
                    ORDER BY l.position)
                  FROM invoice_lines l WHERE l.invoice_id = i.id
                ), '[]'::json) AS lines
         FROM invoices i
         WHERE i.account_id = $1 AND i.idempotency_key = $2
           AND i.target_plan_price_id IS NOT NULL`,
        [accountId, key],
      );
      return row ? toChange(row) : null;
    },

    async createChangeInvoice(input) {
      const { lines } = input.quote;
      try {
        const [row] = await db.query<ChangeRow>(
          `WITH inv AS (
             INSERT INTO invoices
               (account_id, subscription_id, number, status, total_cents, currency, issued_at,
                target_plan_price_id, starts_new_period, idempotency_key)
             VALUES ($1, $2, 'INV-' || lpad(nextval('invoice_number_seq')::text, 6, '0'),
                     'open', $3, $4, $5::timestamptz, $6, $7, $8)
             RETURNING id, number, status, total_cents, currency, subscription_id,
                       target_plan_price_id
           ), line AS (
             INSERT INTO invoice_lines (invoice_id, type, description, amount_cents, position)
             SELECT inv.id, l.type, l.description, l.amount, l.pos
             FROM inv, unnest($9::text[], $10::text[], $11::int[])
                       WITH ORDINALITY AS l(type, description, amount, pos)
           )
           SELECT id AS invoice_id, number AS invoice_number, status AS invoice_status,
                  total_cents, currency, subscription_id, target_plan_price_id,
                  '[]'::json AS lines
           FROM inv`,
          [
            input.accountId,
            input.subscriptionId,
            input.quote.totalCents,
            input.currency,
            input.now,
            input.targetPlanPriceId,
            input.quote.startsNewPeriod,
            input.idempotencyKey,
            lines.map((l) => l.type),
            lines.map((l) => l.description),
            lines.map((l) => l.amountCents),
          ],
        );
        if (!row) throw new Error("change invoice insert returned no row");
        return { ...toChange(row), lines };
      } catch (err) {
        switch (constraintOf(err)) {
          case "invoices_one_open_change":
            throw new ChangeInProgressError();
          case "invoices_idempotency":
            throw new DuplicateIdempotencyKeyError();
          default:
            throw err;
        }
      }
    },

    async expirePending(createdBefore) {
      const [row] = await db.query<{ expired: number }>(
        `WITH sub AS (
           UPDATE subscriptions SET status = 'expired'
           WHERE status = 'pending' AND created_at < $1
           RETURNING id
         ), inv AS (
           UPDATE invoices SET status = 'void'
           WHERE status = 'open'
             AND (subscription_id IN (SELECT id FROM sub)
                  OR (target_plan_price_id IS NOT NULL AND issued_at < $1))
           RETURNING id, target_plan_price_id
         ), pay AS (
           UPDATE payments SET status = 'failed'
           WHERE invoice_id IN (SELECT id FROM inv) AND status = 'pending'
           RETURNING id
         )
         SELECT ((SELECT count(*) FROM sub)
                 + (SELECT count(*) FROM inv WHERE target_plan_price_id IS NOT NULL))::int AS expired`,
        [createdBefore],
      );
      return row?.expired ?? 0;
    },
  };
}
