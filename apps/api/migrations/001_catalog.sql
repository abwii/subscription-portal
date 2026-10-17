-- ADR-001 : catalogue (plans, prix, droits), comptes, et table subscriptions minimale
-- nécessaire à GET /me/entitlements. Les colonnes des tickets suivants (gift_id, ...) arriveront
-- par migrations additives.

CREATE TABLE accounts (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code   text NOT NULL UNIQUE,
  name   text NOT NULL,
  rank   integer NOT NULL,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE plan_prices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id      uuid NOT NULL REFERENCES plans (id),
  "interval"   text NOT NULL CHECK ("interval" IN ('month', 'year')),
  amount_cents integer NOT NULL CHECK (amount_cents >= 0),
  currency     char(3) NOT NULL,
  active       boolean NOT NULL DEFAULT true
);
-- Un seul prix actif par plan, intervalle et devise : les prix sont immuables, on en crée un nouveau.
CREATE UNIQUE INDEX plan_prices_one_active
  ON plan_prices (plan_id, "interval", currency) WHERE active;

CREATE TABLE entitlements (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('boolean', 'limit'))
);

CREATE TABLE plan_entitlements (
  plan_id        uuid NOT NULL REFERENCES plans (id),
  entitlement_id uuid NOT NULL REFERENCES entitlements (id),
  limit_value    integer CHECK (limit_value >= 0),
  PRIMARY KEY (plan_id, entitlement_id)
);

CREATE TABLE subscriptions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            uuid NOT NULL REFERENCES accounts (id),
  plan_price_id         uuid NOT NULL REFERENCES plan_prices (id),
  pending_plan_price_id uuid REFERENCES plan_prices (id),
  status                text NOT NULL
    CHECK (status IN ('pending', 'active', 'past_due', 'paused', 'canceled', 'expired')),
  current_period_start  timestamptz NOT NULL,
  current_period_end    timestamptz NOT NULL,
  cancel_at_period_end  boolean NOT NULL DEFAULT false,
  paused_at             timestamptz,
  resume_at             timestamptz,
  CHECK (current_period_end > current_period_start)
);
-- Au plus un abonnement vivant par compte.
CREATE UNIQUE INDEX subscriptions_one_live_per_account
  ON subscriptions (account_id) WHERE status IN ('pending', 'active', 'past_due', 'paused');
