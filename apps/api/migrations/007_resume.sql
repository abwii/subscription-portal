-- ADR-001 #9 : reprise. La facture de reprise règle la période qui démarre à la reprise ; l'abonnement
-- est actif dès la reprise, le paiement ne fait que régler la facture (un échec le passe en past_due).

ALTER TABLE invoices ADD COLUMN is_resume boolean NOT NULL DEFAULT false;
