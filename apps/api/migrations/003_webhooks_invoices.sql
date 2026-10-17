-- ADR-001 #5 : journal des événements du fournisseur (idempotence des webhooks) et
-- immuabilité des factures émises.

CREATE TABLE payment_events (
  provider_event_id text PRIMARY KEY,
  type              text NOT NULL,
  provider_ref      text NOT NULL,
  received_at       timestamptz NOT NULL
);

-- Une facture hors brouillon ne change plus : seuls son statut et sa date de paiement évoluent.
-- Correction = avoir ou nouvelle facture (ADR-001, décision 5).
CREATE FUNCTION forbid_invoice_edit() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'draft' THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'invoice % is immutable', OLD.number;
    END IF;
    IF (NEW.account_id, NEW.subscription_id, NEW.number, NEW.total_cents, NEW.currency, NEW.issued_at)
       IS DISTINCT FROM
       (OLD.account_id, OLD.subscription_id, OLD.number, OLD.total_cents, OLD.currency, OLD.issued_at) THEN
      RAISE EXCEPTION 'invoice % is immutable', OLD.number;
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoices_immutable
  BEFORE UPDATE OR DELETE ON invoices
  FOR EACH ROW EXECUTE FUNCTION forbid_invoice_edit();

CREATE FUNCTION forbid_invoice_line_edit() RETURNS trigger AS $$
BEGIN
  IF (SELECT status FROM invoices WHERE id = OLD.invoice_id) <> 'draft' THEN
    RAISE EXCEPTION 'lines of a non-draft invoice are immutable';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER invoice_lines_immutable
  BEFORE UPDATE OR DELETE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_invoice_line_edit();
