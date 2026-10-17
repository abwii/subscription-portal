import type { FastifyInstance } from "fastify";
import type { Authenticate } from "./catalog.js";
import type { InvoiceRepository } from "./invoices.js";
import type { PaymentProvider } from "./payments.js";
import type { SubscriptionRepository } from "./subscriptions.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InvoicePaymentRoutesOptions {
  invoices: InvoiceRepository;
  subscriptions: SubscriptionRepository;
  payments: PaymentProvider | undefined;
  authenticate: Authenticate;
}

/**
 * Permet de (re)payer une facture ouverte : renouvellement ou reprise dont le paiement a échoué ou n'a pas
 * pu être créé. La clé fournisseur est stable par facture : des appels répétés rendent le même paiement.
 */
export function registerInvoicePaymentRoutes(
  app: FastifyInstance,
  { invoices, subscriptions, payments, authenticate }: InvoicePaymentRoutesOptions,
): void {
  app.post<{ Params: { id: string } }>("/invoices/:id/pay", async (req, reply) => {
    const accountId = await authenticate(req);
    if (accountId === null) return reply.code(401).send({ error: "unauthorized" });
    if (!payments) {
      return reply.code(503).send({ error: "payment_provider_unconfigured" });
    }
    // 404 (et non 403) pour la facture d'un autre compte : son existence reste cachée.
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
    const invoice = await invoices.findInvoice(accountId, req.params.id);
    if (!invoice) return reply.code(404).send({ error: "not_found" });
    if (invoice.status !== "open") {
      return reply.code(409).send({ error: "invoice_not_open" });
    }

    try {
      const payment = await payments.createPayment({
        accountId,
        invoiceId: invoice.id,
        amountCents: invoice.totalCents,
        currency: invoice.currency,
        idempotencyKey: `invoice:${invoice.id}`,
      });
      await subscriptions.recordPayment(invoice.id, payment.providerRef, invoice.totalCents);
      return { payment };
    } catch (err) {
      req.log.error({ err }, "invoice payment failed");
      return reply.code(502).send({ error: "payment_provider_error" });
    }
  });
}
