-- ADR-001 #4 : checkout. Factures et paiements (minimum nécessaire : le ticket « Factures et
-- webhooks » les complétera), clé d'idempotence et date de création des abonnements.

ALTER TABLE subscriptions
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN idempotency_key text;

-- Une clé d'idempotence n'a de sens que pour un compte donné.
CREATE UNIQUE INDEX subscriptions_idempotency
  ON subscriptions (account_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Sert à fermer les « pending » périmés sans balayer toute la table.
CREATE INDEX subscriptions_pending_created
  ON subscriptions (created_at) WHERE status = 'pending';

CREATE SEQUENCE invoice_number_seq;

CREATE TABLE invoices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id),
  subscription_id uuid REFERENCES subscriptions (id),
  number          text NOT NULL UNIQUE,
  status          text NOT NULL
    CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  total_cents     integer NOT NULL,
  currency        char(3) NOT NULL,
  issued_at       timestamptz NOT NULL,
  paid_at         timestamptz
);
CREATE INDEX invoices_account ON invoices (account_id, issued_at DESC);
CREATE INDEX invoices_subscription ON invoices (subscription_id);

CREATE TABLE invoice_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES invoices (id),
  type         text NOT NULL
    CHECK (type IN ('plan', 'proration_credit', 'proration_charge', 'tax')),
  description  text NOT NULL,
  amount_cents integer NOT NULL,
  period_start timestamptz,
  period_end   timestamptz
);
CREATE INDEX invoice_lines_invoice ON invoice_lines (invoice_id);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id   uuid NOT NULL REFERENCES invoices (id),
  provider_ref text NOT NULL UNIQUE,
  status       text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0)
);
CREATE INDEX payments_invoice ON payments (invoice_id);
