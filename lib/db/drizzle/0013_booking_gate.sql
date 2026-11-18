-- Wander migration: the Booking Gate + Booking Ledger
-- (architecture-north-star §5.2–§5.4; Stories 3.1–3.3, 7.1/7.2/7.4).
-- Adds `booking_attempts` (the one gate state machine every booking
-- passes through: presented → reverifying → review → confirmed →
-- executing → booked | failed — no execution path skips confirmation),
-- `booking_attempt_travelers` (coverage + per-traveler confirmation
-- tracking), `bookings` (the canonical ledger; legacy itinerary rows
-- are projections written FROM it), `booking_travelers` (ledger
-- coverage / Story 3.2 attribution), `booking_splits` (charge-currency
-- cost shares, remainder to organizer) and `commission_records`
-- (per-booking commission; a booking with no rail records `no_rail`
-- explicitly with a machine-readable reason — never a null).
-- All money is integer minor units + ISO currency (charge currency
-- untouched; home equivalents only with an FX snapshot behind them).
-- Visibility (shared | private) is canonical on the attempt and the
-- ledger row: concierge-category items default to private.
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0013_booking_gate.sql

CREATE TABLE IF NOT EXISTS booking_attempts (
  id serial PRIMARY KEY,
  trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind text NOT NULL,
  adapter text,
  supplier text NOT NULL,
  option_id text NOT NULL,
  option_snapshot jsonb NOT NULL,
  state text NOT NULL DEFAULT 'presented',
  visibility text NOT NULL DEFAULT 'shared',
  category text,
  presented_amount_minor integer NOT NULL,
  presented_currency text NOT NULL,
  reviewed_amount_minor integer,
  reviewed_currency text,
  review_version integer NOT NULL DEFAULT 0,
  home_equivalent_minor integer,
  home_currency text,
  fx_snapshot_id integer,
  change_terms text,
  cancel_terms text,
  why_this_option text NOT NULL DEFAULT 'traveler_chose',
  why_this_option_text text,
  ranking_inputs_hash text,
  execution_channel text,
  confirmed_by_user_id integer REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at timestamp,
  failure_reason text,
  booking_id integer,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_attempts_trip_state_idx
  ON booking_attempts (trip_id, state);
CREATE INDEX IF NOT EXISTS booking_attempts_booking_idx
  ON booking_attempts (booking_id);

CREATE TABLE IF NOT EXISTS booking_attempt_travelers (
  id serial PRIMARY KEY,
  attempt_id integer NOT NULL REFERENCES booking_attempts(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  roster_entry_id integer REFERENCES trip_roster_entries(id) ON DELETE SET NULL,
  is_payer boolean NOT NULL DEFAULT false,
  confirmed_at timestamp,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_attempt_travelers_attempt_idx
  ON booking_attempt_travelers (attempt_id);

CREATE TABLE IF NOT EXISTS bookings (
  id serial PRIMARY KEY,
  attempt_id integer REFERENCES booking_attempts(id) ON DELETE SET NULL,
  trip_id integer NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind text NOT NULL,
  supplier text NOT NULL,
  confirmation_code text,
  status text NOT NULL DEFAULT 'confirmed',
  source text NOT NULL DEFAULT 'api_rail',
  charge_amount_minor integer NOT NULL,
  charge_currency text NOT NULL,
  amount_actually_charged_minor integer,
  home_equivalent_minor integer,
  home_currency text,
  fx_snapshot_id integer,
  merchant_of_record text NOT NULL,
  change_terms text,
  cancel_terms text,
  why_this_option text NOT NULL DEFAULT 'traveler_chose',
  why_this_option_text text,
  ranking_inputs_hash text,
  visibility text NOT NULL DEFAULT 'shared',
  rail_provider text,
  rail_order_fee_minor integer,
  rail_pct_fee_minor integer,
  rail_fee_currency text,
  processing_fee_minor integer,
  cost_attribution jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_order_id text,
  flight_id integer REFERENCES flights(id) ON DELETE SET NULL,
  accommodation_id integer REFERENCES accommodations(id) ON DELETE SET NULL,
  reservation_id integer REFERENCES reservations(id) ON DELETE SET NULL,
  car_rental_id integer REFERENCES car_rentals(id) ON DELETE SET NULL,
  projection jsonb NOT NULL DEFAULT '{}'::jsonb,
  flightaware_ident text,
  alert_registration_id text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS bookings_trip_idx ON bookings (trip_id);
CREATE INDEX IF NOT EXISTS bookings_attempt_idx ON bookings (attempt_id);

CREATE TABLE IF NOT EXISTS booking_travelers (
  id serial PRIMARY KEY,
  booking_id integer NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  roster_entry_id integer REFERENCES trip_roster_entries(id) ON DELETE SET NULL,
  is_payer boolean NOT NULL DEFAULT false,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_travelers_booking_idx
  ON booking_travelers (booking_id);

CREATE TABLE IF NOT EXISTS booking_splits (
  id serial PRIMARY KEY,
  booking_id integer NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id integer REFERENCES users(id) ON DELETE SET NULL,
  roster_entry_id integer REFERENCES trip_roster_entries(id) ON DELETE SET NULL,
  share_amount_minor integer NOT NULL,
  share_currency text NOT NULL,
  created_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS booking_splits_booking_idx
  ON booking_splits (booking_id);

CREATE TABLE IF NOT EXISTS commission_records (
  id serial PRIMARY KEY,
  booking_id integer NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  partner_program text,
  basis text,
  rate_bps integer,
  expected_amount_minor integer,
  expected_currency text,
  status text NOT NULL,
  no_rail_reason text,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS commission_records_booking_idx
  ON commission_records (booking_id);
