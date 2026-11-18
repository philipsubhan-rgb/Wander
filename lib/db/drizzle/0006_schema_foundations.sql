-- Wander migration: schema foundations for the international build
-- (architecture Step 1 / international-foundation §5 checklist).
-- Adds traveler profile locale fields to `users` (all nullable, no behavior
-- change yet) and `fx_rate_snapshots`, the provenance record every converted
-- money display/confirmation will reference. Money itself lives in the
-- shared @workspace/money library — new tables are born money-typed
-- (amount_minor INTEGER + currency), legacy numeric(12,2) tables are NOT
-- touched here (boundary converter, ADR-6).
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0006_schema_foundations.sql

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS locale text;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS home_currency text;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone text;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS conversation_language text;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS notification_channels jsonb;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS quiet_hours_start text;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS quiet_hours_end text;

CREATE TABLE IF NOT EXISTS fx_rate_snapshots (
  id serial PRIMARY KEY,
  base_currency text NOT NULL,
  quote_currency text NOT NULL,
  rate numeric(18, 10) NOT NULL,
  source text NOT NULL,
  as_of timestamp NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS fx_rate_snapshots_pair_source_asof_idx
  ON fx_rate_snapshots (base_currency, quote_currency, source, as_of);
CREATE INDEX IF NOT EXISTS fx_rate_snapshots_pair_asof_idx
  ON fx_rate_snapshots (base_currency, quote_currency, as_of);
