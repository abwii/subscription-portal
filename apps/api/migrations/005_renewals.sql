-- ADR-001 #7 : renouvellements. Une facture de renouvellement porte la période suivante ; au paiement,
-- l'abonnement avance d'une période et applique le downgrade programmé (pending_plan_price_id).

ALTER TABLE invoices ADD COLUMN is_renewal boolean NOT NULL DEFAULT false;

-- Au plus une facture de renouvellement ouverte par abonnement : rend le job de renouvellement rejouable.
CREATE UNIQUE INDEX invoices_one_open_renewal
  ON invoices (subscription_id) WHERE is_renewal AND status = 'open';
