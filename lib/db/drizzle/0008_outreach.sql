-- Wander migration: party assembly & outreach
-- (architecture-north-star §3.4/§3.5, Stories 4.1/4.2/4.3).
-- Adds `traveler_invite_tokens`: one row per issued setup link for a
-- trip_roster_entries row. Only the SHA-256 hash of the raw token is
-- stored; the raw token exists only in the emailed link. Reissue deletes
-- prior unused rows for the entry (invalidating the old link); the setup
-- submission consumes the token via used_at. Chase state itself lives in
-- trip_roster_entries.chase_state (jsonb, added by 0007) — no new columns
-- needed there.
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0008_outreach.sql

CREATE TABLE IF NOT EXISTS traveler_invite_tokens (
  id serial PRIMARY KEY,
  roster_entry_id integer NOT NULL REFERENCES trip_roster_entries(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamp NOT NULL,
  used_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS traveler_invite_tokens_roster_entry_id_idx
  ON traveler_invite_tokens (roster_entry_id);
