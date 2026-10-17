import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createCatalogRepository } from "./catalog.pg.js";
import { createDatabase, type PgDatabase } from "./db.js";
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

describe.skipIf(!url)("cancellation (Postgres)", () => {
  let db: PgDatabase;
  let proId: string;
  let basicId: string;
  const accountId = "00000000-0000-4000-8000-0000000000aa";
  const t0 = new Date("2026-10-17T12:00:00Z");
  const periodEnd = new Date("2026-11-17T12:00:00Z");
  const afterEnd = new Date("2026-11-17T12:05:00Z");

  beforeAll(async () => {
    db = createDatabase(url ?? "");
    await runMigrations(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.query(
      `TRUNCATE subscription_events, payment_events, payments, invoice_lines, invoices,
         subscriptions, plan_entitlements, entitlements, plan_prices, plans, accounts CASCADE`,
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
    basicId = await price("basic", 1, 999);
    proId = await price("pro", 2, 1999);
  });

  const repo = () => createSubscriptionRepository(db);

  /** Abonné Pro actif du 17/10 au 17/11. */
  async function activeSubscription() {
    const record = await repo().createPending({
      accountId,
      planPriceId: proId,
      idempotencyKey: "first",
      amountCents: 1999,
      currency: "EUR",
      interval: "month",
      now: t0,
    });
    await repo().recordPayment(record.invoiceId, "pi_first", 1999);
    await repo().applyPaymentEvent(evt("e_first", "payment.succeeded", "pi_first"), t0);
    return record.subscriptionId;
  }

  const sub = async (id: string) => {
    const [row] = await db.query<{
      status: string;
      cancel: boolean;
      pending: string | null;
      paused_at: Date | null;
    }>(
      `SELECT status, cancel_at_period_end AS cancel, pending_plan_price_id AS pending, paused_at
       FROM subscriptions WHERE id = $1`,
      [id],
    );
    return row;
  };

  const eventTypes = async (id: string) =>
    (
      await db.query<{ type: string }>(
        `SELECT type FROM subscription_events WHERE subscription_id = $1 ORDER BY created_at, type`,
        [id],
      )
    ).map((e) => e.type);

  it("schedules a cancellation once: rights stay, one journal entry, no second write", async () => {
    const id = await activeSubscription();
    expect(await repo().scheduleCancellation({ subscriptionId: id, now: t0 })).toBe(true);
    expect(await repo().scheduleCancellation({ subscriptionId: id, now: t0 })).toBe(false);
    expect(await sub(id)).toMatchObject({ status: "active", cancel: true });
    expect(await eventTypes(id)).toEqual(["cancel_scheduled"]);

    const found = await createCatalogRepository(db).findSubscription(accountId);
    expect(found).toMatchObject({ status: "active", cancelAtPeriodEnd: true, currentPeriodEnd: periodEnd });
  });

  it("revokes a scheduled cancellation only when one is scheduled", async () => {
    const id = await activeSubscription();
    expect(await repo().revokeCancellation({ subscriptionId: id, now: t0 })).toBe(false);
    await repo().scheduleCancellation({ subscriptionId: id, now: t0 });
    expect(await repo().revokeCancellation({ subscriptionId: id, now: t0 })).toBe(true);
    expect(await sub(id)).toMatchObject({ status: "active", cancel: false });
    expect(await eventTypes(id)).toEqual(["cancel_revoked", "cancel_scheduled"]);
  });

  it("cancels a paused subscription immediately and closes what was awaiting payment", async () => {
    const id = await activeSubscription();
    await repo().pause({ subscriptionId: id, now: t0, resumeAt: periodEnd });
    // facture de reprise ouverte (reprise faite puis ré-pause impossible : on simule une facture ouverte)
    await db.query(
      `INSERT INTO invoices (account_id, subscription_id, number, status, total_cents, currency, issued_at)
       VALUES ($1, $2, 'INV-OPEN', 'open', 1999, 'EUR', $3)`,
      [accountId, id, t0],
    );
    expect(await repo().cancelNow({ subscriptionId: id, now: afterEnd })).toBe(true);
    expect(await sub(id)).toMatchObject({ status: "canceled", paused_at: null });
    const [inv] = await db.query<{ status: string }>(
      `SELECT status FROM invoices WHERE number = 'INV-OPEN'`,
    );
    expect(inv?.status).toBe("void");
    expect(await eventTypes(id)).toEqual(["paused", "canceled"]);
    // le compte peut de nouveau souscrire
    await expect(
      repo().createPending({
        accountId,
        planPriceId: proId,
        idempotencyKey: "again",
        amountCents: 1999,
        currency: "EUR",
        interval: "month",
        now: afterEnd,
      }),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("cancels a past_due subscription immediately but never an active one", async () => {
    const id = await activeSubscription();
    expect(await repo().cancelNow({ subscriptionId: id, now: t0 })).toBe(false);
    expect((await sub(id))?.status).toBe("active");
    await db.query(`UPDATE subscriptions SET status = 'past_due' WHERE id = $1`, [id]);
    expect(await repo().cancelNow({ subscriptionId: id, now: t0 })).toBe(true);
    expect((await sub(id))?.status).toBe("canceled");
  });

  it("closes subscriptions whose scheduled cancellation has reached the period end", async () => {
    const id = await activeSubscription();
    await repo().scheduleCancellation({ subscriptionId: id, now: t0 });
    await repo().scheduleDowngrade(id, basicId);

    expect(await repo().closeEnded(new Date("2026-11-17T11:59:59Z"))).toBe(0); // pas encore échu
    expect(await repo().closeEnded(afterEnd)).toBe(1);
    expect(await repo().closeEnded(afterEnd)).toBe(0); // rejouable
    expect(await sub(id)).toMatchObject({ status: "canceled", pending: null });
    expect(await eventTypes(id)).toEqual(["cancel_scheduled", "canceled"]);
    const [ev] = await db.query<{ data: { reason: string } }>(
      `SELECT data FROM subscription_events WHERE subscription_id = $1 AND type = 'canceled'`,
      [id],
    );
    expect(ev?.data).toEqual({ reason: "period_end" });
  });

  it("does not close a subscription without a scheduled cancellation, and never renews a cancelled one", async () => {
    const id = await activeSubscription();
    expect(await repo().closeEnded(afterEnd)).toBe(0);
    expect((await sub(id))?.status).toBe("active");

    await repo().scheduleCancellation({ subscriptionId: id, now: t0 });
    expect(await repo().listDueRenewals(afterEnd, 10)).toEqual([]);
  });

  it("voids an open renewal invoice when the subscription is closed at period end", async () => {
    const id = await activeSubscription();
    const [renewal] = await db.query<{ id: string }>(
      `INSERT INTO invoices (account_id, subscription_id, number, status, total_cents, currency,
                             issued_at, is_renewal)
       VALUES ($1, $2, 'INV-RENEW', 'open', 1999, 'EUR', $3, true) RETURNING id`,
      [accountId, id, afterEnd],
    );
    await repo().recordPayment(renewal?.id ?? "", "pi_renew", 1999);
    await repo().scheduleCancellation({ subscriptionId: id, now: t0 });
    expect(await repo().closeEnded(afterEnd)).toBe(1);
    const [inv] = await db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [
      renewal?.id,
    ]);
    expect(inv?.status).toBe("void");
    // un paiement tardif ne réactive rien
    expect(
      await repo().applyPaymentEvent(evt("e_late", "payment.succeeded", "pi_renew"), afterEnd),
    ).toBe("unmatched");
    expect((await sub(id))?.status).toBe("canceled");
  });
});
