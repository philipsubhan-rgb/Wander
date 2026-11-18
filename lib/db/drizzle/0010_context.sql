-- Wander migration: context layer store
-- (architecture-north-star §4.1, Stories 6.1/6.3/6.4).
-- Adds `traveler_context` (one row per user: home base + ordered home
-- airports; learned values carry source + confirmed — a learned value is
-- proposed, never the default, until the traveler confirms it),
-- `traveler_rules` (hard rules FILTER, preferences RANK — §4.2; typed
-- rule_type + jsonb params, never free text; scope all|work|personal;
-- source explicit|learned), `traveler_companions` (only what the
-- organizer provided — name/email — plus an optional link to that
-- traveler's own user record; never their private data), and
-- `saved_groups` (named sets of companion references).
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0010_context.sql

CREATE TABLE IF NOT EXISTS traveler_context (
  user_id integer PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  home_base text,
  home_base_lat double precision,
  home_base_lon double precision,
  home_base_source text,
  home_base_confirmed boolean NOT NULL DEFAULT false,
  home_airports jsonb NOT NULL DEFAULT '[]'::jsonb,
  home_airports_source text,
  home_airports_confirmed boolean NOT NULL DEFAULT false,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS traveler_rules (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rule_class text NOT NULL,
  rule_type text NOT NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  scope text NOT NULL DEFAULT 'all',
  source text NOT NULL DEFAULT 'explicit',
  active boolean NOT NULL DEFAULT true,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS traveler_rules_user_id_idx
  ON traveler_rules (user_id, id);

CREATE TABLE IF NOT EXISTS traveler_companions (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  email text,
  linked_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS traveler_companions_user_id_idx
  ON traveler_companions (user_id, id);

CREATE TABLE IF NOT EXISTS saved_groups (
  id serial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  member_companion_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS saved_groups_user_id_idx
  ON saved_groups (user_id, id);
