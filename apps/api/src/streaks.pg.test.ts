import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type PgDatabase } from "./db.js";
import { createGiftRepository } from "./gifts.pg.js";
import { createLoyaltyRepository } from "./loyalty.pg.js";
import { runMigrations } from "./migrate.js";
import type { PaymentEvent } from "./payments.js";
import type { UpgradeQuote } from "./proration.js";
import { createSubscriptionRepository } from "./subscriptions.pg.js";

// Test d'intégration : voir subscriptions.pg.test.ts (base jetable, TEST_DATABASE_URL).
const url = process.env.TEST_DATABASE_URL;

const evt = (id: string, type: PaymentEvent["type"], providerRef: string): PaymentEvent => ({
  id,
  type,
  providerRef,
});

const DAY = 24 * 60 * 60 * 1000;

describe.skipIf(!url)("loyalty streaks (Postgres)", () => {
  let db: PgDatabase;
  let priceId: string;
  let maxPriceId: string;
  const accountId = "00000000-0000-4000-8000-0000000000aa";
  const t0 = new Date("2026-10-17T12:00:00Z");
  let counter = 0;

  beforeAll(async () => {
    db = createDatabase(url ?? "");
    await runMigrations(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    counter = 0;
    await db.query(
      `TRUNCATE streak_progress, xp_ledger, loyalty_accounts, gifts, subscription_events,
         payment_events, payments, invoice_lines, invoices, subscriptions, plan_entitlements,
         entitlements, plan_prices, plans, accounts CASCADE`,
    );
    await db.query(`INSERT INTO accounts (id, email) VALUES ($1, 'a@example.test')`, [accountId]);
    const price = async (code: string, rank: number, cents: number) => {
      const [plan] = await db.query<{ id: string }>(
        `INSERT INTO plans (code, name, rank) VALUES ($1, $1, $2) RETURNING id`,
        [code, rank],
      );
      const [p] = await db.query<{ id: string }>(
        `INSERT INTO plan_prices (plan_id, "interval", amount_cents, currency)
         VALUES ($1, 'month', $2, 'EUR') RETURNING id`,
        [plan?.id, cents],
      );
      return p?.id ?? "";
    };
    priceId = await price("pro", 1, 999);
    maxPriceId = await price("max", 2, 1999);
  });

  const subs = () => createSubscriptionRepository(db);
  const next = () => String(++counter);

  async function subscriptionId() {
    const [row] = await db.query<{ id: string }>(
      `SELECT id FROM subscriptions WHERE status <> 'canceled' ORDER BY created_at DESC LIMIT 1`,
    );
    return row?.id ?? "";
  }

  async function periodEnd() {
    const [row] = await db.query<{ end: Date }>(
      `SELECT current_period_end AS "end" FROM subscriptions
       WHERE status <> 'canceled' ORDER BY created_at DESC LIMIT 1`,
    );
    return row?.end ?? t0;
  }

  /** Checkout payé : première période. */
  async function checkout() {
    const record = await subs().createPending({
      accountId,
      planPriceId: priceId,
      idempotencyKey: "first",
      amountCents: 999,
      currency: "EUR",
      interval: "month",
      now: t0,
    });
    await subs().recordPayment(record.invoiceId, "pi_first", 999);
    await subs().applyPaymentEvent(evt("e_first", "payment.succeeded", "pi_first"), t0);
    return record;
  }

  /** Renouvellement facturé juste après la fin de période ; retourne la référence de paiement. */
  async function renewalInvoice() {
    const end = await periodEnd();
    const now = new Date(end.getTime() + 60_000);
    const [due] = await subs().listDueRenewals(now, 10);
    if (!due) throw new Error("no renewal due");
    const invoice = await subs().createRenewalInvoice({
      subscriptionId: due.subscriptionId,
      accountId,
      planPriceId: due.planPriceId,
      amountCents: due.amountCents,
      currency: due.currency,
      interval: due.interval,
      periodStart: due.periodEnd,
      now,
    });
    const ref = `pi_renew_${next()}`;
    await subs().recordPayment(invoice?.invoiceId ?? "", ref, invoice?.totalCents ?? 0);
    return { ref, now, invoiceId: invoice?.invoiceId ?? "" };
  }

  async function payRenewal() {
    const r = await renewalInvoice();
    await subs().applyPaymentEvent(evt(`e_${r.ref}`, "payment.succeeded", r.ref), r.now);
    return r;
  }

  const streak = async () =>
    (
      await db.query<{ current: number; best: number }>(
        `SELECT streak_current AS current, streak_best AS best
         FROM loyalty_accounts WHERE account_id = $1`,
        [accountId],
      )
    )[0];

  const bonuses = async () =>
    (
      await db.query<{ delta: number; idempotency_key: string }>(
        `SELECT delta, idempotency_key FROM xp_ledger WHERE reason = 'streak_bonus' ORDER BY created_at`,
      )
    ).length;

  it("starts the streak with the first paid period", async () => {
    await checkout();
    expect(await streak()).toEqual({ current: 1, best: 1 });
  });

  it("counts one more period for each renewal paid on time, and records the best", async () => {
    await checkout();
    await payRenewal();
    expect(await streak()).toEqual({ current: 2, best: 2 });
  });

  it("grants a 50 XP bonus on every 3rd consecutive period, once each", async () => {
    await checkout(); // 1
    await payRenewal(); // 2
    expect(await bonuses()).toBe(0);
    await payRenewal(); // 3 → bonus
    expect(await streak()).toEqual({ current: 3, best: 3 });
    expect(await bonuses()).toBe(1);
    await payRenewal(); // 4
    await payRenewal(); // 5
    expect(await bonuses()).toBe(1);
    await payRenewal(); // 6 → second bonus
    expect(await streak()).toEqual({ current: 6, best: 6 });
    expect(await bonuses()).toBe(2);
    const [xp] = await db.query<{ xp_total: number; ledger: number }>(
      `SELECT la.xp_total, (SELECT sum(delta)::int FROM xp_ledger) AS ledger
       FROM loyalty_accounts la WHERE la.account_id = $1`,
      [accountId],
    );
    expect(xp?.xp_total).toBe(xp?.ledger); // total toujours égal au journal, bonus compris
  });

  it("counts a payment once, even if its event is replayed or re-delivered", async () => {
    await checkout();
    const r = await renewalInvoice();
    await subs().applyPaymentEvent(evt("e_a", "payment.succeeded", r.ref), r.now);
    expect(await subs().applyPaymentEvent(evt("e_a", "payment.succeeded", r.ref), r.now)).toBe(
      "duplicate",
    );
    expect(await subs().applyPaymentEvent(evt("e_b", "payment.succeeded", r.ref), r.now)).toBe(
      "unmatched",
    );
    const [again] = await db.query<{ advanced: boolean }>(
      `SELECT advance_streak($1, $2, $3) AS advanced`,
      [accountId, r.invoiceId, r.now],
    );
    expect(again?.advanced).toBe(false);
    expect(await streak()).toEqual({ current: 2, best: 2 });
  });

  it("does not break the streak when a failed renewal is recovered within the grace period, nor count it as on time", async () => {
    await checkout();
    await payRenewal(); // série 2
    const r = await renewalInvoice();
    await subs().applyPaymentEvent(evt("e_fail", "payment.failed", r.ref), r.now);
    expect((await db.query<{ status: string }>(`SELECT status FROM subscriptions`))[0]?.status).toBe(
      "past_due",
    );
    // rattrapé 3 jours plus tard (grâce de 7 jours)
    const recoveredAt = new Date(r.now.getTime() + 3 * DAY);
    await subs().applyPaymentEvent(evt("e_ok", "payment.succeeded", r.ref), recoveredAt);
    expect(
      await createLoyaltyRepository(db).breakExpiredStreaks(new Date(r.now.getTime() + 30 * DAY)),
    ).toBe(0);
    expect(await streak()).toEqual({ current: 2, best: 2 });
    // la période suivante, payée à l'heure, repart de 2
    await payRenewal();
    expect(await streak()).toEqual({ current: 3, best: 3 });
  });

  it("resets the streak to 0 when the subscription stays past_due past the grace period, keeping the best", async () => {
    await checkout();
    await payRenewal();
    await payRenewal(); // série 3, meilleur 3
    const r = await renewalInvoice();
    await subs().applyPaymentEvent(evt("e_fail", "payment.failed", r.ref), r.now);
    const end = await periodEnd();

    const loyalty = createLoyaltyRepository(db);
    expect(await loyalty.breakExpiredStreaks(new Date(end.getTime() + 6 * DAY))).toBe(0); // grâce en cours
    expect(await streak()).toEqual({ current: 3, best: 3 });
    expect(await loyalty.breakExpiredStreaks(new Date(end.getTime() + 7 * DAY))).toBe(1);
    expect(await streak()).toEqual({ current: 0, best: 3 });
    expect(await loyalty.breakExpiredStreaks(new Date(end.getTime() + 8 * DAY))).toBe(0); // rejouable
  });

  it("can earn the 3-period bonus again after a reset", async () => {
    await checkout();
    await payRenewal();
    await payRenewal(); // 3 → bonus n°1
    expect(await bonuses()).toBe(1);
    const failed = await renewalInvoice();
    await subs().applyPaymentEvent(evt("e_fail", "payment.failed", failed.ref), failed.now);
    await createLoyaltyRepository(db).breakExpiredStreaks(
      new Date((await periodEnd()).getTime() + 8 * DAY),
    );
    // l'abonné se réabonne : nouvelle série
    await db.query(`UPDATE subscriptions SET status = 'canceled'`);
    const again = await subs().createPending({
      accountId,
      planPriceId: priceId,
      idempotencyKey: "again",
      amountCents: 999,
      currency: "EUR",
      interval: "month",
      now: new Date("2027-03-01T00:00:00Z"),
    });
    await subs().recordPayment(again.invoiceId, "pi_again", 999);
    await subs().applyPaymentEvent(
      evt("e_again", "payment.succeeded", "pi_again"),
      new Date("2027-03-01T00:00:00Z"),
    );
    expect(await streak()).toEqual({ current: 1, best: 3 });
    await payRenewal();
    await payRenewal(); // 3 de nouveau
    expect(await streak()).toEqual({ current: 3, best: 3 });
    expect(await bonuses()).toBe(2);
  });

  it("freezes the streak during a pause: neither reset nor incremented by the resume", async () => {
    await checkout();
    await payRenewal(); // série 2
    const id = await subscriptionId();
    const pausedAt = new Date((await periodEnd()).getTime() - DAY);
    await subs().pause({ subscriptionId: id, now: pausedAt, resumeAt: new Date(pausedAt.getTime() + 20 * DAY) });
    // longue pause : aucune clôture de série
    expect(
      await createLoyaltyRepository(db).breakExpiredStreaks(new Date(pausedAt.getTime() + 60 * DAY)),
    ).toBe(0);
    const resumeAt = new Date(pausedAt.getTime() + 20 * DAY);
    const resumed = await subs().resume({ subscriptionId: id, now: resumeAt });
    await subs().recordPayment(resumed?.invoiceId ?? "", "pi_resume", resumed?.totalCents ?? 0);
    await subs().applyPaymentEvent(evt("e_resume", "payment.succeeded", "pi_resume"), resumeAt);
    expect(await streak()).toEqual({ current: 2, best: 2 });
    await payRenewal();
    expect(await streak()).toEqual({ current: 3, best: 3 });
  });

  it("does not count plan changes or gift purchases as periods", async () => {
    await checkout();
    const id = await subscriptionId();
    const quote: UpgradeQuote = {
      lines: [{ type: "proration_charge", description: "Nouveau plan", amountCents: 500 }],
      totalCents: 500,
      startsNewPeriod: false,
    };
    const change = await subs().createChangeInvoice({
      accountId,
      subscriptionId: id,
      targetPlanPriceId: maxPriceId,
      idempotencyKey: "up",
      quote,
      currency: "EUR",
      now: t0,
    });
    await subs().recordPayment(change.invoiceId, "pi_up", 500);
    await subs().applyPaymentEvent(evt("e_up", "payment.succeeded", "pi_up"), t0);

    const gift = await createGiftRepository(db).create({
      purchaserAccountId: accountId,
      planPriceId: priceId,
      durationPeriods: 1,
      recipientEmail: null,
      idempotencyKey: "g1",
      code: "CODE-STREAK-AAAAAAAAAAA",
      amountCents: 999,
      currency: "EUR",
      now: t0,
    });
    await subs().recordPayment(gift.invoiceId, "pi_gift", gift.totalCents);
    await subs().applyPaymentEvent(evt("e_gift", "payment.succeeded", "pi_gift"), t0);

    expect(await streak()).toEqual({ current: 1, best: 1 });
  });

  it("is reported in the loyalty summary", async () => {
    expect(await createLoyaltyRepository(db).getSummary(accountId)).toMatchObject({
      streak: { current: 0, best: 0 },
    });
    await checkout();
    await payRenewal();
    expect(await createLoyaltyRepository(db).getSummary(accountId)).toMatchObject({
      streak: { current: 2, best: 2 },
    });
  });
});
