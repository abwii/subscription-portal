import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type PgDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";
import {
  DuplicateIdempotencyKeyError,
  LiveSubscriptionExistsError,
} from "./subscriptions.js";
import { createSubscriptionRepository } from "./subscriptions.pg.js";

// Test d'intégration : exécuté seulement si TEST_DATABASE_URL pointe vers une base jetable
// (ses tables sont vidées à chaque test). Ex. : postgres://postgres:local@127.0.0.1:55432/t
const url = process.env.TEST_DATABASE_URL;

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
      `TRUNCATE payments, invoice_lines, invoices, subscriptions,
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

    expect(await repo.activateByProviderRef("pi_1", paidAt)).toBe(true);
    expect(await repo.activateByProviderRef("pi_1", paidAt)).toBe(false);

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
    expect(await repo.activateByProviderRef("pi_old", t0)).toBe(false);
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
});
