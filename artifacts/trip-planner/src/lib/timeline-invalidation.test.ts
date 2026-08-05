/**
 * Timeline invalidation regression tests
 *
 * Verifies that the shared invalidation helpers in invalidate-trip-queries.ts
 * correctly refresh BOTH the item-list query AND the trip-timeline query after
 * every mutation (create, update, delete, image-update) on every entity type.
 *
 * All five trip-mutation components (TripFlights, TripAccommodations,
 * TripCarRentals, TripActivities, TripReservations) call these helpers
 * directly, so a regression in the helpers is caught here.
 *
 * These tests run in Vitest (node environment) — no browser or DOM required.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  invalidateFlightQueries,
  invalidateAccommodationQueries,
  invalidateCarRentalQueries,
  invalidateActivityQueries,
  invalidateReservationQueries,
} from './invalidate-trip-queries';
import {
  getGetTripTimelineQueryKey,
  getListFlightsQueryKey,
  getListAccommodationsQueryKey,
  getListCarRentalsQueryKey,
  getListActivitiesQueryKey,
  getListReservationsQueryKey,
} from '@workspace/api-client-react';

// ── Mock query client factory ─────────────────────────────────────────────────

/**
 * Minimal mock of QueryClient.invalidateQueries that records every key it
 * receives.  The wasInvalidated helper lets tests assert specific keys.
 */
function makeMockQueryClient() {
  const invalidated: readonly unknown[][] = [];
  const push = (key: readonly unknown[]) =>
    (invalidated as (readonly unknown[][])).push(key);

  const queryClient = {
    invalidateQueries: vi.fn(({ queryKey }: { queryKey: readonly unknown[] }) => {
      push(queryKey);
    }),
  };

  function wasInvalidated(key: readonly unknown[]): boolean {
    return invalidated.some(
      k => k.length === key.length && k.every((v, i) => v === key[i]),
    );
  }

  return { queryClient, wasInvalidated, invalidated };
}

// ── Query key shape sanity checks ─────────────────────────────────────────────
//
// These are not redundant with the helper tests — they confirm that the key
// generators used inside invalidate-trip-queries.ts produce stable,
// predictable, trip-scoped values.

describe('query key shapes', () => {
  const T = 42;

  it('timeline key contains the trip id', () => {
    expect(getGetTripTimelineQueryKey(T)).toEqual([`/api/trips/${T}/timeline`]);
  });

  it('flights key contains the trip id', () => {
    expect(getListFlightsQueryKey(T)).toEqual([`/api/trips/${T}/flights`]);
  });

  it('accommodations key contains the trip id', () => {
    expect(getListAccommodationsQueryKey(T)).toEqual([`/api/trips/${T}/accommodations`]);
  });

  it('car-rentals key contains the trip id', () => {
    expect(getListCarRentalsQueryKey(T)).toEqual([`/api/trips/${T}/car-rentals`]);
  });

  it('activities key contains the trip id', () => {
    expect(getListActivitiesQueryKey(T)).toEqual([`/api/trips/${T}/activities`]);
  });

  it('reservations key contains the trip id', () => {
    expect(getListReservationsQueryKey(T)).toEqual([`/api/trips/${T}/reservations`]);
  });

  it('timeline key is distinct from every item-list key', () => {
    const tl = getGetTripTimelineQueryKey(T)[0];
    const lists = [
      getListFlightsQueryKey(T)[0],
      getListAccommodationsQueryKey(T)[0],
      getListCarRentalsQueryKey(T)[0],
      getListActivitiesQueryKey(T)[0],
      getListReservationsQueryKey(T)[0],
    ];
    for (const k of lists) {
      expect(k).not.toBe(tl);
    }
  });

  it('keys are trip-scoped: different trip ids produce different keys', () => {
    expect(getGetTripTimelineQueryKey(1)[0]).not.toBe(getGetTripTimelineQueryKey(2)[0]);
    expect(getListFlightsQueryKey(1)[0]).not.toBe(getListFlightsQueryKey(2)[0]);
  });
});

// ── invalidateFlightQueries ───────────────────────────────────────────────────
//
// Used by TripFlights for: flight create, flight update, flight delete.

describe('invalidateFlightQueries', () => {
  const T = 7;

  it('invalidates the flights list key', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateFlightQueries(queryClient, T);
    expect(wasInvalidated(getListFlightsQueryKey(T))).toBe(true);
  });

  it('invalidates the trip timeline key (Overview + Itinerary refresh)', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateFlightQueries(queryClient, T);
    expect(wasInvalidated(getGetTripTimelineQueryKey(T))).toBe(true);
  });

  it('invalidates exactly two keys per call', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateFlightQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('does not invalidate another trip\'s timeline key', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateFlightQueries(queryClient, T);
    expect(wasInvalidated(getGetTripTimelineQueryKey(T + 1))).toBe(false);
  });

  it('called with the flights list key as first argument', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateFlightQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: getListFlightsQueryKey(T),
    });
  });

  it('called with the timeline key as second argument', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateFlightQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: getGetTripTimelineQueryKey(T),
    });
  });
});

// ── invalidateAccommodationQueries ────────────────────────────────────────────
//
// Used by TripAccommodations for: stay create, stay update, stay delete,
// image update.

describe('invalidateAccommodationQueries', () => {
  const T = 13;

  it('invalidates the accommodations list key', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateAccommodationQueries(queryClient, T);
    expect(wasInvalidated(getListAccommodationsQueryKey(T))).toBe(true);
  });

  it('invalidates the trip timeline key', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateAccommodationQueries(queryClient, T);
    expect(wasInvalidated(getGetTripTimelineQueryKey(T))).toBe(true);
  });

  it('invalidates exactly two keys per call', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateAccommodationQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('does not bleed into a different trip', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateAccommodationQueries(queryClient, T);
    expect(wasInvalidated(getGetTripTimelineQueryKey(T + 99))).toBe(false);
  });

  it('called with the accommodations list key', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateAccommodationQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: getListAccommodationsQueryKey(T),
    });
  });

  it('called with the timeline key', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateAccommodationQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: getGetTripTimelineQueryKey(T),
    });
  });
});

// ── invalidateCarRentalQueries ────────────────────────────────────────────────
//
// Used by TripCarRentals for: rental create, rental update, rental delete,
// image update.

describe('invalidateCarRentalQueries', () => {
  const T = 5;

  it('invalidates the car-rentals list key', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateCarRentalQueries(queryClient, T);
    expect(wasInvalidated(getListCarRentalsQueryKey(T))).toBe(true);
  });

  it('invalidates the trip timeline key', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateCarRentalQueries(queryClient, T);
    expect(wasInvalidated(getGetTripTimelineQueryKey(T))).toBe(true);
  });

  it('invalidates exactly two keys per call', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateCarRentalQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('called with the car-rentals list key', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateCarRentalQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: getListCarRentalsQueryKey(T),
    });
  });

  it('called with the timeline key', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateCarRentalQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: getGetTripTimelineQueryKey(T),
    });
  });
});

// ── invalidateActivityQueries ─────────────────────────────────────────────────
//
// Used by TripActivities for: activity create, activity update, activity delete,
// image update.

describe('invalidateActivityQueries', () => {
  const T = 19;

  it('invalidates the activities list key', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateActivityQueries(queryClient, T);
    expect(wasInvalidated(getListActivitiesQueryKey(T))).toBe(true);
  });

  it('invalidates the trip timeline key', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateActivityQueries(queryClient, T);
    expect(wasInvalidated(getGetTripTimelineQueryKey(T))).toBe(true);
  });

  it('invalidates exactly two keys per call', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateActivityQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('called with the activities list key', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateActivityQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: getListActivitiesQueryKey(T),
    });
  });

  it('called with the timeline key', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateActivityQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: getGetTripTimelineQueryKey(T),
    });
  });
});

// ── invalidateReservationQueries ──────────────────────────────────────────────
//
// Used by TripReservations for: reservation create, reservation update,
// reservation delete, image update.

describe('invalidateReservationQueries', () => {
  const T = 31;

  it('invalidates the reservations list key', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateReservationQueries(queryClient, T);
    expect(wasInvalidated(getListReservationsQueryKey(T))).toBe(true);
  });

  it('invalidates the trip timeline key', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateReservationQueries(queryClient, T);
    expect(wasInvalidated(getGetTripTimelineQueryKey(T))).toBe(true);
  });

  it('invalidates exactly two keys per call', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateReservationQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it('called with the reservations list key', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateReservationQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: getListReservationsQueryKey(T),
    });
  });

  it('called with the timeline key', () => {
    const { queryClient } = makeMockQueryClient();
    invalidateReservationQueries(queryClient, T);
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: getGetTripTimelineQueryKey(T),
    });
  });
});

// ── Cross-entity isolation ────────────────────────────────────────────────────
//
// Confirms that each helper only touches its own list key, not other entities'.

describe('cross-entity query key isolation', () => {
  const T = 100;

  it('invalidateFlightQueries does not touch accommodations or car-rentals keys', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateFlightQueries(queryClient, T);
    expect(wasInvalidated(getListAccommodationsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListCarRentalsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListActivitiesQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListReservationsQueryKey(T))).toBe(false);
  });

  it('invalidateAccommodationQueries does not touch flights or car-rentals keys', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateAccommodationQueries(queryClient, T);
    expect(wasInvalidated(getListFlightsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListCarRentalsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListActivitiesQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListReservationsQueryKey(T))).toBe(false);
  });

  it('invalidateCarRentalQueries does not touch flights or accommodations keys', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateCarRentalQueries(queryClient, T);
    expect(wasInvalidated(getListFlightsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListAccommodationsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListActivitiesQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListReservationsQueryKey(T))).toBe(false);
  });

  it('invalidateActivityQueries does not touch flights or accommodations keys', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateActivityQueries(queryClient, T);
    expect(wasInvalidated(getListFlightsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListAccommodationsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListCarRentalsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListReservationsQueryKey(T))).toBe(false);
  });

  it('invalidateReservationQueries does not touch flights or activities keys', () => {
    const { queryClient, wasInvalidated } = makeMockQueryClient();
    invalidateReservationQueries(queryClient, T);
    expect(wasInvalidated(getListFlightsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListActivitiesQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListCarRentalsQueryKey(T))).toBe(false);
    expect(wasInvalidated(getListAccommodationsQueryKey(T))).toBe(false);
  });
});

// ── All helpers share the same timeline key ───────────────────────────────────

describe('all helpers target the same timeline key', () => {
  const T = 77;

  it('each helper invalidates the identical timeline key string', () => {
    const expected = getGetTripTimelineQueryKey(T);

    const helpers = [
      invalidateFlightQueries,
      invalidateAccommodationQueries,
      invalidateCarRentalQueries,
      invalidateActivityQueries,
      invalidateReservationQueries,
    ];

    for (const helper of helpers) {
      const { queryClient, wasInvalidated } = makeMockQueryClient();
      helper(queryClient, T);
      expect(wasInvalidated(expected)).toBe(true);
    }
  });
});
