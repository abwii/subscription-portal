import type { PriceInterval } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { PaymentProvider } from "./payments.js";
import type { SubscriptionRepository } from "./subscriptions.js";

/** Abonnement actif dont la période est terminée, avec le prix à facturer (celui d'un downgrade programmé s'il existe). */
export interface DueRenewal {
  subscriptionId: string;
  accountId: string;
  planPriceId: string;
  amountCents: number;
  currency: string;
  interval: PriceInterval;
  periodEnd: Date;
}

export interface CreateRenewalInvoiceInput {
  subscriptionId: string;
  accountId: string;
  planPriceId: string;
  amountCents: number;
  currency: string;
  interval: PriceInterval;
  /** Début de la période renouvelée = fin de la précédente. */
  periodStart: Date;
  now: Date;
}

export interface RenewalInvoice {
  invoiceId: string;
  totalCents: number;
  currency: string;
}

const BATCH_SIZE = 100;

/**
 * À planifier (ex. toutes les heures, voir `jobs-cli.ts`) : crée la facture `open` du renouvellement et
 * le paiement correspondant pour chaque abonnement échu. Le plan et la période n'évoluent qu'au paiement
 * réussi (webhook) ; un échec passe l'abonnement en `past_due`.
 *
 * Limite connue : le paiement est créé comme pour un checkout (le client doit le confirmer). Un prélèvement
 * automatique hors session exige un moyen de paiement enregistré, absent du modèle actuel.
 */
export async function renewDueSubscriptions(deps: {
  repo: SubscriptionRepository;
  payments: PaymentProvider;
  clock: Clock;
}): Promise<{ renewed: number; failed: number }> {
  const { repo, payments, clock } = deps;
  const now = clock.now();
  const due = await repo.listDueRenewals(now, BATCH_SIZE);

  let renewed = 0;
  let failed = 0;
  for (const item of due) {
    try {
      const invoice = await repo.createRenewalInvoice({
        subscriptionId: item.subscriptionId,
        accountId: item.accountId,
        planPriceId: item.planPriceId,
        amountCents: item.amountCents,
        currency: item.currency,
        interval: item.interval,
        periodStart: item.periodEnd,
        now,
      });
      if (!invoice) continue; // une facture de renouvellement est déjà ouverte
      const payment = await payments.createPayment({
        accountId: item.accountId,
        invoiceId: invoice.invoiceId,
        amountCents: invoice.totalCents,
        currency: invoice.currency,
        idempotencyKey: `renewal:${invoice.invoiceId}`,
      });
      await repo.recordPayment(invoice.invoiceId, payment.providerRef, invoice.totalCents);
      renewed++;
    } catch {
      // Un abonnement en échec ne doit pas bloquer les autres ; il sera retenté au prochain passage
      // si sa facture n'a pas été créée, sinon la facture ouverte attend son paiement.
      failed++;
    }
  }
  return { renewed, failed };
}
