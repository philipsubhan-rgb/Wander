-- Wander migration: calendar write-back for ALL itinerary item kinds.
-- Migration 0005 created `calendar_event_links` for reservations only;
-- this widens the same table (same idempotency: link + payload hash) to
-- flights, accommodations (stays), and car rentals — gate-booked and
-- manually added alike (architecture-north-star §6/§9).
-- Apply on the database BEFORE redeploying, e.g.:
--   psql "$DATABASE_URL" -f lib/db/drizzle/0016_calendar_item_links.sql

ALTER TABLE calendar_event_links
  ADD COLUMN IF NOT EXISTS item_type text NOT NULL DEFAULT 'reservation';
ALTER TABLE calendar_event_links
  ADD COLUMN IF NOT EXISTS flight_id integer REFERENCES flights(id) ON DELETE CASCADE;
ALTER TABLE calendar_event_links
  ADD COLUMN IF NOT EXISTS accommodation_id integer REFERENCES accommodations(id) ON DELETE CASCADE;
ALTER TABLE calendar_event_links
  ADD COLUMN IF NOT EXISTS car_rental_id integer REFERENCES car_rentals(id) ON DELETE CASCADE;

-- Reservation links predate item_type; their reservation_id was NOT NULL.
-- It becomes nullable so the other kinds can leave it empty — exactly one
-- item FK is set per row, matching item_type.
ALTER TABLE calendar_event_links
  ALTER COLUMN reservation_id DROP NOT NULL;

ALTER TABLE calendar_event_links
  DROP CONSTRAINT IF EXISTS calendar_event_links_one_item_ck;
ALTER TABLE calendar_event_links
  ADD CONSTRAINT calendar_event_links_one_item_ck CHECK (
    (item_type = 'reservation'   AND reservation_id   IS NOT NULL AND flight_id IS NULL AND accommodation_id IS NULL AND car_rental_id IS NULL) OR
    (item_type = 'flight'        AND flight_id        IS NOT NULL AND reservation_id IS NULL AND accommodation_id IS NULL AND car_rental_id IS NULL) OR
    (item_type = 'accommodation' AND accommodation_id IS NOT NULL AND reservation_id IS NULL AND flight_id IS NULL AND car_rental_id IS NULL) OR
    (item_type = 'car_rental'    AND car_rental_id    IS NOT NULL AND reservation_id IS NULL AND flight_id IS NULL AND accommodation_id IS NULL)
  );

-- Postgres treats NULLs as distinct in unique indexes, so each of these
-- constrains only the rows of its own kind.
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_links_account_flight_idx
  ON calendar_event_links (account_id, flight_id);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_links_account_accommodation_idx
  ON calendar_event_links (account_id, accommodation_id);
CREATE UNIQUE INDEX IF NOT EXISTS calendar_event_links_account_car_rental_idx
  ON calendar_event_links (account_id, car_rental_id);
CREATE INDEX IF NOT EXISTS calendar_event_links_flight_idx
  ON calendar_event_links (flight_id);
CREATE INDEX IF NOT EXISTS calendar_event_links_accommodation_idx
  ON calendar_event_links (accommodation_id);
CREATE INDEX IF NOT EXISTS calendar_event_links_car_rental_idx
  ON calendar_event_links (car_rental_id);
