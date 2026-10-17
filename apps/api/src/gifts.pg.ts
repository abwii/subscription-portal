import type { Queryable } from "./db.js";
import {
  DuplicateGiftKeyError,
  type GiftCheckout,
  type GiftNotification,
  type GiftRepository,
  type GiftSummary,
} from "./gifts.js";

const UNIQUE_VIOLATION = "23505";

interface CheckoutRow {
  gift_id: string;
  status: GiftCheckout["status"];
  plan_price_id: string;
  duration_periods: number;
  invoice_id: string;
  invoice_number: string;
  invoice_status: string;
  total_cents: number;
  currency: string;
}

const toCheckout = (row: CheckoutRow): GiftCheckout => ({
  giftId: row.gift_id,
  status: row.status,
  planPriceId: row.plan_price_id,
  durationPeriods: row.duration_periods,
  invoiceId: row.invoice_id,
  invoiceNumber: row.invoice_number,
  invoiceStatus: row.invoice_status,
  totalCents: row.total_cents,
  currency: row.currency.trim(),
});

function constraintOf(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { code, constraint } = err as { code?: unknown; constraint?: unknown };
  return code === UNIQUE_VIOLATION && typeof constraint === "string" ? constraint : undefined;
}

export function createGiftRepository(db: Queryable): GiftRepository {
  return {
    async findByIdempotencyKey(accountId, key) {
      const [row] = await db.query<CheckoutRow>(
        `SELECT g.id AS gift_id, g.status, g.plan_price_id, g.duration_periods,
                i.id AS invoice_id, i.number AS invoice_number, i.status AS invoice_status,
                i.total_cents, i.currency
         FROM gifts g JOIN invoices i ON i.gift_id = g.id
         WHERE g.purchaser_account_id = $1 AND g.idempotency_key = $2`,
        [accountId, key],
      );
      return row ? toCheckout(row) : null;
    },

    async create(input) {
      try {
        const [row] = await db.query<CheckoutRow>(
          `WITH g AS (
             INSERT INTO gifts
               (purchaser_account_id, plan_price_id, duration_periods, code, recipient_email,
                idempotency_key, status, created_at)
             VALUES ($1, $2, $3::int, $4, $5, $6, 'awaiting_payment', $9::timestamptz)
             RETURNING id, status, plan_price_id, duration_periods
           ), inv AS (
             INSERT INTO invoices
               (account_id, number, status, total_cents, currency, issued_at, gift_id)
             SELECT $1, 'INV-' || lpad(nextval('invoice_number_seq')::text, 6, '0'),
                    'open', $7::int * $3::int, $8, $9::timestamptz, g.id
             FROM g
             RETURNING id, number, status, total_cents, currency
           ), line AS (
             INSERT INTO invoice_lines (invoice_id, type, description, amount_cents)
             SELECT inv.id, 'plan', 'Cadeau : ' || $3::text || ' période(s)', inv.total_cents
             FROM inv
           )
           SELECT g.id AS gift_id, g.status, g.plan_price_id, g.duration_periods,
                  inv.id AS invoice_id, inv.number AS invoice_number, inv.status AS invoice_status,
                  inv.total_cents, inv.currency
           FROM g, inv`,
          [
            input.purchaserAccountId,
            input.planPriceId,
            input.durationPeriods,
            input.code,
            input.recipientEmail,
            input.idempotencyKey,
            input.amountCents,
            input.currency,
            input.now,
          ],
        );
        if (!row) throw new Error("gift insert returned no row");
        return toCheckout(row);
      } catch (err) {
        if (constraintOf(err) === "gifts_idempotency") throw new DuplicateGiftKeyError();
        throw err;
      }
    },

    async listForPurchaser(accountId) {
      const rows = await db.query<{
        id: string;
        status: GiftSummary["status"];
        plan_price_id: string;
        duration_periods: number;
        recipient_email: string | null;
        expires_at: Date | null;
        redeemed_at: Date | null;
        code: string | null;
      }>(
        // Le code n'est sélectionné que pour un cadeau utilisable.
        `SELECT id, status, plan_price_id, duration_periods, recipient_email, expires_at, redeemed_at,
                CASE WHEN status = 'pending' THEN code END AS code
         FROM gifts
         WHERE purchaser_account_id = $1
         ORDER BY created_at DESC, id`,
        [accountId],
      );
      return rows.map((row) => ({
        id: row.id,
        status: row.status,
        planPriceId: row.plan_price_id,
        durationPeriods: row.duration_periods,
        recipientEmail: row.recipient_email,
        expiresAt: row.expires_at,
        redeemedAt: row.redeemed_at,
        code: row.code,
      }));
    },

    async findNotification(providerRef): Promise<GiftNotification | null> {
      const [row] = await db.query<{
        id: string;
        code: string;
        recipient_email: string;
        plan_name: string;
        duration_periods: number;
        expires_at: Date;
      }>(
        `SELECT g.id, g.code, g.recipient_email, p.name AS plan_name, g.duration_periods, g.expires_at
         FROM payments pay
         JOIN invoices i ON i.id = pay.invoice_id
         JOIN gifts g ON g.id = i.gift_id
         JOIN plan_prices pp ON pp.id = g.plan_price_id
         JOIN plans p ON p.id = pp.plan_id
         WHERE pay.provider_ref = $1
           AND g.status = 'pending' AND g.recipient_email IS NOT NULL AND g.notified_at IS NULL`,
        [providerRef],
      );
      return row
        ? {
            giftId: row.id,
            code: row.code,
            recipientEmail: row.recipient_email,
            planName: row.plan_name,
            durationPeriods: row.duration_periods,
            expiresAt: row.expires_at,
          }
        : null;
    },

    async markNotified(giftId, at) {
      await db.query(`UPDATE gifts SET notified_at = $2::timestamptz WHERE id = $1`, [giftId, at]);
    },

    async expireStale(now) {
      const [row] = await db.query<{ expired: number }>(
        `WITH g AS (
           UPDATE gifts SET status = 'expired'
           WHERE status = 'pending' AND expires_at < $1::timestamptz
           RETURNING id
         )
         SELECT count(*)::int AS expired FROM g`,
        [now],
      );
      return row?.expired ?? 0;
    },
  };
}
