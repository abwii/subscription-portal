import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type PgDatabase } from "./db.js";
import { createGiftRepository } from "./gifts.pg.js";
import { createInvoiceRepository } from "./invoices.pg.js";
import { createLoyaltyRepository } from "./loyalty.pg.js";
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

describe.skipIf(!url)("loyalty XP and tiers (Postgres)", () => {
  let db: PgDatabase;
  let price1999: string;
  let price5100: string;
  const accountId = "00000000-0000-4000-8000-0000000000aa";
  const t0 = new Date("2026-10-17T12:00:00Z");

  beforeAll(async () => {
    db = createDatabase(url ?? "");
    await runMigrations(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.query(
      `TRUNCATE xp_ledger, loyalty_accounts, gifts, subscription_events, payment_events, payments,
         invoice_lines, invoices, subscriptions, plan_entitlements, entitlements, plan_prices, plans,
         accounts CASCADE`,
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
    price1999 = await price("pro", 1, 1999);
    price5100 = await price("big", 2, 5100);
  });

  const subs = () => createSubscriptionRepository(db);
  const loyalty = () => createLoyaltyRepository(db);

  /** Abonnement payé au prix donné : la facture payée rapporte des XP. */
  async function paidSubscription(priceId: string, cents: number, key = "first", ref = "pi_first", at = t0) {
    const record = await subs().createPending({
      accountId,
      planPriceId: priceId,
      idempotencyKey: key,
      amountCents: cents,
      currency: "EUR",
      interval: "month",
      now: at,
    });
    await subs().recordPayment(record.invoiceId, ref, cents);
    await subs().applyPaymentEvent(evt(`e_${ref}`, "payment.succeeded", ref), at);
    return record;
  }

  const ledger = () =>
    db.query<{ delta: number; reason: string; idempotency_key: string }>(
      `SELECT delta, reason, idempotency_key FROM xp_ledger ORDER BY created_at, idempotency_key`,
    );

  const account = async () =>
    (
      await db.query<{ xp_total: number; code: string; tier_since: Date }>(
        `SELECT la.xp_total, t.code, la.tier_since
         FROM loyalty_accounts la JOIN loyalty_tiers t ON t.id = la.tier_id
         WHERE la.account_id = $1`,
        [accountId],
      )
    )[0];

  const ledgerTotal = async () =>
    (
      await db.query<{ total: number }>(
        `SELECT COALESCE(sum(delta), 0)::int AS total FROM xp_ledger WHERE account_id = $1`,
        [accountId],
      )
    )[0]?.total;

  it("ships the four tiers", async () => {
    const tiers = await db.query<{ code: string; min_xp: number; discount_bps: number }>(
      `SELECT code, min_xp, discount_bps FROM loyalty_tiers ORDER BY rank`,
    );
    expect(tiers).toEqual([
      { code: "bronze", min_xp: 0, discount_bps: 0 },
      { code: "silver", min_xp: 500, discount_bps: 200 },
      { code: "gold", min_xp: 2000, discount_bps: 500 },
      { code: "platinum", min_xp: 5000, discount_bps: 1000 },
    ]);
  });

  it("awards 10 XP per full euro paid: a 19.99 EUR invoice gives 190 XP", async () => {
    const record = await paidSubscription(price1999, 1999);
    expect(await ledger()).toEqual([
      { delta: 190, reason: "invoice_paid", idempotency_key: `invoice_paid:${record.invoiceId}` },
    ]);
    expect(await account()).toMatchObject({ xp_total: 190, code: "bronze" });
  });

  it("awards nothing for an invoice under one euro", async () => {
    await paidSubscription(price1999, 99);
    expect(await ledger()).toEqual([]);
    // la période payée démarre quand même une série : le compte de fidélité existe, à 0 XP
    expect(await account()).toMatchObject({ xp_total: 0, code: "bronze" });
  });

  it("never counts the same invoice twice: a replayed event, another event or a direct re-award do nothing", async () => {
    const record = await paidSubscription(price1999, 1999);
    expect(
      await subs().applyPaymentEvent(evt("e_pi_first", "payment.succeeded", "pi_first"), t0),
    ).toBe("duplicate");
    expect(
      await subs().applyPaymentEvent(evt("e_other", "payment.succeeded", "pi_first"), t0),
    ).toBe("unmatched");
    const [again] = await db.query<{ awarded: boolean }>(
      `SELECT award_xp($1, 190, 'invoice_paid', 'invoice', $2, $3, $4) AS awarded`,
      [accountId, record.invoiceId, `invoice_paid:${record.invoiceId}`, t0],
    );
    expect(again?.awarded).toBe(false);
    expect(await ledger()).toHaveLength(1);
    expect(await account()).toMatchObject({ xp_total: 190 });
  });

  it("moves to Argent when the total crosses 500 XP", async () => {
    await paidSubscription(price1999, 1999, "k1", "pi_1"); // 190
    expect(await account()).toMatchObject({ xp_total: 190, code: "bronze" });
    await db.query(`UPDATE subscriptions SET status = 'canceled'`);
    const later = new Date("2026-11-20T00:00:00Z");
    await paidSubscription(price5100, 5100, "k2", "pi_2", later); // +510
    expect(await account()).toMatchObject({ xp_total: 700, code: "silver", tier_since: later });
    expect(await ledgerTotal()).toBe(700);
  });

  it("reverses the XP of a refunded invoice without demoting the tier within 12 months", async () => {
    await paidSubscription(price5100, 5100, "k1", "pi_big"); // 510 XP → Argent
    expect(await account()).toMatchObject({ xp_total: 510, code: "silver" });

    const refundAt = new Date("2027-06-01T00:00:00Z"); // 7 mois plus tard
    expect(
      await subs().applyPaymentEvent(evt("e_ref", "payment.refunded", "pi_big"), refundAt),
    ).toBe("applied");

    expect(await ledger()).toEqual([
      expect.objectContaining({ delta: 510, reason: "invoice_paid" }),
      expect.objectContaining({ delta: -510, reason: "invoice_refunded" }),
    ]);
    // XP retirés, palier conservé : obtenu il y a moins de 12 mois
    expect(await account()).toMatchObject({ xp_total: 0, code: "silver" });
    expect(await ledgerTotal()).toBe(0);
    // rejeu du remboursement : pas de second retrait
    expect(
      await subs().applyPaymentEvent(evt("e_ref", "payment.refunded", "pi_big"), refundAt),
    ).toBe("duplicate");
    expect(await ledgerTotal()).toBe(0);
  });

  it("demotes after a refund once the tier has been held for 12 months", async () => {
    await paidSubscription(price5100, 5100, "k1", "pi_big");
    await subs().applyPaymentEvent(
      evt("e_ref", "payment.refunded", "pi_big"),
      new Date("2027-10-17T12:00:00Z"), // exactement 12 mois après l'obtention
    );
    expect(await account()).toMatchObject({ xp_total: 0, code: "bronze" });
  });

  it("gives XP to the purchaser of a gift", async () => {
    const gift = await createGiftRepository(db).create({
      purchaserAccountId: accountId,
      planPriceId: price1999,
      durationPeriods: 3,
      recipientEmail: null,
      idempotencyKey: "g1",
      code: "CODE-XP-AAAAAAAAAAAAAA",
      amountCents: 1999,
      currency: "EUR",
      now: t0,
    });
    await subs().recordPayment(gift.invoiceId, "pi_gift", gift.totalCents);
    await subs().applyPaymentEvent(evt("e_gift", "payment.succeeded", "pi_gift"), t0);
    expect(await account()).toMatchObject({ xp_total: 590, code: "silver" }); // 59,97 € → 59 × 10
  });

  it("keeps the ledger and the account total identical", async () => {
    await paidSubscription(price1999, 1999, "k1", "pi_1");
    await db.query(`UPDATE subscriptions SET status = 'canceled'`);
    await paidSubscription(price5100, 5100, "k2", "pi_2", new Date("2026-12-01T00:00:00Z"));
    await subs().applyPaymentEvent(
      evt("e_ref", "payment.refunded", "pi_1"),
      new Date("2026-12-02T00:00:00Z"),
    );
    expect((await account())?.xp_total).toBe(await ledgerTotal());
  });

  it("refuses to edit or delete the ledger (append-only)", async () => {
    await paidSubscription(price1999, 1999);
    await expect(db.query(`UPDATE xp_ledger SET delta = 1`)).rejects.toThrow(/append-only/);
    await expect(db.query(`DELETE FROM xp_ledger`)).rejects.toThrow(/append-only/);
  });

  describe("renewal discount", () => {
    async function renewal(at: Date, cents = 1999) {
      const [sub] = await db.query<{ id: string }>(`SELECT id FROM subscriptions LIMIT 1`);
      const invoice = await subs().createRenewalInvoice({
        subscriptionId: sub?.id ?? "",
        accountId,
        planPriceId: price1999,
        amountCents: cents,
        currency: "EUR",
        interval: "month",
        periodStart: at,
        now: at,
      });
      const lines = await createInvoiceRepository(db).findInvoice(accountId, invoice?.invoiceId ?? "");
      return { invoice, lines: lines?.lines ?? [] };
    }

    it("charges the full price to a Bronze member, without discount line", async () => {
      await paidSubscription(price1999, 1999);
      const { invoice, lines } = await renewal(new Date("2026-11-17T12:00:00Z"));
      expect(invoice?.totalCents).toBe(1999);
      expect(lines.map((l) => l.type)).toEqual(["plan"]);
    });

    it("applies the 2% Argent discount as a separate line, rounded half up", async () => {
      await paidSubscription(price5100, 5100); // 510 XP → Argent
      const { invoice, lines } = await renewal(new Date("2026-11-17T12:00:00Z"), 1999);
      // 2 % de 19,99 € = 39,98 c → 40 c
      expect(invoice?.totalCents).toBe(1959);
      expect(lines.map((l) => [l.type, l.amountCents])).toEqual([
        ["plan", 1999],
        ["discount", -40],
      ]);
      expect(lines[1]?.description).toContain("2 %");
    });

    it("rounds exactly half a cent up", async () => {
      await paidSubscription(price5100, 5100);
      // 2 % de 25 c = 0,5 c → 1 c
      const { invoice } = await renewal(new Date("2026-11-17T12:00:00Z"), 25);
      expect(invoice?.totalCents).toBe(24);
    });

    it("awards XP on the discounted amount actually paid", async () => {
      await paidSubscription(price5100, 5100);
      const { invoice } = await renewal(new Date("2026-11-17T12:00:00Z"), 1999);
      await subs().recordPayment(invoice?.invoiceId ?? "", "pi_renew", invoice?.totalCents ?? 0);
      await subs().applyPaymentEvent(
        evt("e_renew", "payment.succeeded", "pi_renew"),
        new Date("2026-11-17T12:05:00Z"),
      );
      // 510 + 19 € (19,59 € arrondi à l'euro inférieur) × 10
      expect((await account())?.xp_total).toBe(700);
    });
  });

  describe("summary", () => {
    it("is Bronze with zero XP for an account with no activity", async () => {
      expect(await loyalty().getSummary(accountId)).toMatchObject({
        xp: 0,
        tier: { code: "bronze", name: "Bronze", discountBps: 0 },
        nextTier: { code: "silver", name: "Argent", minXp: 500, xpRemaining: 500 },
      });
    });

    it("reports the XP, the tier and the distance to the next one", async () => {
      await paidSubscription(price5100, 5100);
      expect(await loyalty().getSummary(accountId)).toMatchObject({
        xp: 510,
        tier: { code: "silver", discountBps: 200, since: t0 },
        nextTier: { code: "gold", minXp: 2000, xpRemaining: 1490 },
      });
    });

    it("has no next tier at the top", async () => {
      await db.query(`SELECT award_xp($1, 6000, 'test', 'test', NULL, 'top', $2)`, [accountId, t0]);
      expect(await loyalty().getSummary(accountId)).toMatchObject({
        xp: 6000,
        tier: { code: "platinum" },
        nextTier: null,
      });
    });
  });
});
