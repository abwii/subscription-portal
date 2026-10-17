import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type PgDatabase } from "./db.js";
import { runMigrations } from "./migrate.js";
import { ChangeInProgressError } from "./plan-changes.js";
import type { PaymentEvent } from "./payments.js";
import type { UpgradeQuote } from "./proration.js";
import { DuplicateIdempotencyKeyError } from "./subscriptions.js";
import { createSubscriptionRepository } from "./subscriptions.pg.js";

// Test d'intégration : voir subscriptions.pg.test.ts (base jetable, TEST_DATABASE_URL).
const url = process.env.TEST_DATABASE_URL;

const evt = (id: string, type: PaymentEvent["type"], providerRef: string): PaymentEvent => ({
  id,
  type,
  providerRef,
});

describe.skipIf(!url)("plan changes (Postgres)", () => {
  let db: PgDatabase;
  let basicPriceId: string;
  let monthId: string;
  let yearId: string;
  const accountId = "00000000-0000-4000-8000-0000000000aa";
  const t0 = new Date("2026-10-17T12:00:00Z");
  const quote: UpgradeQuote = {
    lines: [
      { type: "proration_credit", description: "Crédit", amountCents: -500 },
      { type: "proration_charge", description: "Nouveau plan", amountCents: 1000 },
    ],
    totalCents: 500,
    startsNewPeriod: false,
  };

  beforeAll(async () => {
    db = createDatabase(url ?? "");
    await runMigrations(db, fileURLToPath(new URL("../migrations", import.meta.url)));
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(async () => {
    await db.query(
      `TRUNCATE payment_events, payments, invoice_lines, invoices, subscriptions,
         plan_entitlements, entitlements, plan_prices, plans, accounts CASCADE`,
    );
    await db.query(`INSERT INTO accounts (id, email) VALUES ($1, 'a@example.test')`, [accountId]);
    const insertPlan = async (code: string, rank: number) => {
      const [plan] = await db.query<{ id: string }>(
        `INSERT INTO plans (code, name, rank) VALUES ($1, $1, $2) RETURNING id`,
        [code, rank],
      );
      return plan?.id ?? "";
    };
    const insertPrice = async (planId: string, interval: string, cents: number) => {
      const [price] = await db.query<{ id: string }>(
        `INSERT INTO plan_prices (plan_id, "interval", amount_cents, currency)
         VALUES ($1, $2, $3, 'EUR') RETURNING id`,
        [planId, interval, cents],
      );
      return price?.id ?? "";
    };
    const basic = await insertPlan("basic", 1);
    const max = await insertPlan("max", 2);
    basicPriceId = await insertPrice(basic, "month", 1999);
    monthId = await insertPrice(max, "month", 3999);
    yearId = await insertPrice(max, "year", 39900);
  });

  const repo = () => createSubscriptionRepository(db);

  async function activeSubscription() {
    const record = await repo().createPending({
      accountId,
      planPriceId: basicPriceId,
      idempotencyKey: "first",
      amountCents: 1999,
      currency: "EUR",
      interval: "month",
      now: t0,
    });
    await repo().recordPayment(record.invoiceId, "pi_first", 1999);
    await repo().applyPaymentEvent(evt("e_first", "payment.succeeded", "pi_first"), t0);
    return record;
  }

  const change = (
    subscriptionId: string,
    targetPlanPriceId: string,
    key = "c1",
    q = quote,
    at = new Date("2026-10-25T00:00:00Z"),
  ) =>
    repo().createChangeInvoice({
      accountId,
      subscriptionId,
      targetPlanPriceId,
      idempotencyKey: key,
      quote: q,
      currency: "EUR",
      now: at,
    });

  const subRow = async (id: string) => {
    const [row] = await db.query<{
      status: string;
      plan_price_id: string;
      start: Date;
      end: Date;
    }>(
      `SELECT status, plan_price_id, current_period_start AS start, current_period_end AS "end"
       FROM subscriptions WHERE id = $1`,
      [id],
    );
    return row;
  };

  it("reads what is needed to quote a change, only for the owner", async () => {
    const record = await activeSubscription();
    const found = await repo().findSubscriptionForChange(accountId, record.subscriptionId);
    expect(found).toMatchObject({
      id: record.subscriptionId,
      status: "active",
      planPriceId: basicPriceId,
      rank: 1,
      interval: "month",
      amountCents: 1999,
      currency: "EUR",
      periodStart: t0,
    });
    expect(
      await repo().findSubscriptionForChange(
        "00000000-0000-4000-8000-0000000000cc",
        record.subscriptionId,
      ),
    ).toBeNull();
  });

  it("creates an open change invoice with its lines, and finds it by key", async () => {
    const record = await activeSubscription();
    const created = await change(record.subscriptionId, monthId);
    expect(created).toMatchObject({
      invoiceStatus: "open",
      totalCents: 500,
      currency: "EUR",
      subscriptionId: record.subscriptionId,
      targetPlanPriceId: monthId,
    });
    expect(created.lines.map((l) => l.amountCents)).toEqual([-500, 1000]);
    const found = await repo().findChangeByIdempotencyKey(accountId, "c1");
    expect(found?.invoiceId).toBe(created.invoiceId);
    expect(found?.lines.map((l) => l.type)).toEqual(["proration_credit", "proration_charge"]);
  });

  it("allows a single open change per subscription and a single use of a key", async () => {
    const record = await activeSubscription();
    await change(record.subscriptionId, monthId, "c1");
    await expect(change(record.subscriptionId, yearId, "c2")).rejects.toBeInstanceOf(
      ChangeInProgressError,
    );
    await expect(change(record.subscriptionId, monthId, "c1")).rejects.toBeInstanceOf(
      DuplicateIdempotencyKeyError,
    );
  });

  it("switches the plan on payment and keeps the period end unchanged", async () => {
    const record = await activeSubscription();
    const before = await subRow(record.subscriptionId);
    const created = await change(record.subscriptionId, monthId);
    await repo().recordPayment(created.invoiceId, "pi_change", 500);

    const paidAt = new Date("2026-10-25T00:05:00Z");
    expect(
      await repo().applyPaymentEvent(evt("e_change", "payment.succeeded", "pi_change"), paidAt),
    ).toBe("applied");

    const after = await subRow(record.subscriptionId);
    expect(after?.status).toBe("active");
    expect(after?.plan_price_id).toBe(monthId);
    expect(after?.start).toEqual(before?.start);
    expect(after?.end).toEqual(before?.end);
    const [inv] = await db.query<{ status: string }>(
      `SELECT status FROM invoices WHERE id = $1`,
      [created.invoiceId],
    );
    expect(inv?.status).toBe("paid");
  });

  it("starts a new yearly period when switching from monthly to yearly", async () => {
    const record = await activeSubscription();
    const created = await change(record.subscriptionId, yearId, "c1", {
      lines: [
        { type: "proration_credit", description: "Crédit", amountCents: -500 },
        { type: "plan", description: "Abonnement annuel", amountCents: 39900 },
      ],
      totalCents: 39400,
      startsNewPeriod: true,
    });
    await repo().recordPayment(created.invoiceId, "pi_year", 39400);
    const paidAt = new Date("2026-10-25T00:05:00Z");
    await repo().applyPaymentEvent(evt("e_year", "payment.succeeded", "pi_year"), paidAt);

    const after = await subRow(record.subscriptionId);
    expect(after?.plan_price_id).toBe(yearId);
    expect(after?.start).toEqual(paidAt);
    expect(after?.end).toEqual(new Date("2027-10-25T00:05:00Z"));
  });

  it("keeps the old plan and an active subscription when the change payment fails, and still accepts a retry", async () => {
    const record = await activeSubscription();
    const created = await change(record.subscriptionId, monthId);
    await repo().recordPayment(created.invoiceId, "pi_change", 500);

    expect(
      await repo().applyPaymentEvent(evt("e_fail", "payment.failed", "pi_change"), t0),
    ).toBe("applied");
    const failed = await subRow(record.subscriptionId);
    expect(failed?.status).toBe("active");
    expect(failed?.plan_price_id).toBe(basicPriceId);

    // le client retente avec le même PaymentIntent et réussit
    expect(
      await repo().applyPaymentEvent(evt("e_ok", "payment.succeeded", "pi_change"), t0),
    ).toBe("applied");
    expect((await subRow(record.subscriptionId))?.plan_price_id).toBe(monthId);
  });

  it("voids a stale change invoice so a new change can be requested", async () => {
    const record = await activeSubscription();
    const stale = await change(
      record.subscriptionId,
      monthId,
      "c1",
      quote,
      new Date("2026-10-20T00:00:00Z"),
    );
    await repo().recordPayment(stale.invoiceId, "pi_stale", 500);

    expect(await repo().expirePending(new Date("2026-10-21T00:00:00Z"))).toBe(1);

    const [inv] = await db.query<{ status: string }>(
      `SELECT status FROM invoices WHERE id = $1`,
      [stale.invoiceId],
    );
    expect(inv?.status).toBe("void");
    expect((await subRow(record.subscriptionId))?.status).toBe("active");
    await expect(change(record.subscriptionId, monthId, "c2")).resolves.toMatchObject({
      invoiceStatus: "open",
    });
  });
});
