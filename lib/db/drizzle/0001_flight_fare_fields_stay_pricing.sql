-- Wander migration: structured flight fare fields, airport timezones, stay pricing.
-- Additive only: new nullable columns plus one NOT NULL column with a default.
-- Apply on the production database (Replit) BEFORE redeploying the app, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0001_flight_fare_fields_stay_pricing.sql
-- or via `pnpm --filter @workspace/db push` from a shell with DATABASE_URL set.

ALTER TABLE flights ADD COLUMN IF NOT EXISTS departure_timezone text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS arrival_timezone text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS total_price numeric(12, 2);
ALTER TABLE flights ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
ALTER TABLE flights ADD COLUMN IF NOT EXISTS fare_brand text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS refundable boolean;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS changeable boolean;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS checked_bags text;
ALTER TABLE flights ADD COLUMN IF NOT EXISTS passenger_count integer;

ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS nightly_rate numeric(12, 2);
ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS total_price numeric(12, 2);
ALTER TABLE accommodations ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'USD';
