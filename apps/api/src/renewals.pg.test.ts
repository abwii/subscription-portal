import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, type PgDatabase } from "./db.js";
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

describe.skipIf(!url)("downgrades and renewals (Postgres)", () => {
  let db: PgDatabase;
  let basicId: string;
  let proId: string;
  let maxId: string;
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
      `TRUNCATE subscription_events, payment_events, payments, invoice_lines, invoices, subscriptions,
         plan_entitlements, entitlements, plan_prices, plans, accounts CASCADE`,
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
    maxId = await price("max", 3, 3999);
  });

  const repo = () => createSubscriptionRepository(db);

  /** Abonné Pro actif du 17/10 au 17/11. */
  async function proSubscription() {
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
      plan_price_id: string;
      pending: string | null;
      start: Date;
      end: Date;
    }>(
      `SELECT status, plan_price_id, pending_plan_price_id AS pending,
              current_period_start AS start, current_period_end AS "end"
       FROM subscriptions WHERE id = $1`,
      [id],
    );
    return row;
  };

  async function renewal(subscriptionId: string, ref: string) {
    const [due] = await repo().listDueRenewals(afterEnd, 10);
    const invoice = await repo().createRenewalInvoice({
      subscriptionId,
      accountId,
      planPriceId: due?.planPriceId ?? "",
      amountCents: due?.amountCents ?? 0,
      currency: "EUR",
      interval: "month",
      periodStart: due?.periodEnd ?? periodEnd,
      now: afterEnd,
    });
    await repo().recordPayment(invoice?.invoiceId ?? "", ref, invoice?.totalCents ?? 0);
    return invoice;
  }

  it("schedules and clears a downgrade", async () => {
    const id = await proSubscription();
    await repo().scheduleDowngrade(id, basicId);
    expect((await sub(id))?.pending).toBe(basicId);
    const found = await repo().findSubscriptionForChange(accountId, id);
    expect(found?.pendingPlanPriceId).toBe(basicId);

    expect(await repo().clearScheduledChange(accountId, id)).toBe("cleared");
    expect((await sub(id))?.pending).toBeNull();
    expect(await repo().clearScheduledChange(accountId, id)).toBe("none");
    expect(
      await repo().clearScheduledChange("00000000-0000-4000-8000-0000000000cc", id),
    ).toBe("not_found");
  });

  it("only schedules a downgrade on an active subscription", async () => {
    const id = await proSubscription();
    await db.query(`UPDATE subscriptions SET status = 'paused' WHERE id = $1`, [id]);
    await repo().scheduleDowngrade(id, basicId);
    expect((await sub(id))?.pending).toBeNull();
  });

  it("cancels a scheduled downgrade when an upgrade is requested", async () => {
    const id = await proSubscription();
    await repo().scheduleDowngrade(id, basicId);
    const quote: UpgradeQuote = {
      lines: [
        { type: "proration_credit", description: "Crédit", amountCents: -500 },
        { type: "proration_charge", description: "Nouveau plan", amountCents: 1500 },
      ],
      totalCents: 1000,
      startsNewPeriod: false,
    };
    await repo().createChangeInvoice({
      accountId,
      subscriptionId: id,
      targetPlanPriceId: maxId,
      idempotencyKey: "up",
      quote,
      currency: "EUR",
      now: t0,
    });
    expect((await sub(id))?.pending).toBeNull();
  });

  it("lists only active subscriptions due for renewal, at their effective price", async () => {
    const id = await proSubscription();
    expect(await repo().listDueRenewals(t0, 10)).toEqual([]); // pas encore échu

    expect(await repo().listDueRenewals(afterEnd, 10)).toEqual([
      {
        subscriptionId: id,
        accountId,
        planPriceId: proId,
        amountCents: 1999,
        currency: "EUR",
        interval: "month",
        periodEnd,
      },
    ]);

    await repo().scheduleDowngrade(id, basicId);
    const [scheduled] = await repo().listDueRenewals(afterEnd, 10);
    expect(scheduled).toMatchObject({ planPriceId: basicId, amountCents: 999 });

    await db.query(`UPDATE subscriptions SET cancel_at_period_end = true WHERE id = $1`, [id]);
    expect(await repo().listDueRenewals(afterEnd, 10)).toEqual([]);
    await db.query(
      `UPDATE subscriptions SET cancel_at_period_end = false, status = 'paused' WHERE id = $1`,
      [id],
    );
    expect(await repo().listDueRenewals(afterEnd, 10)).toEqual([]);
  });

  it("creates a single open renewal invoice per subscription and stops listing it", async () => {
    const id = await proSubscription();
    const first = await renewal(id, "pi_renew");
    expect(first).toMatchObject({ totalCents: 1999, currency: "EUR" });
    expect(await repo().listDueRenewals(afterEnd, 10)).toEqual([]);
    const second = await repo().createRenewalInvoice({
      subscriptionId: id,
      accountId,
      planPriceId: proId,
      amountCents: 1999,
      currency: "EUR",
      interval: "month",
      periodStart: periodEnd,
      now: afterEnd,
    });
    expect(second).toBeNull();
    const lines = await db.query<{ type: string; period_start: Date; period_end: Date }>(
      `SELECT type, period_start, period_end FROM invoice_lines WHERE invoice_id = $1`,
      [first?.invoiceId],
    );
    expect(lines).toEqual([
      { type: "plan", period_start: periodEnd, period_end: new Date("2026-12-17T12:00:00Z") },
    ]);
  });

  it("rolls the period on renewal payment and keeps the same plan", async () => {
    const id = await proSubscription();
    await renewal(id, "pi_renew");
    expect(
      await repo().applyPaymentEvent(evt("e_r", "payment.succeeded", "pi_renew"), afterEnd),
    ).toBe("applied");
    const after = await sub(id);
    expect(after).toMatchObject({ status: "active", plan_price_id: proId });
    expect(after?.start).toEqual(periodEnd);
    expect(after?.end).toEqual(new Date("2026-12-17T12:00:00Z"));
  });

  it("applies the scheduled downgrade on renewal payment and bills the new price", async () => {
    const id = await proSubscription();
    await repo().scheduleDowngrade(id, basicId);
    const invoice = await renewal(id, "pi_renew");
    expect(invoice?.totalCents).toBe(999);

    await repo().applyPaymentEvent(evt("e_r", "payment.succeeded", "pi_renew"), afterEnd);

    const after = await sub(id);
    expect(after?.plan_price_id).toBe(basicId);
    expect(after?.pending).toBeNull();
    expect(after?.status).toBe("active");
  });

  it("does not apply the downgrade when the renewal payment fails, then recovers on retry", async () => {
    const id = await proSubscription();
    await repo().scheduleDowngrade(id, basicId);
    await renewal(id, "pi_renew");

    expect(
      await repo().applyPaymentEvent(evt("e_f", "payment.failed", "pi_renew"), afterEnd),
    ).toBe("applied");
    const failed = await sub(id);
    expect(failed).toMatchObject({ status: "past_due", plan_price_id: proId, pending: basicId });

    // paiement rattrapé : l'abonnement redevient actif, le downgrade s'applique, la période avance
    expect(
      await repo().applyPaymentEvent(evt("e_ok", "payment.succeeded", "pi_renew"), afterEnd),
    ).toBe("applied");
    const recovered = await sub(id);
    expect(recovered).toMatchObject({ status: "active", plan_price_id: basicId, pending: null });
    expect(recovered?.start).toEqual(periodEnd);
  });

  it("clears the scheduled downgrade when an upgrade payment succeeds", async () => {
    const id = await proSubscription();
    await repo().scheduleDowngrade(id, basicId);
    const created = await repo().createChangeInvoice({
      accountId,
      subscriptionId: id,
      targetPlanPriceId: maxId,
      idempotencyKey: "up",
      quote: {
        lines: [{ type: "proration_charge", description: "Nouveau plan", amountCents: 1000 }],
        totalCents: 1000,
        startsNewPeriod: false,
      },
      currency: "EUR",
      now: t0,
    });
    // le downgrade est reprogrammé entre la demande et le paiement
    await repo().scheduleDowngrade(id, basicId);
    await repo().recordPayment(created.invoiceId, "pi_up", 1000);
    await repo().applyPaymentEvent(evt("e_up", "payment.succeeded", "pi_up"), t0);
    const after = await sub(id);
    expect(after?.plan_price_id).toBe(maxId);
    expect(after?.pending).toBeNull();
  });
});
