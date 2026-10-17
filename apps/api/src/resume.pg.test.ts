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

describe.skipIf(!url)("resume (Postgres)", () => {
  let db: PgDatabase;
  let proId: string;
  let basicId: string;
  const accountId = "00000000-0000-4000-8000-0000000000aa";
  const t0 = new Date("2026-10-17T12:00:00Z");
  const pausedAt = new Date("2026-10-20T00:00:00Z");
  const resumeAt = new Date("2026-11-10T00:00:00Z");
  const resumeNow = new Date("2026-11-10T00:00:05Z");

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

  /** Abonné Pro, payé le 17/10, mis en pause le 20/10 jusqu'au 10/11. */
  async function pausedSubscription() {
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
    await repo().pause({ subscriptionId: record.subscriptionId, now: pausedAt, resumeAt });
    return record.subscriptionId;
  }

  const sub = async (id: string) => {
    const [row] = await db.query<{
      status: string;
      plan_price_id: string;
      paused_at: Date | null;
      resume_at: Date | null;
      start: Date;
      end: Date;
    }>(
      `SELECT status, plan_price_id, paused_at, resume_at,
              current_period_start AS start, current_period_end AS "end"
       FROM subscriptions WHERE id = $1`,
      [id],
    );
    return row;
  };

  it("reactivates from now with a new period, an open invoice and a journal entry", async () => {
    const id = await pausedSubscription();
    const result = await repo().resume({ subscriptionId: id, now: resumeNow });
    expect(result).toMatchObject({ accountId, totalCents: 1999, currency: "EUR" });

    const after = await sub(id);
    expect(after).toMatchObject({ status: "active", plan_price_id: proId, paused_at: null, resume_at: null });
    expect(after?.start).toEqual(resumeNow);
    expect(after?.end).toEqual(new Date("2026-12-10T00:00:05Z"));

    const [inv] = await db.query<{ status: string; is_resume: boolean; period_start: Date | null }>(
      `SELECT i.status, i.is_resume,
              (SELECT l.period_start FROM invoice_lines l WHERE l.invoice_id = i.id) AS period_start
       FROM invoices i WHERE i.id = $1`,
      [result?.invoiceId],
    );
    expect(inv).toEqual({ status: "open", is_resume: true, period_start: resumeNow });
    const events = await db.query<{ type: string }>(
      `SELECT type FROM subscription_events WHERE subscription_id = $1 ORDER BY created_at`,
      [id],
    );
    expect(events.map((e) => e.type)).toEqual(["paused", "resumed"]);
  });

  it("returns null and changes nothing when the subscription is not paused (job run twice)", async () => {
    const id = await pausedSubscription();
    expect(await repo().resume({ subscriptionId: id, now: resumeNow })).not.toBeNull();
    expect(await repo().resume({ subscriptionId: id, now: resumeNow })).toBeNull();
    const [count] = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM invoices WHERE subscription_id = $1 AND is_resume`,
      [id],
    );
    expect(count?.n).toBe(1);
  });

  it("applies a scheduled downgrade when resuming (a new period starts)", async () => {
    const id = await pausedSubscription();
    await db.query(`UPDATE subscriptions SET pending_plan_price_id = $2 WHERE id = $1`, [id, basicId]);
    const result = await repo().resume({ subscriptionId: id, now: resumeNow });
    expect(result?.totalCents).toBe(999);
    const after = await sub(id);
    expect(after?.plan_price_id).toBe(basicId);
    const [pending] = await db.query<{ pending: string | null }>(
      `SELECT pending_plan_price_id AS pending FROM subscriptions WHERE id = $1`,
      [id],
    );
    expect(pending?.pending).toBeNull();
  });

  it("lists paused subscriptions whose resume date has passed", async () => {
    const id = await pausedSubscription();
    expect(await repo().listDueResumes(new Date("2026-11-09T23:59:59Z"), 10)).toEqual([]);
    expect(await repo().listDueResumes(resumeNow, 10)).toEqual([id]);
    await repo().resume({ subscriptionId: id, now: resumeNow });
    expect(await repo().listDueResumes(resumeNow, 10)).toEqual([]);
  });

  it("settles the resume invoice on payment without moving the new period", async () => {
    const id = await pausedSubscription();
    const result = await repo().resume({ subscriptionId: id, now: resumeNow });
    await repo().recordPayment(result?.invoiceId ?? "", "pi_resume", 1999);

    const paidAt = new Date("2026-11-10T00:10:00Z");
    expect(
      await repo().applyPaymentEvent(evt("e_resume", "payment.succeeded", "pi_resume"), paidAt),
    ).toBe("applied");

    const after = await sub(id);
    expect(after?.status).toBe("active");
    expect(after?.start).toEqual(resumeNow);
    const [inv] = await db.query<{ status: string }>(`SELECT status FROM invoices WHERE id = $1`, [
      result?.invoiceId,
    ]);
    expect(inv?.status).toBe("paid");
  });

  it("moves the subscription to past_due when the resume payment fails, and recovers on retry", async () => {
    const id = await pausedSubscription();
    const result = await repo().resume({ subscriptionId: id, now: resumeNow });
    await repo().recordPayment(result?.invoiceId ?? "", "pi_resume", 1999);

    expect(
      await repo().applyPaymentEvent(evt("e_fail", "payment.failed", "pi_resume"), resumeNow),
    ).toBe("applied");
    expect((await sub(id))?.status).toBe("past_due");

    expect(
      await repo().applyPaymentEvent(evt("e_ok", "payment.succeeded", "pi_resume"), resumeNow),
    ).toBe("applied");
    const recovered = await sub(id);
    expect(recovered?.status).toBe("active");
    expect(recovered?.start).toEqual(resumeNow);
  });
});
