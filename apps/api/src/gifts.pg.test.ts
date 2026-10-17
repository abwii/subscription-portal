import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type PgDatabase } from "./db.js";
import { DuplicateGiftKeyError } from "./gifts.js";
import { createGiftRepository } from "./gifts.pg.js";
import { createInvoiceRepository } from "./invoices.pg.js";
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

describe.skipIf(!url)("gifts (Postgres)", () => {
  let db: PgDatabase;
  let priceId: string;
  const purchaser = "00000000-0000-4000-8000-0000000000aa";
  const stranger = "00000000-0000-4000-8000-0000000000bb";
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
      `TRUNCATE gifts, subscription_events, payment_events, payments, invoice_lines, invoices,
         subscriptions, plan_entitlements, entitlements, plan_prices, plans, accounts CASCADE`,
    );
    await db.query(
      `INSERT INTO accounts (id, email) VALUES ($1, 'buyer@example.test'), ($2, 'other@example.test')`,
      [purchaser, stranger],
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

  const create = (key = "k1", code = "CODE-ABCDEFGHIJKLMNOPQR", over: { email?: string | null; at?: Date } = {}) =>
    gifts().create({
      purchaserAccountId: purchaser,
      planPriceId: priceId,
      durationPeriods: 3,
      recipientEmail: over.email === undefined ? "friend@example.test" : over.email,
      idempotencyKey: key,
      code,
      amountCents: 1999,
      currency: "EUR",
      now: over.at ?? t0,
    });

  /** Cadeau payé : `pending` (utilisable). */
  async function paidGift(key = "k1", code = "CODE-ABCDEFGHIJKLMNOPQR", ref = "pi_gift") {
    const record = await create(key, code);
    await subs().recordPayment(record.invoiceId, ref, record.totalCents);
    await subs().applyPaymentEvent(evt(`e_${ref}`, "payment.succeeded", ref), t0);
    return record;
  }

  const giftRow = async (id: string) => {
    const [row] = await db.query<{
      status: string;
      expires_at: Date | null;
      notified_at: Date | null;
    }>(`SELECT status, expires_at, notified_at FROM gifts WHERE id = $1`, [id]);
    return row;
  };

  it("creates a gift awaiting payment with an open invoice in the purchaser's name", async () => {
    const record = await create();
    expect(record).toMatchObject({
      status: "awaiting_payment",
      planPriceId: priceId,
      durationPeriods: 3,
      invoiceStatus: "open",
      totalCents: 5997,
      currency: "EUR",
    });
    expect(record.invoiceNumber).toMatch(/^INV-\d{6}$/);
    const mine = await createInvoiceRepository(db).listInvoices(purchaser);
    expect(mine.map((i) => i.id)).toEqual([record.invoiceId]);
    expect(await createInvoiceRepository(db).listInvoices(stranger)).toEqual([]);
    const detail = await createInvoiceRepository(db).findInvoice(purchaser, record.invoiceId);
    expect(detail?.lines).toEqual([
      expect.objectContaining({ type: "plan", amountCents: 5997 }),
    ]);
    expect((await giftRow(record.giftId))?.status).toBe("awaiting_payment");
  });

  it("refuses a duplicate idempotency key and finds the original by key", async () => {
    const first = await create("k1", "CODE-AAAAAAAAAAAAAAAAAA");
    await expect(create("k1", "CODE-BBBBBBBBBBBBBBBBBB")).rejects.toBeInstanceOf(DuplicateGiftKeyError);
    expect((await gifts().findByIdempotencyKey(purchaser, "k1"))?.giftId).toBe(first.giftId);
    expect(await gifts().findByIdempotencyKey(stranger, "k1")).toBeNull();
  });

  it("makes the gift usable on payment, valid for 12 months", async () => {
    const record = await create();
    await subs().recordPayment(record.invoiceId, "pi_gift", record.totalCents);
    const paidAt = new Date("2026-10-17T12:30:00Z");
    expect(
      await subs().applyPaymentEvent(evt("e1", "payment.succeeded", "pi_gift"), paidAt),
    ).toBe("applied");
    expect(await giftRow(record.giftId)).toMatchObject({
      status: "pending",
      expires_at: new Date("2027-10-17T12:30:00Z"),
    });
    const [inv] = await db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [
      record.invoiceId,
    ]);
    expect(inv?.status).toBe("paid");
  });

  it("does not create a usable gift when the payment fails", async () => {
    const record = await create();
    await subs().recordPayment(record.invoiceId, "pi_gift", record.totalCents);
    await subs().applyPaymentEvent(evt("e1", "payment.failed", "pi_gift"), t0);
    expect((await giftRow(record.giftId))?.status).toBe("awaiting_payment");
    const [mine] = await gifts().listForPurchaser(purchaser);
    expect(mine).toMatchObject({ status: "awaiting_payment", code: null });
  });

  it("lists a purchaser's gifts with the code only for a usable one, and never other accounts' gifts", async () => {
    await paidGift("k1", "CODE-AAAAAAAAAAAAAAAAAA", "pi_a");
    await create("k2", "CODE-BBBBBBBBBBBBBBBBBB"); // en attente de paiement
    const mine = await gifts().listForPurchaser(purchaser);
    expect(mine.map((g) => [g.status, g.code])).toEqual(
      expect.arrayContaining([
        ["pending", "CODE-AAAAAAAAAAAAAAAAAA"],
        ["awaiting_payment", null],
      ]),
    );
    expect(await gifts().listForPurchaser(stranger)).toEqual([]);
  });

  it("refunds a usable gift: status refunded, payment refunded, code no longer listed", async () => {
    const record = await paidGift();
    expect(
      await subs().applyPaymentEvent(evt("e_ref", "payment.refunded", "pi_gift"), t0),
    ).toBe("applied");
    expect((await giftRow(record.giftId))?.status).toBe("refunded");
    const [pay] = await db.query<{ status: string }>(
      `SELECT status FROM payments WHERE provider_ref = 'pi_gift'`,
    );
    expect(pay?.status).toBe("refunded");
    const [mine] = await gifts().listForPurchaser(purchaser);
    expect(mine).toMatchObject({ status: "refunded", code: null });
    // rejeu du même événement : sans effet
    expect(
      await subs().applyPaymentEvent(evt("e_ref", "payment.refunded", "pi_gift"), t0),
    ).toBe("duplicate");
  });

  it("keeps a redeemed gift redeemed when its payment is refunded (handled out of band)", async () => {
    const record = await paidGift();
    await db.query(`UPDATE gifts SET status = 'redeemed' WHERE id = $1`, [record.giftId]);
    await subs().applyPaymentEvent(evt("e_ref", "payment.refunded", "pi_gift"), t0);
    expect((await giftRow(record.giftId))?.status).toBe("redeemed");
  });

  it("closes unpaid gifts after 24 hours and voids their invoice", async () => {
    const stale = await create("old", "CODE-OLDOLDOLDOLDOLDOLD", { at: new Date("2026-10-15T00:00:00Z") });
    await create("recent", "CODE-NEWNEWNEWNEWNEWNEW", { at: t0 });
    expect(await subs().expirePending(new Date("2026-10-16T12:00:00Z"))).toBe(1);
    expect((await giftRow(stale.giftId))?.status).toBe("expired");
    const [inv] = await db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [
      stale.invoiceId,
    ]);
    expect(inv?.status).toBe("void");
  });

  it("expires usable gifts past their validity", async () => {
    const record = await paidGift();
    expect(await gifts().expireStale(new Date("2027-10-17T12:00:00Z"))).toBe(0); // dernière seconde : encore valable
    expect(await gifts().expireStale(new Date("2027-10-17T12:00:01Z"))).toBe(1);
    expect((await giftRow(record.giftId))?.status).toBe("expired");
    expect(await gifts().expireStale(new Date("2028-01-01T00:00:00Z"))).toBe(0);
  });

  it("gives what is needed to email the recipient exactly once", async () => {
    const record = await paidGift();
    expect(await gifts().findNotification("pi_gift")).toEqual({
      giftId: record.giftId,
      code: "CODE-ABCDEFGHIJKLMNOPQR",
      recipientEmail: "friend@example.test",
      planName: "Pro",
      durationPeriods: 3,
      expiresAt: new Date("2027-10-17T12:00:00Z"),
    });
    await gifts().markNotified(record.giftId, t0);
    expect(await gifts().findNotification("pi_gift")).toBeNull();
    expect((await giftRow(record.giftId))?.notified_at).toEqual(t0);
  });

  it("has nothing to email without a recipient, for an unpaid gift or for a non-gift payment", async () => {
    await paidGift("k1", "CODE-NOMAILNOMAILNOMAIL", "pi_nomail").then(async (r) => {
      await db.query(`UPDATE gifts SET recipient_email = NULL WHERE id = $1`, [r.giftId]);
    });
    expect(await gifts().findNotification("pi_nomail")).toBeNull();

    const unpaid = await create("k2", "CODE-UNPAIDUNPAIDUNPAID");
    await subs().recordPayment(unpaid.invoiceId, "pi_unpaid", unpaid.totalCents);
    expect(await gifts().findNotification("pi_unpaid")).toBeNull();
    expect(await gifts().findNotification("pi_unknown")).toBeNull();
  });
});
