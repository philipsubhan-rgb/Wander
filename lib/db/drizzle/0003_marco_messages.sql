-- Wander migration: Marco conversation memory (per-trip, per-user chat history).
-- Creates the `marco_messages` table so the agent remembers earlier sessions,
-- not just the current page view. Only plain user/assistant text turns are
-- stored; tool-call transcripts are excluded by design.
-- Apply on the production database (Replit) BEFORE redeploying the app, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0003_marco_messages.sql
-- or via `pnpm --filter @workspace/db push` from a shell with DATABASE_URL set.

CREATE TABLE IF NOT EXISTS marco_messages (
  id serial PRIMARY KEY,
  trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS marco_messages_trip_user_id_idx ON marco_messages (trip_id, user_id, id);
