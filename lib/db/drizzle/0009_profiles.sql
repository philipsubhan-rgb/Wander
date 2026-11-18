-- Wander migration: traveler profile vault
-- (architecture-north-star §3.1/§3.3, Stories 5.1/5.2/5.3).
-- Adds `traveler_profiles` — one row per user, owned by that user.
-- date_of_birth / passport_number / emergency_contact are stored ONLY as
-- AES-256-GCM ciphertext (per-field, field name as GCM AAD — see
-- profileCrypto in the api-server); legal names, passport issuing
-- country / expiry / nationality, and phone are plaintext (expiry stays
-- queryable so validity checks never decrypt). Adds `profile_access_log`
-- — one row per vault decrypt (and per derived check): accessor, purpose,
-- field NAMES accessed, never values. Readable only by the profile owner;
-- no admin/super_admin read path exists, by design (§3.3).
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0009_profiles.sql

CREATE TABLE IF NOT EXISTS traveler_profiles (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legal_first_name text,
  legal_middle_name text,
  legal_last_name text,
  date_of_birth_enc text,
  passport_number_enc text,
  passport_issuing_country text,
  passport_expiry text,
  nationality text,
  phone text,
  emergency_contact_enc text,
  profile_version integer NOT NULL DEFAULT 1,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_access_log (
  id serial PRIMARY KEY,
  profile_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  accessor_kind text NOT NULL,
  accessor_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  purpose text NOT NULL,
  fields_accessed text[] NOT NULL DEFAULT '{}',
  booking_id integer,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS profile_access_log_profile_user_id_idx
  ON profile_access_log (profile_user_id, id);
