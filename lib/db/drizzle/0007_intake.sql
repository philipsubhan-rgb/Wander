-- Wander migration: conversational planner intake, rung 1
-- (architecture-north-star §2/§3.2, ADR-2/ADR-3/ADR-5).
-- Adds `intake_sessions` (server-side intake state machine), the
-- `trip_roster_entries` table (party assembly decoupled from user
-- accounts), and the ADR-3 conversation-scope change on `marco_messages`:
-- trip_id becomes nullable and an intake_session_id scope is added, with
-- a check constraint that exactly one scope is set per row. At intake
-- materialization the session's message rows are re-keyed to the new
-- trip (trip_id set, intake_session_id cleared).
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0007_intake.sql

CREATE TABLE IF NOT EXISTS intake_sessions (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'OPENING',
  slots jsonb NOT NULL DEFAULT '{}',
  open_items jsonb NOT NULL DEFAULT '[]',
  draft_trip_id integer REFERENCES trips(id) ON DELETE SET NULL,
  channel text NOT NULL DEFAULT 'text',
  questions_asked integer NOT NULL DEFAULT 0,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS intake_sessions_user_id_idx ON intake_sessions (user_id, id);

CREATE TABLE IF NOT EXISTS trip_roster_entries (
  id serial PRIMARY KEY,
  trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  invited_name text NOT NULL,
  invited_email text,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'invited',
  required_fields_profile jsonb,
  missing_fields jsonb,
  chase_state jsonb,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS trip_roster_entries_trip_id_idx ON trip_roster_entries (trip_id, id);
CREATE INDEX IF NOT EXISTS trip_roster_entries_user_id_idx ON trip_roster_entries (user_id);

ALTER TABLE marco_messages ALTER COLUMN trip_id DROP NOT NULL;
ALTER TABLE marco_messages
  ADD COLUMN IF NOT EXISTS intake_session_id integer REFERENCES intake_sessions(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS marco_messages_intake_user_id_idx
  ON marco_messages (intake_session_id, user_id, id);

-- Exactly one conversation scope per row (ADR-3). Guarded so a re-run of
-- this file does not fail on the already-existing constraint.
DO $$
BEGIN
  ALTER TABLE marco_messages
    ADD CONSTRAINT marco_messages_exactly_one_scope
    CHECK ((trip_id IS NOT NULL AND intake_session_id IS NULL)
        OR (trip_id IS NULL AND intake_session_id IS NOT NULL));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
