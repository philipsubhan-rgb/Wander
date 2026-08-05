/**
 * Centralised query-invalidation helpers for trip mutations.
 *
 * Every mutation that changes trip content must invalidate BOTH the specific
 * item-list query (so the list tab refreshes) AND the trip timeline query (so
 * the Overview and Itinerary tabs refresh without a full page reload).
 *
 * These helpers are the single source of truth for that pattern — all five
 * mutation components (TripFlights, TripAccommodations, TripCarRentals,
 * TripActivities, TripReservations) import and call them.  Tests import them
 * too, so breaking the helper causes test failures rather than silent regressions.
 */

import {
  getGetTripTimelineQueryKey,
  getListFlightsQueryKey,
  getListAccommodationsQueryKey,
  getListCarRentalsQueryKey,
  getListActivitiesQueryKey,
  getListReservationsQueryKey,
} from '@workspace/api-client-react';

/** Minimal interface from QueryClient that we actually call. */
export interface InvalidationClient {
  invalidateQueries(opts: { queryKey: readonly unknown[] }): void;
}

export function invalidateFlightQueries(
  queryClient: InvalidationClient,
  tripId: number,
): void {
  queryClient.invalidateQueries({ queryKey: getListFlightsQueryKey(tripId) });
  queryClient.invalidateQueries({
    queryKey: getGetTripTimelineQueryKey(tripId),
  });
}

export function invalidateAccommodationQueries(
  queryClient: InvalidationClient,
  tripId: number,
): void {
  queryClient.invalidateQueries({
    queryKey: getListAccommodationsQueryKey(tripId),
  });
  queryClient.invalidateQueries({
    queryKey: getGetTripTimelineQueryKey(tripId),
  });
}

export function invalidateCarRentalQueries(
  queryClient: InvalidationClient,
  tripId: number,
): void {
  queryClient.invalidateQueries({
    queryKey: getListCarRentalsQueryKey(tripId),
  });
  queryClient.invalidateQueries({
    queryKey: getGetTripTimelineQueryKey(tripId),
  });
}

export function invalidateActivityQueries(
  queryClient: InvalidationClient,
  tripId: number,
): void {
  queryClient.invalidateQueries({
    queryKey: getListActivitiesQueryKey(tripId),
  });
  queryClient.invalidateQueries({
    queryKey: getGetTripTimelineQueryKey(tripId),
  });
}

export function invalidateReservationQueries(
  queryClient: InvalidationClient,
  tripId: number,
): void {
  queryClient.invalidateQueries({
    queryKey: getListReservationsQueryKey(tripId),
  });
  queryClient.invalidateQueries({
    queryKey: getGetTripTimelineQueryKey(tripId),
  });
}
