import { describe, expect, it } from "vitest";
import { isUpgrade, quoteUpgrade } from "./proration.js";

const DAY = 24 * 60 * 60 * 1000;
const start = new Date("2026-10-01T00:00:00Z");
const end = new Date(start.getTime() + 30 * DAY);
const at = (daysBeforeEnd: number) => new Date(end.getTime() - daysBeforeEnd * DAY);

const monthly = (amountCents: number) => ({
  interval: "month" as const,
  amountCents,
  currency: "EUR",
});
const yearly = (amountCents: number) => ({
  interval: "year" as const,
  amountCents,
  currency: "EUR",
});
const period = { periodStart: start, periodEnd: end };

describe("quoteUpgrade (same interval)", () => {
  it("credits unused time and charges the new plan for the remaining time", () => {
    // 10,00 € → 20,00 €, 15 jours restants sur 30 : −5,00 € et +10,00 € = 5,00 €
    const quote = quoteUpgrade({
      current: { ...monthly(1000), ...period },
      target: monthly(2000),
      now: at(15),
    });
    expect(quote.startsNewPeriod).toBe(false);
    expect(quote.totalCents).toBe(500);
    expect(quote.lines).toEqual([
      {
        type: "proration_credit",
        description: "Crédit du temps non utilisé (15 j sur 30)",
        amountCents: -500,
      },
      {
        type: "proration_charge",
        description: "Nouveau plan pour le temps restant (15 j sur 30)",
        amountCents: 1000,
      },
    ]);
  });

  it("rounds half up, once per line", () => {
    // 5 c × 1/2 = 2,5 → 3 ; 11 c × 1/2 = 5,5 → 6
    const quote = quoteUpgrade({
      current: { ...monthly(5), interval: "month", periodStart: start, periodEnd: new Date(start.getTime() + 2 * DAY) },
      target: monthly(11),
      now: new Date(start.getTime() + 1 * DAY),
    });
    expect(quote.lines.map((l) => l.amountCents)).toEqual([-3, 6]);
    expect(quote.totalCents).toBe(3);
  });

  it("counts a started day as remaining", () => {
    // 14,2 jours restants → 15 jours facturés
    const quote = quoteUpgrade({
      current: { ...monthly(3000), ...period },
      target: monthly(6000),
      now: new Date(end.getTime() - 14.2 * DAY),
    });
    expect(quote.lines.map((l) => l.amountCents)).toEqual([-1500, 3000]);
  });

  it("clamps the remaining days to the period", () => {
    const before = quoteUpgrade({
      current: { ...monthly(3000), ...period },
      target: monthly(6000),
      now: new Date(start.getTime() - 5 * DAY),
    });
    expect(before.lines.map((l) => l.amountCents)).toEqual([-3000, 6000]);
    const after = quoteUpgrade({
      current: { ...monthly(3000), ...period },
      target: monthly(6000),
      now: new Date(end.getTime() + DAY),
    });
    expect(after.lines.map((l) => l.amountCents)).toEqual([0, 0]);
    expect(after.totalCents).toBe(0);
  });
});

describe("quoteUpgrade (monthly → yearly)", () => {
  it("starts a new yearly period and deducts the remaining credit from the yearly price", () => {
    const quote = quoteUpgrade({
      current: { ...monthly(1000), ...period },
      target: yearly(10000),
      now: at(15),
    });
    expect(quote.startsNewPeriod).toBe(true);
    expect(quote.totalCents).toBe(9500);
    expect(quote.lines.map((l) => [l.type, l.amountCents])).toEqual([
      ["proration_credit", -500],
      ["plan", 10000],
    ]);
  });
});

describe("isUpgrade", () => {
  const price = (rank: number, interval: "month" | "year", planId = `p${String(rank)}`) => ({
    planId,
    rank,
    interval,
  });
  it("is true for a higher-ranked plan", () => {
    expect(isUpgrade(price(1, "month"), price(2, "month"))).toBe(true);
    expect(isUpgrade(price(1, "year"), price(2, "month"))).toBe(true);
  });
  it("is true for the same plan going from monthly to yearly", () => {
    expect(isUpgrade(price(1, "month", "a"), price(1, "year", "a"))).toBe(true);
  });
  it("is false for a lower or equal plan, the same price, or yearly to monthly", () => {
    expect(isUpgrade(price(2, "month"), price(1, "month"))).toBe(false);
    expect(isUpgrade(price(1, "month", "a"), price(1, "month", "a"))).toBe(false);
    expect(isUpgrade(price(1, "year", "a"), price(1, "month", "a"))).toBe(false);
  });
});
