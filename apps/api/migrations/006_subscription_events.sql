-- ADR-001 #8 : journal des événements d'abonnement (append-only), source d'audit des transitions
-- (pause, reprise, annulation) et du quota « une pause par 12 mois ».

CREATE TABLE subscription_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id uuid NOT NULL REFERENCES subscriptions (id),
  type            text NOT NULL,
  data            jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL
);
CREATE INDEX subscription_events_lookup
  ON subscription_events (subscription_id, type, created_at DESC);

-- Append-only : ni modification ni suppression.
CREATE FUNCTION forbid_event_edit() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'subscription_events is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER subscription_events_append_only
  BEFORE UPDATE OR DELETE ON subscription_events
  FOR EACH ROW EXECUTE FUNCTION forbid_event_edit();
