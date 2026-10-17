import type { FastifyInstance } from "fastify";
import type { Authenticate } from "./catalog.js";

export interface InvoiceSummary {
  id: string;
  number: string;
  status: string;
  totalCents: number;
  currency: string;
  issuedAt: Date;
  paidAt: Date | null;
}

export interface InvoiceLineView {
  type: string;
  description: string;
  amountCents: number;
  periodStart: string | null;
  periodEnd: string | null;
}

export interface InvoiceDetail extends InvoiceSummary {
  lines: InvoiceLineView[];
}

export interface InvoiceRepository {
  /** Factures du compte, les plus récentes d'abord. */
  listInvoices(accountId: string): Promise<InvoiceSummary[]>;
  /** `null` si la facture n'existe pas OU appartient à un autre compte. */
  findInvoice(accountId: string, id: string): Promise<InvoiceDetail | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerInvoiceRoutes(
  app: FastifyInstance,
  {
    invoices,
    authenticate,
  }: { invoices: InvoiceRepository; authenticate: Authenticate },
): void {
  app.get("/invoices", async (req, reply) => {
    const accountId = await authenticate(req);
    if (accountId === null) return reply.code(401).send({ error: "unauthorized" });
    return { invoices: await invoices.listInvoices(accountId) };
  });

  app.get<{ Params: { id: string } }>("/invoices/:id", async (req, reply) => {
    const accountId = await authenticate(req);
    if (accountId === null) return reply.code(401).send({ error: "unauthorized" });
    // 404 (et non 403) y compris pour l'id d'un autre compte : l'existence reste cachée.
    if (!UUID.test(req.params.id)) return reply.code(404).send({ error: "not_found" });
    const invoice = await invoices.findInvoice(accountId, req.params.id);
    if (!invoice) return reply.code(404).send({ error: "not_found" });
    return { invoice };
  });
}
