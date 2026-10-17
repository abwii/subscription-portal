import type { PriceInterval } from "./catalog.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface QuotedLine {
  type: "proration_credit" | "proration_charge" | "plan";
  description: string;
  amountCents: number;
}

export interface UpgradeQuote {
  lines: QuotedLine[];
  /** Somme des lignes, en centimes. */
  totalCents: number;
  /** `true` si la période de facturation redémarre (changement d'intervalle). */
  startsNewPeriod: boolean;
}

interface PriceTerms {
  interval: PriceInterval;
  amountCents: number;
  currency: string;
}

export interface QuoteInput {
  current: PriceTerms & { periodStart: Date; periodEnd: Date };
  target: PriceTerms;
  now: Date;
}

/** `a × r / p` arrondi à l'entier le plus proche, moitié vers le haut (entiers positifs). */
function mulDivHalfUp(a: number, r: number, p: number): number {
  return Math.floor((2 * a * r + p) / (2 * p));
}

/**
 * Prorata au jour (ADR-001) : `P` jours dans la période, `r` jours restants (jour entamé = jour dû),
 * crédit = old × r / P. Chaque ligne est arrondie une seule fois.
 */
export function quoteUpgrade({ current, target, now }: QuoteInput): UpgradeQuote {
  const totalDays = Math.max(
    1,
    Math.round((current.periodEnd.getTime() - current.periodStart.getTime()) / DAY_MS),
  );
  const remaining = Math.min(
    totalDays,
    Math.max(0, Math.ceil((current.periodEnd.getTime() - now.getTime()) / DAY_MS)),
  );
  const span = `${String(remaining)} j sur ${String(totalDays)}`;

  const credit = mulDivHalfUp(current.amountCents, remaining, totalDays);
  const creditLine: QuotedLine = {
    type: "proration_credit",
    description: `Crédit du temps non utilisé (${span})`,
    amountCents: credit === 0 ? 0 : -credit,
  };

  if (target.interval !== current.interval) {
    // Nouvelle période complète au prix du nouvel intervalle, moins le crédit restant.
    const planLine: QuotedLine = {
      type: "plan",
      description: target.interval === "year" ? "Abonnement annuel" : "Abonnement mensuel",
      amountCents: target.amountCents,
    };
    return {
      lines: [creditLine, planLine],
      totalCents: planLine.amountCents + creditLine.amountCents,
      startsNewPeriod: true,
    };
  }

  const chargeLine: QuotedLine = {
    type: "proration_charge",
    description: `Nouveau plan pour le temps restant (${span})`,
    amountCents: mulDivHalfUp(target.amountCents, remaining, totalDays),
  };
  return {
    lines: [creditLine, chargeLine],
    totalCents: chargeLine.amountCents + creditLine.amountCents,
    startsNewPeriod: false,
  };
}

interface PriceRank {
  planId: string;
  rank: number;
  interval: PriceInterval;
}

/** Plan de rang supérieur, ou même plan en passant du mensuel à l'annuel. */
export function isUpgrade(current: PriceRank, target: PriceRank): boolean {
  if (target.rank > current.rank) return true;
  return (
    target.planId === current.planId &&
    current.interval === "month" &&
    target.interval === "year"
  );
}
