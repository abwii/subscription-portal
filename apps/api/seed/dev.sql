-- Données de développement local uniquement. Idempotent.
INSERT INTO plans (code, name, rank) VALUES
  ('basic', 'Basic', 1),
  ('pro', 'Pro', 2)
ON CONFLICT (code) DO NOTHING;

INSERT INTO plan_prices (plan_id, "interval", amount_cents, currency)
SELECT p.id, v.interval, v.amount_cents, 'EUR'
FROM (VALUES
  ('basic', 'month', 999), ('basic', 'year', 9900),
  ('pro', 'month', 1999), ('pro', 'year', 19900)
) AS v (code, interval, amount_cents)
JOIN plans p ON p.code = v.code
ON CONFLICT DO NOTHING;

INSERT INTO entitlements (code, kind) VALUES
  ('projects', 'limit'),
  ('export', 'boolean')
ON CONFLICT (code) DO NOTHING;

INSERT INTO plan_entitlements (plan_id, entitlement_id, limit_value)
SELECT p.id, e.id, v.limit_value
FROM (VALUES
  ('basic', 'projects', 3), ('pro', 'projects', 50), ('pro', 'export', NULL::integer)
) AS v (plan_code, ent_code, limit_value)
JOIN plans p ON p.code = v.plan_code
JOIN entitlements e ON e.code = v.ent_code
ON CONFLICT DO NOTHING;

-- Compte de démo : X-Account-Id: 00000000-0000-4000-8000-000000000001 (avec DEV_AUTH=true).
INSERT INTO accounts (id, email) VALUES
  ('00000000-0000-4000-8000-000000000001', 'demo@example.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO subscriptions (account_id, plan_price_id, status, current_period_start, current_period_end)
SELECT '00000000-0000-4000-8000-000000000001', pp.id, 'active', now(), now() + interval '30 days'
FROM plan_prices pp JOIN plans p ON p.id = pp.plan_id
WHERE p.code = 'pro' AND pp."interval" = 'month' AND pp.active
ON CONFLICT DO NOTHING;
