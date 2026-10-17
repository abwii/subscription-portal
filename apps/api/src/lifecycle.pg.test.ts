import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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

describe.skipIf(!url)("pause (Postgres)", () => {
  let db: PgDatabase;
  let priceId: string;
  const accountId = "00000000-0000-4000-8000-0000000000aa";
  const t0 = new Date("2026-10-17T12:00:00Z");
  const resumeAt = new Date("2026-11-10T00:00:00Z");

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

  const repo = () => createSubscriptionRepository(db);

  async function activeSubscription() {
    const record = await repo().createPending({
      accountId,
      planPriceId: priceId,
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
      paused_at: Date | null;
      resume_at: Date | null;
      start: Date;
      end: Date;
    }>(
      `SELECT status, paused_at, resume_at, current_period_start AS start, current_period_end AS "end"
       FROM subscriptions WHERE id = $1`,
      [id],
    );
    return row;
  };

  const events = (id: string) =>
    db.query<{ type: string; data: Record<string, unknown> }>(
      `SELECT type, data FROM subscription_events WHERE subscription_id = $1 ORDER BY created_at`,
      [id],
    );

  it("pauses an active subscription and records the event", async () => {
    const id = await activeSubscription();
    const before = await sub(id);
    const pausedAt = new Date("2026-10-20T00:00:00Z");

    expect(await repo().pause({ subscriptionId: id, now: pausedAt, resumeAt })).toBe(true);

    const after = await sub(id);
    expect(after).toMatchObject({ status: "paused", paused_at: pausedAt, resume_at: resumeAt });
    expect(after?.end).toEqual(before?.end);
    expect(await events(id)).toEqual([
      { type: "paused", data: { resumeAt: resumeAt.toISOString() } },
    ]);
  });

  it("refuses to pause a subscription that is not active", async () => {
    const id = await activeSubscription();
    await db.query(`UPDATE subscriptions SET status = 'past_due' WHERE id = $1`, [id]);
    expect(await repo().pause({ subscriptionId: id, now: t0, resumeAt })).toBe(false);
    expect((await sub(id))?.status).toBe("past_due");
    expect(await events(id)).toEqual([]);
  });

  it("refuses to pause while a renewal or plan change awaits payment", async () => {
    const id = await activeSubscription();
    await db.query(
      `INSERT INTO invoices (account_id, subscription_id, number, status, total_cents, currency,
                             issued_at, is_renewal)
       VALUES ($1, $2, 'INV-OPEN', 'open', 1999, 'EUR', $3, true)`,
      [accountId, id, t0],
    );
    expect(await repo().pause({ subscriptionId: id, now: t0, resumeAt })).toBe(false);
    expect((await sub(id))?.status).toBe("active");
  });

  it("counts the pauses of a subscription since a date", async () => {
    const id = await activeSubscription();
    expect(await repo().countPausesSince(id, new Date("2025-10-17T00:00:00Z"))).toBe(0);
    await repo().pause({ subscriptionId: id, now: new Date("2026-10-20T00:00:00Z"), resumeAt });
    expect(await repo().countPausesSince(id, new Date("2025-10-21T00:00:00Z"))).toBe(1);
    expect(await repo().countPausesSince(id, new Date("2026-10-21T00:00:00Z"))).toBe(0);
  });
});
