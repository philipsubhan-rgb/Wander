-- Wander migration: FlightAware watching / advisory pipeline
-- (architecture-north-star §6, international-foundation §4).
-- Adds `flight_watches` (one row per legacy flight leg under watch:
-- resolved FlightAware ident, AeroAPI alert registration id, and the
-- last_status_snapshot every incoming status is deduplicated against)
-- and `advisories` (first-class advisory records — an advisory never
-- books, moves, or charges anything; its proposal_payload is an
-- option-set REFERENCE, priced when presented, not when detected).
-- Dismissal is remembered via `situation` (signature + metric): a new
-- advisory for the same flight + kind fires only when the situation
-- worsens against the recorded one.
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0011_flight_watching.sql

CREATE TABLE IF NOT EXISTS flight_watches (
  id serial PRIMARY KEY,
  flight_id integer NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  ident text NOT NULL,
  departure_date text NOT NULL,
  fa_flight_id text,
  alert_id text,
  state text NOT NULL DEFAULT 'active',
  last_status_snapshot jsonb,
  snapshot_at timestamp,
  predeparture_checked_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS flight_watches_flight_id_unique
  ON flight_watches (flight_id);
CREATE INDEX IF NOT EXISTS flight_watches_state_idx
  ON flight_watches (state, departure_date);

CREATE TABLE IF NOT EXISTS advisories (
  id serial PRIMARY KEY,
  flight_watch_id integer NOT NULL REFERENCES flight_watches(id) ON DELETE CASCADE,
  flight_id integer NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind text NOT NULL,
  severity text NOT NULL,
  summary text NOT NULL,
  impact_summary text NOT NULL,
  impacts jsonb NOT NULL DEFAULT '[]'::jsonb,
  situation jsonb NOT NULL,
  proposal_payload jsonb,
  state text NOT NULL DEFAULT 'open',
  notified_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS advisories_trip_id_idx
  ON advisories (trip_id, id);
CREATE INDEX IF NOT EXISTS advisories_watch_kind_idx
  ON advisories (flight_watch_id, kind, id);
