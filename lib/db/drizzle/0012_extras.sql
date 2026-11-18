-- Wander migration: extras suggestions (the extras pass)
-- (architecture-north-star §7; GOAL.md "Extras thinking"; TC-8).
-- Adds `extras_suggestions`: one row per (trip, item) the extras pass
-- has ever surfaced. The unique (trip_id, item_key) index is both the
-- pass's idempotency mechanism (re-running a pass inserts only new
-- item keys) and its dismissal memory (a dismissed item can never
-- re-suggest). Prices are integer minor units + ISO currency with an
-- always-explicit price_nature (firm | estimate | quote); quote-only
-- and note-only items carry no amount — an invented firm price is a
-- defect. Suggestions are never bookings: accepting one records the
-- traveler's intent; arranging rides the Booking Gate / Concierge.
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0012_extras.sql

CREATE TABLE IF NOT EXISTS extras_suggestions (
  id serial PRIMARY KEY,
  trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  pack text NOT NULL,
  item_key text NOT NULL,
  title text NOT NULL,
  detail text NOT NULL,
  detail_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  price_amount_minor integer,
  price_currency text,
  price_nature text,
  state text NOT NULL DEFAULT 'suggested',
  trigger text NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS extras_suggestions_trip_item_unique
  ON extras_suggestions (trip_id, item_key);
CREATE INDEX IF NOT EXISTS extras_suggestions_trip_state_idx
  ON extras_suggestions (trip_id, state);
