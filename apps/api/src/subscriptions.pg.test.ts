import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type PgDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";
import type { PaymentEvent } from "./payments.js";
import { createInvoiceRepository } from "./invoices.pg.js";
import {
  DuplicateIdempotencyKeyError,
  LiveSubscriptionExistsError,
} from "./subscriptions.js";
import { createSubscriptionRepository } from "./subscriptions.pg.js";

// Test d'intégration : exécuté seulement si TEST_DATABASE_URL pointe vers une base jetable
// (ses tables sont vidées à chaque test). Ex. : postgres://postgres:local@127.0.0.1:55432/t
const url = process.env.TEST_DATABASE_URL;

const evt = (
  id: string,
  type: PaymentEvent["type"],
  providerRef: string,
): PaymentEvent => ({ id, type, providerRef });

describe.skipIf(!url)("subscription repository (Postgres)", () => {
  let db: PgDatabase;
  let priceId: string;
  const accountId = "00000000-0000-4000-8000-0000000000aa";
  const t0 = new Date("2026-10-17T12:00:00Z");

  beforeAll(async () => {
    db = createDatabase(url ?? "");
    await runMigrations(
      db,
      fileURLToPath(new URL("../migrations", import.meta.url)),
    );
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.query(
      `TRUNCATE payment_events, payments, invoice_lines, invoices, subscriptions,
         plan_entitlements, entitlements, plan_prices, plans, accounts CASCADE`,
    );
    await db.query(`INSERT INTO accounts (id, email) VALUES ($1, 'a@example.test')`, [
      accountId,
    ]);
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

  const create = (key = "k1", at = t0) =>
    createSubscriptionRepository(db).createPending({
      accountId,
      planPriceId: priceId,
      idempotencyKey: key,
      amountCents: 1999,
      currency: "EUR",
      interval: "month",
      now: at,
    });

  it("creates a pending subscription with an open invoice and one line", async () => {
    const record = await create();
    expect(record).toMatchObject({
      status: "pending",
      planPriceId: priceId,
      totalCents: 1999,
      currency: "EUR",
    });
    expect(record.invoiceNumber).toMatch(/^INV-\d{6}$/);
    const [inv] = await db.query<{ status: string; lines: number }>(
      `SELECT i.status, (SELECT count(*)::int FROM invoice_lines l WHERE l.invoice_id = i.id) AS lines
       FROM invoices i WHERE i.id = $1`,
      [record.invoiceId],
    );
    expect(inv).toEqual({ status: "open", lines: 1 });
  });

  it("refuses a second live subscription for the same account", async () => {
    await create("k1");
    await expect(create("k2")).rejects.toBeInstanceOf(LiveSubscriptionExistsError);
  });

  it("refuses a duplicate idempotency key and finds the original by key", async () => {
    const repo = createSubscriptionRepository(db);
    const first = await create("k1", new Date("2026-10-15T00:00:00Z"));
    // Tant que `first` est vivant, Postgres signale l'index « un seul abonnement vivant » ; on
    // l'expire pour isoler la violation de la clé d'idempotence.
    await repo.expirePending(new Date("2026-10-16T00:00:00Z"));
    await expect(create("k1")).rejects.toBeInstanceOf(DuplicateIdempotencyKeyError);
    const found = await repo.findByIdempotencyKey(accountId, "k1");
    expect(found?.subscriptionId).toBe(first.subscriptionId);
  });

  it("activates on payment: period starts at the payment date, invoice paid, idempotent", async () => {
    const repo = createSubscriptionRepository(db);
    const record = await create();
    await repo.recordPayment(record.invoiceId, "pi_1", 1999);
    await repo.recordPayment(record.invoiceId, "pi_1", 1999); // rejeu : sans effet
    const paidAt = new Date("2026-10-17T12:30:00Z");

    expect(await repo.applyPaymentEvent(evt("e1", "payment.succeeded", "pi_1"), paidAt)).toBe("applied");
    // même événement rejoué : sans effet ; autre événement sur un paiement déjà traité : sans correspondance
    expect(await repo.applyPaymentEvent(evt("e1", "payment.succeeded", "pi_1"), paidAt)).toBe("duplicate");
    expect(await repo.applyPaymentEvent(evt("e2", "payment.succeeded", "pi_1"), paidAt)).toBe("unmatched");

    const [sub] = await db.query<{
      status: string;
      start: Date;
      end: Date;
    }>(
      `SELECT status, current_period_start AS start, current_period_end AS "end"
       FROM subscriptions WHERE id = $1`,
      [record.subscriptionId],
    );
    expect(sub?.status).toBe("active");
    expect(sub?.start).toEqual(paidAt);
    expect(sub?.end).toEqual(new Date("2026-11-17T12:30:00Z"));
    const [inv] = await db.query<{ status: string; paid_at: Date }>(
      `SELECT status, paid_at FROM invoices WHERE id = $1`,
      [record.invoiceId],
    );
    expect(inv).toEqual({ status: "paid", paid_at: paidAt });
  });

  it("expires stale pending subscriptions, voids the invoice and ignores late payments", async () => {
    const repo = createSubscriptionRepository(db);
    const stale = await create("old", new Date("2026-10-15T00:00:00Z"));
    await repo.recordPayment(stale.invoiceId, "pi_old", 1999);

    expect(await repo.expirePending(new Date("2026-10-16T12:00:00Z"))).toBe(1);

    const [sub] = await db.query<{ status: string }>(
      `SELECT status FROM subscriptions WHERE id = $1`,
      [stale.subscriptionId],
    );
    const [inv] = await db.query<{ status: string }>(
      `SELECT status FROM invoices WHERE id = $1`,
      [stale.invoiceId],
    );
    expect(sub?.status).toBe("expired");
    expect(inv?.status).toBe("void");
    expect(await repo.applyPaymentEvent(evt("e3", "payment.succeeded", "pi_old"), t0)).toBe("unmatched");
    // le compte peut de nouveau souscrire
    await expect(create("new")).resolves.toMatchObject({ status: "pending" });
  });

  it("keeps recent pending subscriptions", async () => {
    await create("recent", t0);
    expect(
      await createSubscriptionRepository(db).expirePending(
        new Date("2026-10-16T12:00:00Z"),
      ),
    ).toBe(0);
  });

  it("records a webhook event once and applies its effect once", async () => {
    const repo = createSubscriptionRepository(db);
    const record = await create();
    await repo.recordPayment(record.invoiceId, "pi_1", 1999);
    await repo.applyPaymentEvent(evt("evt_a", "payment.succeeded", "pi_1"), t0);
    await repo.applyPaymentEvent(evt("evt_a", "payment.succeeded", "pi_1"), t0);
    const events = await db.query<{ provider_event_id: string }>(
      `SELECT provider_event_id FROM payment_events`,
    );
    expect(events).toEqual([{ provider_event_id: "evt_a" }]);
  });

  it("moves an active subscription to past_due when its payment fails, keeping the invoice open", async () => {
    const repo = createSubscriptionRepository(db);
    const record = await create();
    await repo.recordPayment(record.invoiceId, "pi_1", 1999);
    await repo.applyPaymentEvent(evt("e1", "payment.succeeded", "pi_1"), t0);
    // renouvellement : nouvelle facture ouverte + paiement
    const [renewal] = await db.query<{ id: string }>(
      `INSERT INTO invoices (account_id, subscription_id, number, status, total_cents, currency, issued_at)
       VALUES ($1, $2, 'INV-RENEW', 'open', 1999, 'EUR', $3) RETURNING id`,
      [accountId, record.subscriptionId, t0],
    );
    await repo.recordPayment(renewal?.id ?? "", "pi_2", 1999);

    expect(await repo.applyPaymentEvent(evt("e2", "payment.failed", "pi_2"), t0)).toBe("applied");

    const [sub] = await db.query<{ status: string }>(
      `SELECT status FROM subscriptions WHERE id = $1`,
      [record.subscriptionId],
    );
    const [pay] = await db.query<{ status: string }>(
      `SELECT status FROM payments WHERE provider_ref = 'pi_2'`,
    );
    expect(sub?.status).toBe("past_due");
    expect(pay?.status).toBe("failed");
  });

  it("keeps a pending subscription pending when its first payment fails (the customer can retry)", async () => {
    const repo = createSubscriptionRepository(db);
    const record = await create();
    await repo.recordPayment(record.invoiceId, "pi_1", 1999);
    expect(await repo.applyPaymentEvent(evt("e1", "payment.failed", "pi_1"), t0)).toBe("applied");
    const [sub] = await db.query<{ status: string }>(
      `SELECT status FROM subscriptions WHERE id = $1`,
      [record.subscriptionId],
    );
    expect(sub?.status).toBe("pending");
  });

  it("reports an unknown payment as unmatched but still records the event", async () => {
    const repo = createSubscriptionRepository(db);
    expect(await repo.applyPaymentEvent(evt("e9", "payment.succeeded", "pi_nope"), t0)).toBe("unmatched");
    expect(await repo.applyPaymentEvent(evt("e9", "payment.succeeded", "pi_nope"), t0)).toBe("duplicate");
  });

  it("forbids editing a non-draft invoice and its lines, but allows status changes", async () => {
    const record = await create();
    await expect(
      db.query(`UPDATE invoices SET total_cents = 1 WHERE id = $1`, [record.invoiceId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`UPDATE invoice_lines SET amount_cents = 1 WHERE invoice_id = $1`, [record.invoiceId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`DELETE FROM invoice_lines WHERE invoice_id = $1`, [record.invoiceId]),
    ).rejects.toThrow(/immutable/);
    await expect(
      db.query(`DELETE FROM invoices WHERE id = $1`, [record.invoiceId]),
    ).rejects.toThrow(/immutable/);
    await db.query(`UPDATE invoices SET status = 'void' WHERE id = $1`, [record.invoiceId]);
  });

  it("lists invoices of one account only and hides other accounts' invoices", async () => {
    const invoices = createInvoiceRepository(db);
    const record = await create();
    const other = "00000000-0000-4000-8000-0000000000bb";
    await db.query(`INSERT INTO accounts (id, email) VALUES ($1, 'b@example.test')`, [other]);

    const mine = await invoices.listInvoices(accountId);
    expect(mine.map((i) => i.id)).toEqual([record.invoiceId]);
    expect(mine[0]).toMatchObject({ status: "open", totalCents: 1999, currency: "EUR", paidAt: null });
    expect(await invoices.listInvoices(other)).toEqual([]);

    const detail = await invoices.findInvoice(accountId, record.invoiceId);
    expect(detail?.lines).toEqual([
      { type: "plan", description: "Abonnement", amountCents: 1999, periodStart: null, periodEnd: null },
    ]);
    expect(await invoices.findInvoice(other, record.invoiceId)).toBeNull();
  });
});
