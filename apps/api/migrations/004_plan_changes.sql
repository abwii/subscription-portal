-- ADR-001 #6 : changement de plan. Une facture de changement porte le prix visé ; le plan ne change
-- qu'au paiement. Idempotence par (compte, clé) et une seule demande de changement ouverte par abonnement.

ALTER TABLE invoices
  ADD COLUMN target_plan_price_id uuid REFERENCES plan_prices (id),
  ADD COLUMN starts_new_period boolean NOT NULL DEFAULT false,
  ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX invoices_idempotency
  ON invoices (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX invoices_one_open_change
  ON invoices (subscription_id) WHERE target_plan_price_id IS NOT NULL AND status = 'open';

-- Ordre d'affichage des lignes (crédit avant débit).
ALTER TABLE invoice_lines ADD COLUMN position integer NOT NULL DEFAULT 0;
