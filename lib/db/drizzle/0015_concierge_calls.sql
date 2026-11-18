-- Wander migration: Concierge / Call Service (architecture-north-star
-- §6.5; Stories 4.1–4.5).
--
-- Adds `call_briefs` and `call_tasks`: the white-glove phone-call
-- layer. A call is an execution channel, so it carries the Booking
-- Gate's discipline in its own tables:
--
--   * No call exists without a brief. `call_briefs` is the finalized,
--     stored instruction set (callee, exact ask, ranked fallbacks,
--     may-not-agree list, money-typed spending cap, duration cap).
--     Amending a brief creates a new version and supersedes the old
--     row — briefs are never silently edited.
--   * A spend-authorizing brief must be traveler-confirmed before any
--     dial (and, per §2.4, never on the voice channel — enforced in
--     the service). `authority_kind = 'info_only'` briefs carry no cap
--     and can never produce a booking.
--   * `call_tasks` is one dial attempt: provider ids, transcript,
--     the structured outcome report, duration, and the telephony cost
--     estimate. Successful outcomes write ledger bookings with
--     source = 'phone' (existing table, no DDL needed).
--   * Virtual-card DETAILS are never stored anywhere — a task row
--     holds only the instrument reference.
--
-- Also note: the profile access-log purpose list gains
-- 'call_execution' (vault reads that prepare a brief). The purpose
-- column is plain text, so no DDL is needed for the new value; it is
-- recorded here for the migration trail.
--
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0015_concierge_calls.sql

CREATE TABLE IF NOT EXISTS call_briefs (
  id serial PRIMARY KEY,
  trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  booking_attempt_id integer,
  booking_id integer,
  extras_suggestion_id integer REFERENCES extras_suggestions(id) ON DELETE SET NULL,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'draft',
  category text,
  visibility text NOT NULL DEFAULT 'shared',
  callee_name text NOT NULL,
  callee_phone text NOT NULL,
  traveler_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  traveler_name_on_reservation text,
  covered_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  ask text NOT NULL,
  reservation_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  party_size integer,
  service_date text,
  service_time_window text,
  fallbacks jsonb NOT NULL DEFAULT '[]'::jsonb,
  may_not_agree jsonb NOT NULL DEFAULT '[]'::jsonb,
  authority_kind text NOT NULL DEFAULT 'spend',
  authority_limit_amount_minor integer,
  authority_limit_currency text,
  tolerance_amount_minor integer NOT NULL DEFAULT 0,
  payment_may_be_required boolean NOT NULL DEFAULT false,
  duration_cap_seconds integer NOT NULL DEFAULT 600,
  callback_number text,
  version integer NOT NULL DEFAULT 1,
  supersedes_brief_id integer,
  created_by_user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  presented_at timestamp,
  confirmed_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS call_briefs_trip_idx
  ON call_briefs (trip_id, state);
CREATE INDEX IF NOT EXISTS call_briefs_attempt_idx
  ON call_briefs (booking_attempt_id);

CREATE TABLE IF NOT EXISTS call_tasks (
  id serial PRIMARY KEY,
  brief_id integer NOT NULL REFERENCES call_briefs(id) ON DELETE CASCADE,
  trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'queued',
  attempt_number integer NOT NULL DEFAULT 1,
  provider text,
  provider_call_id text,
  provider_status text,
  payment_instrument_ref text,
  started_at timestamp,
  ended_at timestamp,
  duration_seconds integer,
  telephony_cost_minor integer,
  telephony_cost_currency text,
  recording_ref text,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  outcome jsonb,
  outcome_text text,
  booking_id integer,
  failure_reason text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS call_tasks_brief_idx
  ON call_tasks (brief_id, state);
CREATE INDEX IF NOT EXISTS call_tasks_trip_idx
  ON call_tasks (trip_id);
CREATE INDEX IF NOT EXISTS call_tasks_provider_call_idx
  ON call_tasks (provider_call_id);
