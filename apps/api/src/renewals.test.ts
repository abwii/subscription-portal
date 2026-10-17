import { describe, expect, it } from "vitest";
import type { Clock } from "./clock.js";
import type { PaymentProvider } from "./payments.js";
import { renewDueSubscriptions, type DueRenewal } from "./renewals.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const NOW = new Date("2026-11-17T00:00:01Z");
const clock: Clock = { now: () => NOW };

const due = (over: Partial<DueRenewal> = {}): DueRenewal => ({
  subscriptionId: "sub-1",
  accountId: "acc-1",
  planPriceId: "price-1",
  amountCents: 1999,
  currency: "EUR",
  interval: "month",
  periodEnd: new Date("2026-11-17T00:00:00Z"),
  ...over,
});

function setup(opts: {
  dues?: DueRenewal[];
  createRenewalInvoice?: SubscriptionRepository["createRenewalInvoice"];
  createPayment?: PaymentProvider["createPayment"];
}) {
  const invoices: Parameters<SubscriptionRepository["createRenewalInvoice"]>[0][] = [];
  const recorded: [string, string, number][] = [];
  const paymentCalls: Parameters<PaymentProvider["createPayment"]>[0][] = [];
  const repo = {
    listDueRenewals: (now: Date, limit: number) => {
      expect(now).toEqual(NOW);
      expect(limit).toBeGreaterThan(0);
      return Promise.resolve(opts.dues ?? []);
    },
    createRenewalInvoice:
      opts.createRenewalInvoice ??
      ((input: Parameters<SubscriptionRepository["createRenewalInvoice"]>[0]) => {
        invoices.push(input);
        return Promise.resolve({
          invoiceId: `inv-${input.subscriptionId}`,
          totalCents: input.amountCents,
          currency: input.currency,
        });
      }),
    recordPayment: (invoiceId: string, providerRef: string, amount: number) => {
      recorded.push([invoiceId, providerRef, amount]);
      return Promise.resolve();
    },
  } as unknown as SubscriptionRepository;
  const payments: PaymentProvider = {
    createPayment:
      opts.createPayment ??
      ((input) => {
        paymentCalls.push(input);
        return Promise.resolve({
          providerRef: `pi_${input.invoiceId}`,
          clientSecret: "secret",
        });
      }),
  };
  return { repo, payments, invoices, recorded, paymentCalls };
}

describe("renewDueSubscriptions", () => {
  it("creates one open invoice and one payment per due subscription", async () => {
    const s = setup({ dues: [due(), due({ subscriptionId: "sub-2", accountId: "acc-2" })] });
    const result = await renewDueSubscriptions({ repo: s.repo, payments: s.payments, clock });
    expect(result).toEqual({ renewed: 2, failed: 0 });
    expect(s.invoices.map((i) => i.subscriptionId)).toEqual(["sub-1", "sub-2"]);
    expect(s.invoices[0]).toMatchObject({
      planPriceId: "price-1",
      amountCents: 1999,
      currency: "EUR",
      interval: "month",
      periodStart: new Date("2026-11-17T00:00:00Z"),
      now: NOW,
    });
    expect(s.recorded).toEqual([
      ["inv-sub-1", "pi_inv-sub-1", 1999],
      ["inv-sub-2", "pi_inv-sub-2", 1999],
    ]);
  });

  it("bills the new plan when a downgrade was scheduled (the due price is the effective one)", async () => {
    const s = setup({ dues: [due({ planPriceId: "price-basic", amountCents: 999 })] });
    await renewDueSubscriptions({ repo: s.repo, payments: s.payments, clock });
    expect(s.invoices[0]).toMatchObject({ planPriceId: "price-basic", amountCents: 999 });
    expect(s.paymentCalls[0]).toMatchObject({ amountCents: 999 });
  });

  it("uses a stable provider key per invoice so a retry cannot double charge", async () => {
    const s = setup({ dues: [due()] });
    await renewDueSubscriptions({ repo: s.repo, payments: s.payments, clock });
    expect(s.paymentCalls[0]?.idempotencyKey).toBe("invoice:inv-sub-1");
  });

  it("skips a subscription whose renewal invoice already exists", async () => {
    const s = setup({
      dues: [due()],
      createRenewalInvoice: () => Promise.resolve(null),
    });
    const result = await renewDueSubscriptions({ repo: s.repo, payments: s.payments, clock });
    expect(result).toEqual({ renewed: 0, failed: 0 });
    expect(s.paymentCalls).toHaveLength(0);
  });

  it("keeps going and counts failures when the provider fails for one subscription", async () => {
    let calls = 0;
    const s = setup({
      dues: [due(), due({ subscriptionId: "sub-2" })],
      createPayment: (input) => {
        if (++calls === 1) return Promise.reject(new Error("boom"));
        return Promise.resolve({ providerRef: `pi_${input.invoiceId}`, clientSecret: "s" });
      },
    });
    const result = await renewDueSubscriptions({ repo: s.repo, payments: s.payments, clock });
    expect(result).toEqual({ renewed: 1, failed: 1 });
    expect(s.recorded.map((r) => r[0])).toEqual(["inv-sub-2"]);
  });

  it("does nothing when nothing is due", async () => {
    const s = setup({});
    expect(await renewDueSubscriptions({ repo: s.repo, payments: s.payments, clock })).toEqual({
      renewed: 0,
      failed: 0,
    });
  });
});
