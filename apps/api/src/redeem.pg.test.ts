import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCatalogRepository } from "./catalog.pg.js";
import { grantsEntitlements } from "./catalog.js";
import { createDatabase, type PgDatabase } from "./db.js";
import { createGiftRepository } from "./gifts.pg.js";
import { runMigrations } from "./migrate.js";
import type { PaymentEvent } from "./payments.js";
import { createSubscriptionRepository } from "./subscriptions.pg.js";

// Test d'intégration : voir subscriptions.pg.test.ts (base jetable, TEST_DATABASE_URL).
const url = process.env.TEST_DATABASE_URL;

const evt = (id: string, type: PaymentEvent["type"], providerRef: string): PaymentEvent => ({
  id,
  type,
  providerRef,
});

describe.skipIf(!url)("gift redemption (Postgres)", () => {
  let db: PgDatabase;
  let priceId: string;
  const purchaser = "00000000-0000-4000-8000-0000000000aa";
  const friend = "00000000-0000-4000-8000-0000000000bb";
  const other = "00000000-0000-4000-8000-0000000000cc";
  const t0 = new Date("2026-10-17T12:00:00Z");
  const redeemAt = new Date("2026-11-01T09:00:00Z");

  beforeAll(async () => {
    db = createDatabase(url ?? "");
    await runMigrations(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.query(
      `TRUNCATE gifts, subscription_events, payment_events, payments, invoice_lines, invoices,
         subscriptions, plan_entitlements, entitlements, plan_prices, plans, accounts CASCADE`,
    );
    await db.query(
      `INSERT INTO accounts (id, email) VALUES
         ($1, 'buyer@example.test'), ($2, 'friend@example.test'), ($3, 'other@example.test')`,
      [purchaser, friend, other],
    );
    const [plan] = await db.query<{ id: string }>(
      `INSERT INTO plans (code, name, rank) VALUES ('pro', 'Pro', 1) RETURNING id`,
    );
    const [price] = await db.query<{ id: string }>(
      `INSERT INTO plan_prices (plan_id, "interval", amount_cents, currency)
       VALUES ($1, 'month', 1999, 'EUR') RETURNING id`,
      [plan?.id],
    );
    priceId = price?.id ?? "";
  });

  const gifts = () => createGiftRepository(db);
  const subs = () => createSubscriptionRepository(db);

  /** Cadeau payé de 3 mois : `pending`, valable jusqu'au 17/10/2027. */
  async function usableGift(code: string, key = code) {
    const record = await gifts().create({
      purchaserAccountId: purchaser,
      planPriceId: priceId,
      durationPeriods: 3,
      recipientEmail: null,
      idempotencyKey: key,
      code,
      amountCents: 1999,
      currency: "EUR",
      now: t0,
    });
    await subs().recordPayment(record.invoiceId, `pi_${code}`, record.totalCents);
    await subs().applyPaymentEvent(evt(`e_${code}`, "payment.succeeded", `pi_${code}`), t0);
    return record.giftId;
  }

  const giftStatus = async (id: string) =>
    (await db.query<{ status: string }>(`SELECT status FROM gifts WHERE id = $1`, [id]))[0]?.status;

  it("creates an active subscription for the whole gifted duration, ending without renewal", async () => {
    const giftId = await usableGift("CODE-ONE-AAAAAAAAAAAAAA");
    const result = await gifts().redeem({ code: "CODE-ONE-AAAAAAAAAAAAAA", accountId: friend, now: redeemAt });
    expect(result).toMatchObject({
      kind: "redeemed",
      periodStart: redeemAt,
      periodEnd: new Date("2027-02-01T09:00:00Z"),
    });

    const [sub] = await db.query<{
      status: string;
      account_id: string;
      gift_id: string;
      cancel: boolean;
      start: Date;
      end: Date;
    }>(
      `SELECT status, account_id, gift_id, cancel_at_period_end AS cancel,
              current_period_start AS start, current_period_end AS "end"
       FROM subscriptions WHERE account_id = $1`,
      [friend],
    );
    expect(sub).toMatchObject({ status: "active", gift_id: giftId, cancel: true });
    expect(sub?.start).toEqual(redeemAt);
    expect(sub?.end).toEqual(new Date("2027-02-01T09:00:00Z"));

    const [gift] = await db.query<{ status: string; by: string; at: Date }>(
      `SELECT status, redeemed_by_account_id AS by, redeemed_at AS at FROM gifts WHERE id = $1`,
      [giftId],
    );
    expect(gift).toEqual({ status: "redeemed", by: friend, at: redeemAt });
    const events = await db.query<{ type: string }>(`SELECT type FROM subscription_events`);
    expect(events.map((e) => e.type)).toEqual(["created_from_gift"]);
    // aucune facture ni paiement pour l'échange
    const [count] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM invoices WHERE account_id = $1`,
      [friend],
    );
    expect(count?.n).toBe(0);
  });

  it("grants rights during the gifted period and stops at its end, even if the closing job has not run", async () => {
    await usableGift("CODE-TWO-AAAAAAAAAAAAAA");
    await gifts().redeem({ code: "CODE-TWO-AAAAAAAAAAAAAA", accountId: friend, now: redeemAt });
    const sub = await createCatalogRepository(db).findSubscription(friend);
    if (!sub) throw new Error("expected a subscription");
    expect(grantsEntitlements(sub, new Date("2027-01-31T00:00:00Z"))).toBe(true);
    expect(grantsEntitlements(sub, new Date("2027-02-01T09:00:00Z"))).toBe(false);
  });

  it("never renews a gifted subscription and closes it at the end of the gifted periods", async () => {
    await usableGift("CODE-THREE-AAAAAAAAAAAA");
    await gifts().redeem({ code: "CODE-THREE-AAAAAAAAAAAA", accountId: friend, now: redeemAt });
    const end = new Date("2027-02-01T09:00:00Z");
    expect(await subs().listDueRenewals(new Date("2027-02-02T00:00:00Z"), 10)).toEqual([]);
    expect(await subs().closeEnded(new Date("2027-01-31T00:00:00Z"))).toBe(0);
    expect(await subs().closeEnded(end)).toBe(1);
    const [sub] = await db.query<{ status: string }>(
      `SELECT status FROM subscriptions WHERE account_id = $1`,
      [friend],
    );
    expect(sub?.status).toBe("canceled");
    // le compte peut ensuite souscrire normalement
    await expect(
      subs().createPending({
        accountId: friend,
        planPriceId: priceId,
        idempotencyKey: "paid",
        amountCents: 1999,
        currency: "EUR",
        interval: "month",
        now: end,
      }),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("exposes the gift of a subscription for the lifecycle guards", async () => {
    const giftId = await usableGift("CODE-FOUR-AAAAAAAAAAAAA");
    await gifts().redeem({ code: "CODE-FOUR-AAAAAAAAAAAAA", accountId: friend, now: redeemAt });
    const [row] = await db.query<{ id: string }>(`SELECT id FROM subscriptions WHERE account_id = $1`, [friend]);
    const found = await subs().findSubscriptionForChange(friend, row?.id ?? "");
    expect(found?.giftId).toBe(giftId);
  });

  it("answers not_found for an unknown code and for a gift still awaiting payment", async () => {
    expect(await gifts().redeem({ code: "NOPE", accountId: friend, now: redeemAt })).toEqual({
      kind: "not_found",
    });
    await gifts().create({
      purchaserAccountId: purchaser,
      planPriceId: priceId,
      durationPeriods: 1,
      recipientEmail: null,
      idempotencyKey: "unpaid",
      code: "CODE-UNPAID-AAAAAAAAAAA",
      amountCents: 1999,
      currency: "EUR",
      now: t0,
    });
    expect(
      await gifts().redeem({ code: "CODE-UNPAID-AAAAAAAAAAA", accountId: friend, now: redeemAt }),
    ).toEqual({ kind: "not_found" });
  });

  it("answers unavailable for a gift already redeemed, expired or refunded", async () => {
    const redeemed = await usableGift("CODE-USED-AAAAAAAAAAAA");
    await gifts().redeem({ code: "CODE-USED-AAAAAAAAAAAA", accountId: friend, now: redeemAt });
    expect(
      await gifts().redeem({ code: "CODE-USED-AAAAAAAAAAAA", accountId: other, now: redeemAt }),
    ).toEqual({ kind: "unavailable" });
    expect(await giftStatus(redeemed)).toBe("redeemed");

    await usableGift("CODE-OLD-AAAAAAAAAAAAA");
    expect(
      await gifts().redeem({
        code: "CODE-OLD-AAAAAAAAAAAAA",
        accountId: other,
        now: new Date("2027-10-17T12:00:01Z"), // validité dépassée, même si le job d'expiration n'a pas tourné
      }),
    ).toEqual({ kind: "unavailable" });

    await usableGift("CODE-REFUNDED-AAAAAAAA");
    await subs().applyPaymentEvent(evt("e_ref", "payment.refunded", "pi_CODE-REFUNDED-AAAAAAAA"), t0);
    expect(
      await gifts().redeem({ code: "CODE-REFUNDED-AAAAAAAA", accountId: other, now: redeemAt }),
    ).toEqual({ kind: "unavailable" });
  });

  it("refuses an account that already has a live subscription and keeps the gift usable", async () => {
    const giftId = await usableGift("CODE-LIVE-AAAAAAAAAAAA");
    const pending = await subs().createPending({
      accountId: friend,
      planPriceId: priceId,
      idempotencyKey: "mine",
      amountCents: 1999,
      currency: "EUR",
      interval: "month",
      now: t0,
    });
    expect(
      await gifts().redeem({ code: "CODE-LIVE-AAAAAAAAAAAA", accountId: friend, now: redeemAt }),
    ).toEqual({ kind: "live_subscription" });
    expect(await giftStatus(giftId)).toBe("pending");

    // une fois l'abonnement terminé, le même cadeau peut être échangé
    await db.query(`UPDATE subscriptions SET status = 'expired' WHERE id = $1`, [pending.subscriptionId]);
    expect(
      await gifts().redeem({ code: "CODE-LIVE-AAAAAAAAAAAA", accountId: friend, now: redeemAt }),
    ).toMatchObject({ kind: "redeemed" });
  });

  it("lets only one of two simultaneous redemptions of the same code succeed", async () => {
    const giftId = await usableGift("CODE-RACE-AAAAAAAAAAAA");
    const results = await Promise.all([
      gifts().redeem({ code: "CODE-RACE-AAAAAAAAAAAA", accountId: friend, now: redeemAt }),
      gifts().redeem({ code: "CODE-RACE-AAAAAAAAAAAA", accountId: other, now: redeemAt }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["redeemed", "unavailable"]);
    const [count] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM subscriptions WHERE gift_id = $1`,
      [giftId],
    );
    expect(count?.n).toBe(1);
  });

  it("lets only one of two gifts be redeemed at the same time by the same account", async () => {
    const a = await usableGift("CODE-SAME-AAAAAAAAAAAA");
    const b = await usableGift("CODE-SAME-BBBBBBBBBBBB");
    const results = await Promise.all([
      gifts().redeem({ code: "CODE-SAME-AAAAAAAAAAAA", accountId: friend, now: redeemAt }),
      gifts().redeem({ code: "CODE-SAME-BBBBBBBBBBBB", accountId: friend, now: redeemAt }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["live_subscription", "redeemed"]);
    const statuses = [await giftStatus(a), await giftStatus(b)].sort();
    expect(statuses).toEqual(["pending", "redeemed"]);
  });
});
