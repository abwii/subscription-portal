import type { FastifyInstance } from "fastify";
import type { Authenticate } from "./catalog.js";
import type { Clock } from "./clock.js";
import type { PaymentDetails, PaymentProvider } from "./payments.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BATCH_SIZE = 100;

export interface ResumedInvoice {
  invoiceId: string;
  accountId: string;
  totalCents: number;
  currency: string;
}

/** La reprise est faite, mais le paiement n'a pas pu être créé : la facture reste ouverte. */
export class ResumePaymentError extends Error {
  constructor(
    readonly invoiceId: string,
    cause: unknown,
  ) {
    super("payment could not be created after resume", { cause });
  }
}

interface ResumeDeps {
  repo: SubscriptionRepository;
  payments: PaymentProvider;
  clock: Clock;
}

/**
 * Reprend un abonnement `paused` : il redevient `active` avec une nouvelle période à `now`, une facture de
 * reprise est émise et son paiement créé. `null` si l'abonnement n'est plus en pause (reprise concurrente).
 * Lève `ResumePaymentError` si le fournisseur échoue après la reprise (le client peut payer via
 * `POST /invoices/:id/pay`).
 */
export async function resumeSubscription(
  { repo, payments, clock }: ResumeDeps,
  subscriptionId: string,
): Promise<{ invoice: ResumedInvoice; payment: PaymentDetails } | null> {
  const invoice = await repo.resume({ subscriptionId, now: clock.now() });
  if (!invoice) return null;
  try {
    const payment = await payments.createPayment({
      accountId: invoice.accountId,
      invoiceId: invoice.invoiceId,
      amountCents: invoice.totalCents,
      currency: invoice.currency,
      // Même clé que `POST /invoices/:id/pay` : le fournisseur rend le même paiement.
      idempotencyKey: `invoice:${invoice.invoiceId}`,
    });
    await repo.recordPayment(invoice.invoiceId, payment.providerRef, invoice.totalCents);
    return { invoice, payment };
  } catch (err) {
    throw new ResumePaymentError(invoice.invoiceId, err);
  }
}

/**
 * À planifier (ex. toutes les heures, voir `jobs-cli.ts`) : reprend les abonnements dont la date de
 * reprise est passée. Rejouable : une reprise déjà faite est ignorée.
 */
export async function resumeDueSubscriptions(
  deps: ResumeDeps,
): Promise<{ resumed: number; failed: number }> {
  const due = await deps.repo.listDueResumes(deps.clock.now(), BATCH_SIZE);
  let resumed = 0;
  let failed = 0;
  for (const subscriptionId of due) {
    try {
      if (await resumeSubscription(deps, subscriptionId)) resumed++;
    } catch {
      failed++;
    }
  }
  return { resumed, failed };
}

interface ResumeRoutesOptions {
  subscriptions: SubscriptionRepository;
  payments: PaymentProvider | undefined;
  clock: Clock;
  authenticate: Authenticate;
}

export function registerResumeRoutes(
  app: FastifyInstance,
  { subscriptions, payments, clock, authenticate }: ResumeRoutesOptions,
): void {
  app.post<{ Params: { id: string } }>("/subscriptions/:id/resume", async (req, reply) => {
    const accountId = await authenticate(req);
    if (accountId === null) return reply.code(401).send({ error: "unauthorized" });
    if (!payments) {
      return reply.code(503).send({ error: "payment_provider_unconfigured" });
    }
    // 404 (et non 403) pour l'abonnement d'un autre compte : son existence reste cachée.
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });

    const sub = await subscriptions.findSubscriptionForChange(accountId, req.params.id);
    if (!sub) return reply.code(404).send({ error: "not_found" });
    if (sub.status !== "paused") {
      return reply.code(409).send({ error: "subscription_not_paused" });
    }

    try {
      const result = await resumeSubscription({ repo: subscriptions, payments, clock }, sub.id);
      if (!result) return await reply.code(409).send({ error: "subscription_not_paused" });
      return {
        subscription: { id: sub.id, status: "active" },
        invoice: {
          id: result.invoice.invoiceId,
          status: "open",
          totalCents: result.invoice.totalCents,
          currency: result.invoice.currency,
        },
        payment: result.payment,
      };
    } catch (err) {
      req.log.error({ err }, "resume failed");
      if (err instanceof ResumePaymentError) {
        return await reply
          .code(502)
          .send({ error: "payment_provider_error", invoiceId: err.invoiceId });
      }
      throw err;
    }
  });
}
