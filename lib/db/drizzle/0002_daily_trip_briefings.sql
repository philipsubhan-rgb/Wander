-- Wander migration: daily trip briefings config table (per-trip send settings + send cache).
-- Creates the `trip_briefings` table with a one-to-one link to `trips`.
-- Apply on the production database (Replit) BEFORE redeploying the app, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0002_daily_trip_briefings.sql
-- or via `pnpm --filter @workspace/db push` from a shell with DATABASE_URL set.

CREATE TABLE IF NOT EXISTS trip_briefings (
  id serial PRIMARY KEY,
  trip_id integer NOT NULL UNIQUE REFERENCES trips(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT false,
  send_time_local text NOT NULL DEFAULT '07:00',
  timezone text NOT NULL DEFAULT 'America/New_York',
  extra_emails text[] NOT NULL DEFAULT '{}',
  cached_lat double precision,
  cached_lon double precision,
  last_sent_for_date text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
