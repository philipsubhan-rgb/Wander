-- Wander migration: Gmail reservation ingestion (connected accounts + proposals).
-- `connected_accounts` holds OAuth refresh tokens ENCRYPTED (AES-256-GCM, KEK
-- from CREDENTIALS_KEK) — never plaintext. `reservation_proposals` holds
-- parsed booking confirmations awaiting user approval (propose-first).
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0004_gmail_ingest.sql

CREATE TABLE IF NOT EXISTS connected_accounts (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'google',
  email text NOT NULL,
  encrypted_refresh_token text NOT NULL,
  scopes text,
  last_history_id text,
  last_scan_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT connected_accounts_user_email_uniq UNIQUE (user_id, provider, email)
);
CREATE INDEX IF NOT EXISTS connected_accounts_user_id_idx ON connected_accounts (user_id);

CREATE TABLE IF NOT EXISTS reservation_proposals (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id integer REFERENCES connected_accounts(id) ON DELETE SET NULL,
  trip_id integer REFERENCES trips(id) ON DELETE CASCADE,
  message_id text NOT NULL,
  subject text,
  sender text,
  received_at timestamp,
  parsed jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  created_at timestamp DEFAULT now() NOT NULL,
  CONSTRAINT reservation_proposals_account_message_uniq UNIQUE (account_id, message_id)
);
CREATE INDEX IF NOT EXISTS reservation_proposals_user_status_idx ON reservation_proposals (user_id, status);
