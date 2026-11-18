-- Wander migration: Google Calendar write-back for accepted bookings.
-- Adds per-account write-back opt-in + the dedicated "Wander" calendar ID to
-- `connected_accounts`, and `calendar_event_links` to remember which Google
-- Calendar event belongs to which reservation (idempotent update/delete).
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0005_calendar_writeback.sql

ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS calendar_writeback_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE connected_accounts
  ADD COLUMN IF NOT EXISTS calendar_id text;

CREATE TABLE IF NOT EXISTS calendar_event_links (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id integer NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
  reservation_id integer NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  google_calendar_id text NOT NULL,
  google_event_id text NOT NULL,
  last_synced_hash text NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT calendar_event_links_account_reservation_uniq UNIQUE (account_id, reservation_id)
);
CREATE INDEX IF NOT EXISTS calendar_event_links_reservation_idx ON calendar_event_links (reservation_id);
CREATE INDEX IF NOT EXISTS calendar_event_links_user_idx ON calendar_event_links (user_id);
