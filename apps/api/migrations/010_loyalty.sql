-- ADR-001 #13 : fidélité. Paliers (données), journal d'XP append-only (source de vérité), projection
-- loyalty_accounts (total + palier) mise à jour dans la même instruction que le paiement.
--
-- Règles (valeurs initiales, à confirmer, voir l'ADR) :
--  - 10 XP par euro entier payé (19,99 € → 190 XP) sur chaque facture payée, cadeaux compris pour l'offrant ;
--  - un remboursement retire les XP de la facture (écriture négative) ;
--  - le palier monte dès que le total le permet ; il ne descend jamais dans les 12 mois suivant son obtention.

CREATE TABLE loyalty_tiers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code         text NOT NULL UNIQUE,
  name         text NOT NULL,
  rank         integer NOT NULL UNIQUE,
  min_xp       integer NOT NULL CHECK (min_xp >= 0),
  -- remise au renouvellement, en points de base (200 = 2 %)
  discount_bps integer NOT NULL CHECK (discount_bps BETWEEN 0 AND 10000)
);

INSERT INTO loyalty_tiers (code, name, rank, min_xp, discount_bps) VALUES
  ('bronze', 'Bronze', 0, 0, 0),
  ('silver', 'Argent', 1, 500, 200),
  ('gold', 'Or', 2, 2000, 500),
  ('platinum', 'Platine', 3, 5000, 1000);

CREATE TABLE loyalty_accounts (
  account_id uuid PRIMARY KEY REFERENCES accounts (id),
  xp_total   integer NOT NULL DEFAULT 0,
  tier_id    uuid NOT NULL REFERENCES loyalty_tiers (id),
  tier_since timestamptz NOT NULL
);

CREATE TABLE xp_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts (id),
  delta           integer NOT NULL CHECK (delta <> 0),
  reason          text NOT NULL,
  source_type     text NOT NULL,
  source_id       uuid,
  -- une même cause ne rapporte (ou ne retire) des XP qu'une fois
  idempotency_key text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL
);
CREATE INDEX xp_ledger_account ON xp_ledger (account_id, created_at);

CREATE FUNCTION forbid_xp_ledger_edit() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'xp_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER xp_ledger_append_only
  BEFORE UPDATE OR DELETE ON xp_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_xp_ledger_edit();

-- Inscrit `p_delta` au journal (idempotent sur `p_key`) puis met à jour le total et le palier.
-- Retourne `false` si l'écriture existait déjà ou si le delta est nul.
CREATE FUNCTION award_xp(
  p_account uuid, p_delta integer, p_reason text, p_source_type text,
  p_source_id uuid, p_key text, p_at timestamptz
) RETURNS boolean AS $$
DECLARE
  inserted integer;
  new_total integer;
  cur_tier uuid;
  cur_since timestamptz;
  cur_rank integer;
  target record;
BEGIN
  IF p_delta = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO xp_ledger (account_id, delta, reason, source_type, source_id, idempotency_key, created_at)
  VALUES (p_account, p_delta, p_reason, p_source_type, p_source_id, p_key, p_at)
  ON CONFLICT (idempotency_key) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO loyalty_accounts (account_id, xp_total, tier_id, tier_since)
  VALUES (p_account, 0, (SELECT id FROM loyalty_tiers WHERE rank = 0), p_at)
  ON CONFLICT (account_id) DO NOTHING;

  UPDATE loyalty_accounts SET xp_total = xp_total + p_delta
  WHERE account_id = p_account
  RETURNING xp_total, tier_id, tier_since INTO new_total, cur_tier, cur_since;

  SELECT t.id, t.rank INTO target
  FROM loyalty_tiers t WHERE t.min_xp <= new_total ORDER BY t.rank DESC LIMIT 1;
  SELECT rank INTO cur_rank FROM loyalty_tiers WHERE id = cur_tier;

  IF target.rank > cur_rank
     OR (target.rank < cur_rank AND cur_since + interval '12 months' <= p_at) THEN
    UPDATE loyalty_accounts SET tier_id = target.id, tier_since = p_at
    WHERE account_id = p_account;
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Retire les XP gagnés par une facture (remboursement). `false` si elle n'avait rien rapporté.
CREATE FUNCTION reverse_invoice_xp(p_invoice uuid, p_at timestamptz) RETURNS boolean AS $$
DECLARE
  earned record;
BEGIN
  SELECT account_id, delta INTO earned
  FROM xp_ledger WHERE idempotency_key = 'invoice_paid:' || p_invoice;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  RETURN award_xp(earned.account_id, -earned.delta, 'invoice_refunded', 'invoice', p_invoice,
                  'invoice_refunded:' || p_invoice, p_at);
END;
$$ LANGUAGE plpgsql;

-- Ligne de remise de fidélité sur les factures de renouvellement.
ALTER TABLE invoice_lines DROP CONSTRAINT invoice_lines_type_check;
ALTER TABLE invoice_lines ADD CONSTRAINT invoice_lines_type_check
  CHECK (type IN ('plan', 'proration_credit', 'proration_charge', 'tax', 'discount'));
