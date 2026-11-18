-- Wander migration: Booking Gate extensions — stays execution support
-- + post-booking change/cancel (architecture-north-star §5.2/§5.4;
-- Stories E-3.2 remainder, E-3.4).
--
-- Adds `booking_operations`: the record of a change or cancellation
-- against a BOOKED ledger row. A cancellation runs its REVIEW-
-- equivalent discipline on this row (quoted → confirmed → executed:
-- provider refund/penalty/deadline terms are fetched and presented
-- BEFORE any confirmation, and nothing provider-side is confirmed
-- before the traveler confirms here). A change runs through the gate
-- itself as its own booking_attempt (the change offer is the option;
-- its snapshot carries the change context) and writes its operation
-- row at execution as the audit record, linked to the attempt.
--
-- The ledger lifecycle (bookings.status) gains "change_pending" —
-- status is a text column, so no DDL is needed for the new value; it
-- is recorded here for the migration trail: a booking moves
-- confirmed → change_pending when a change attempt against it is
-- confirmed, → changed on successful execution (back to confirmed if
-- the change execution fails), → cancelled on an executed cancel.
--
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0014_gate_extensions.sql

CREATE TABLE IF NOT EXISTS booking_operations (
  id serial PRIMARY KEY,
  booking_id integer NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  attempt_id integer REFERENCES booking_attempts(id) ON DELETE SET NULL,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'quoted',
  provider_operation_id text,
  refund_amount_minor integer,
  refund_currency text,
  refund_to text,
  penalty_amount_minor integer,
  penalty_currency text,
  delta_amount_minor integer,
  delta_currency text,
  new_total_amount_minor integer,
  new_total_currency text,
  terms_text text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamp,
  confirmed_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamp,
  executed_at timestamp,
  failure_reason text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_operations_booking_idx
  ON booking_operations (booking_id);
CREATE INDEX IF NOT EXISTS booking_operations_trip_idx
  ON booking_operations (trip_id);
