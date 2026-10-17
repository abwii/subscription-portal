-- ADR-001 #11 : cadeaux. Un cadeau naît `awaiting_payment` (code généré, jamais divulgué), devient
-- `pending` (utilisable, valable 12 mois) au paiement, puis `redeemed`, `expired` ou `refunded`.
-- Le code est un secret porteur : 128 bits d'entropie, visible uniquement de l'offrant (et du destinataire
-- par e-mail), jamais dans une URL ni un journal.

CREATE TABLE gifts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchaser_account_id uuid NOT NULL REFERENCES accounts (id),
  redeemed_by_account_id uuid REFERENCES accounts (id),
  subscription_id      uuid REFERENCES subscriptions (id),
  plan_price_id        uuid NOT NULL REFERENCES plan_prices (id),
  duration_periods     integer NOT NULL CHECK (duration_periods BETWEEN 1 AND 12),
  code                 text NOT NULL UNIQUE,
  recipient_email      text,
  idempotency_key      text,
  status               text NOT NULL
    CHECK (status IN ('awaiting_payment', 'pending', 'redeemed', 'expired', 'refunded')),
  created_at           timestamptz NOT NULL,
  expires_at           timestamptz,
  redeemed_at          timestamptz,
  notified_at          timestamptz
);

CREATE UNIQUE INDEX gifts_idempotency
  ON gifts (purchaser_account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX gifts_purchaser ON gifts (purchaser_account_id, created_at DESC);
-- Fermeture des cadeaux non payés / périmés sans balayer toute la table.
CREATE INDEX gifts_awaiting ON gifts (created_at) WHERE status = 'awaiting_payment';
CREATE INDEX gifts_usable_expiry ON gifts (expires_at) WHERE status = 'pending';

-- La facture d'achat d'un cadeau est au nom de l'offrant et porte le cadeau.
ALTER TABLE invoices ADD COLUMN gift_id uuid REFERENCES gifts (id);
