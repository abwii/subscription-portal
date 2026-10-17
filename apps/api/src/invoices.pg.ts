import type { Queryable } from "./db.js";
import type {
  InvoiceDetail,
  InvoiceRepository,
  InvoiceSummary,
} from "./invoices.js";

interface InvoiceRow {
  id: string;
  number: string;
  status: string;
  total_cents: number;
  currency: string;
  issued_at: Date;
  paid_at: Date | null;
}

const toSummary = (row: InvoiceRow): InvoiceSummary => ({
  id: row.id,
  number: row.number,
  status: row.status,
  totalCents: row.total_cents,
  currency: row.currency.trim(),
  issuedAt: row.issued_at,
  paidAt: row.paid_at,
});

const COLUMNS = `i.id, i.number, i.status, i.total_cents, i.currency, i.issued_at, i.paid_at`;

export function createInvoiceRepository(db: Queryable): InvoiceRepository {
  return {
    async listInvoices(accountId) {
      const rows = await db.query<InvoiceRow>(
        `SELECT ${COLUMNS} FROM invoices i
         WHERE i.account_id = $1
         ORDER BY i.issued_at DESC, i.number DESC`,
        [accountId],
      );
      return rows.map(toSummary);
    },

    async findInvoice(accountId, id) {
      const [row] = await db.query<InvoiceRow & { lines: InvoiceDetail["lines"] }>(
        `SELECT ${COLUMNS},
           COALESCE((
             SELECT json_agg(json_build_object(
               'type', l.type, 'description', l.description,
               'amountCents', l.amount_cents,
               'periodStart', l.period_start, 'periodEnd', l.period_end)
               ORDER BY l.id)
             FROM invoice_lines l WHERE l.invoice_id = i.id
           ), '[]'::json) AS lines
         FROM invoices i
         WHERE i.id = $1 AND i.account_id = $2`,
        [id, accountId],
      );
      return row ? { ...toSummary(row), lines: row.lines } : null;
    },
  };
}
