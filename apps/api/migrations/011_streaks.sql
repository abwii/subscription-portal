-- ADR-001 #14 : séries. Nombre de périodes de facturation consécutives payées dans les délais (sans passage
-- en past_due). Une période compte quand sa facture (checkout ou renouvellement) est payée alors que
-- l'abonnement n'était pas en retard ; un paiement rattrapé pendant la grâce ne casse pas la série mais ne
-- compte pas. Une pause la gèle. Un past_due non rattrapé après la grâce la remet à 0 (job). Un bonus de 50 XP
-- est accordé à chaque 3e période consécutive.

ALTER TABLE loyalty_accounts
  ADD COLUMN streak_current integer NOT NULL DEFAULT 0 CHECK (streak_current >= 0),
  ADD COLUMN streak_best    integer NOT NULL DEFAULT 0,
  -- Numéro de série : change à chaque remise à zéro, pour qu'une nouvelle série regagne ses bonus.
  ADD COLUMN streak_run     integer NOT NULL DEFAULT 0;

-- Une facture ne fait avancer la série qu'une fois ; garde aussi l'historique.
CREATE TABLE streak_progress (
  invoice_id   uuid PRIMARY KEY REFERENCES invoices (id),
  account_id   uuid NOT NULL REFERENCES accounts (id),
  streak_after integer NOT NULL,
  created_at   timestamptz NOT NULL
);

-- Fait avancer la série du compte pour cette facture. `false` si elle avait déjà compté.
CREATE FUNCTION advance_streak(p_account uuid, p_invoice uuid, p_at timestamptz) RETURNS boolean AS $$
DECLARE
  inserted integer;
  new_streak integer;
  current_run integer;
BEGIN
  INSERT INTO streak_progress (invoice_id, account_id, streak_after, created_at)
  VALUES (p_invoice, p_account, 0, p_at)
  ON CONFLICT (invoice_id) DO NOTHING;
  GET DIAGNOSTICS inserted = ROW_COUNT;
  IF inserted = 0 THEN
    RETURN false;
  END IF;

  INSERT INTO loyalty_accounts (account_id, xp_total, tier_id, tier_since)
  VALUES (p_account, 0, (SELECT id FROM loyalty_tiers WHERE rank = 0), p_at)
  ON CONFLICT (account_id) DO NOTHING;

  UPDATE loyalty_accounts
  SET streak_current = streak_current + 1,
      streak_best = GREATEST(streak_best, streak_current + 1)
  WHERE account_id = p_account
  RETURNING streak_current, streak_run INTO new_streak, current_run;

  UPDATE streak_progress SET streak_after = new_streak WHERE invoice_id = p_invoice;

  IF new_streak % 3 = 0 THEN
    PERFORM award_xp(p_account, 50, 'streak_bonus', 'streak', NULL,
                     'streak_bonus:' || p_account || ':' || current_run || ':' || new_streak, p_at);
  END IF;
  RETURN true;
END;
$$ LANGUAGE plpgsql;
