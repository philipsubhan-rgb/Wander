/**
 * Shared timeline event builder.
 *
 * Extracted from the GET /trips/:tripId/timeline route handler so the same
 * event-building, cross-type sorting, and helper-key stripping logic can be
 * reused elsewhere (e.g. day sheets). The returned array is exactly what the
 * route used to send: sorted, with internal helpers stripped.
 */

import { eq } from "drizzle-orm";
import { flightEventDate, flightEventTime, airportTimeZone } from "@workspace/flight-time";
import {
  db,
  flightsTable,
  accommodationsTable,
  activitiesTable,
  itineraryDaysTable,
  carRentalsTable,
  reservationsTable,
} from "@workspace/db";

export interface TimelineEvent {
  id: number | string;
  type: "flight" | "accommodation" | "activity" | "car_rental" | "itinerary" | "reservation";
  date: string;
  title: string;
  description: string | null;
  location: string | null;
  time: string | null;
  imageUrl: string | null;
  carrierCode: string | null;
  confirmationCode: string | null;
}

export async function buildTimelineEvents(tripId: number): Promise<TimelineEvent[]> {
  const [flights, accommodations, activities, itinerary, carRentals, reservations] = await Promise.all([
    db.select().from(flightsTable).where(eq(flightsTable.tripId, tripId)),
    db.select().from(accommodationsTable).where(eq(accommodationsTable.tripId, tripId)),
    db.select().from(activitiesTable).where(eq(activitiesTable.tripId, tripId)),
    db.select().from(itineraryDaysTable).where(eq(itineraryDaysTable.tripId, tripId)),
    db.select().from(carRentalsTable).where(eq(carRentalsTable.tripId, tripId)),
    db.select().from(reservationsTable).where(eq(reservationsTable.tripId, tripId)),
  ]);

  const events = [
    ...flights.map(f => {
      // Legacy rows predate stored timezones: resolve the airport's zone so the
      // timeline renders airport wall-clock time instead of the raw UTC instant
      // (the server formats in UTC, so without this every legacy flight shifts).
      const depTz = f.departureTimezone ?? airportTimeZone(f.departureAirport);
      return {
        id: f.id,
        type: "flight" as const,
        date: flightEventDate(f.departureDatetime, depTz),
        title: `${f.airline} ${f.flightNumber}: ${f.departureAirport} → ${f.arrivalAirport}`,
        description: f.notes ?? null,
        location: f.departureAirport,
        time: flightEventTime(f.departureDatetime, depTz),
        imageUrl: null as string | null,
        carrierCode: f.flightNumber?.toUpperCase().match(/^([A-Z0-9]{2,3})\s*\d/)?.[1] ?? null,
        confirmationCode: f.confirmationCode ?? null,
      };
    }),
    ...accommodations.flatMap(a => ([
      {
        id: a.id,
        type: "accommodation" as const,
        date: a.checkIn.substring(0, 10),
        title: `Check-in: ${a.name}`,
        description: a.notes ?? null,
        location: a.address,
        time: null,
        imageUrl: a.imageUrl ?? null,
        carrierCode: null as string | null,
        confirmationCode: a.confirmationCode ?? null,
        // Sorting helpers — stripped before the response is sent (see below).
        _stayStart: a.checkIn.substring(0, 10),
        _stayEnd:   a.checkOut.substring(0, 10),
        _isCheckout: 0 as 0 | 1,
      },
      {
        id: `${a.id}-checkout`,
        type: "accommodation" as const,
        date: a.checkOut.substring(0, 10),
        title: `Check-out: ${a.name}`,
        description: null,
        location: a.address,
        time: null,
        imageUrl: a.imageUrl ?? null,
        carrierCode: null as string | null,
        confirmationCode: a.confirmationCode ?? null,
        // Sorting helpers — stripped before the response is sent (see below).
        _stayStart: a.checkIn.substring(0, 10),
        _stayEnd:   a.checkOut.substring(0, 10),
        _isCheckout: 1 as 0 | 1,
      },
    ])),
    ...activities.map(a => ({
      id: a.id,
      type: "activity" as const,
      date: a.date,
      title: a.title,
      description: a.description ?? null,
      location: a.location ?? null,
      time: a.time ?? null,
      imageUrl: a.imageUrl ?? null,
      carrierCode: null as string | null,
      confirmationCode: null as string | null,
      _sortOrder: a.sortOrder ?? null,
    })),
    ...carRentals.map(r => ({
      id: r.id,
      type: "car_rental" as const,
      date: r.pickupDatetime.substring(0, 10),
      title: `${r.company} pick-up`,
      description: r.notes ?? null,
      location: r.pickupLocation,
      time: r.pickupDatetime.length > 10 ? r.pickupDatetime.substring(11, 16) : null,
      imageUrl: null as string | null,
      carrierCode: null as string | null,
      confirmationCode: r.confirmationCode ?? null,
    })),
    ...itinerary.map(d => ({
      id: d.id,
      type: "itinerary" as const,
      date: d.date,
      title: d.title,
      description: d.description ?? null,
      location: null,
      time: null,
      imageUrl: null as string | null,
      carrierCode: null as string | null,
      confirmationCode: null as string | null,
    })),
    ...reservations.map(r => ({
      id: r.id,
      type: "reservation" as const,
      date: r.date,
      title: r.title,
      description: r.notes ?? null,
      location: r.address ?? r.venue ?? null,
      time: r.time ?? null,
      imageUrl: r.imageUrl ?? null,
      carrierCode: null as string | null,
      confirmationCode: r.confirmationCode ?? null,
      _sortOrder: r.sortOrder ?? null,
    })),
  ];

  // Assign a cross-type priority so same-date/time events appear in a
  // deterministic, logical order that mirrors the traveler's day:
  //   checkout → flight → car_rental → check-in → activity → reservation → itinerary
  //
  // Check-OUT gets priority -1 (before flights) because on a departure day the
  // traveler leaves the hotel before boarding.  Check-IN stays at 2 (after
  // flights/car-rentals) because on an arrival day you land/drive first, then
  // check in.  Accommodation events use a separate per-stay sort for same-type
  // ties (see below).
  const eventPriority = (e: { type: string }) => {
    if (e.type === "accommodation") {
      // _isCheckout is 1 for checkout rows, 0 for check-in rows (stripped later).
      return (e as any)._isCheckout === 1 ? -1 : 2;
    }
    switch (e.type) {
      case "flight":        return 0;
      case "car_rental":    return 1;
      case "activity":      return 3;
      case "reservation":   return 4;
      case "itinerary":     return 5;
      default:              return 6;
    }
  };

  // For two accommodation events sharing the same date and time, sort by
  // actual stay chronology so each stay's check-out is immediately followed
  // by the next stay's check-in.  Sort keys (embedded above as _stayStart,
  // _stayEnd, _isCheckout):
  //
  //   primary   → _stayStart (checkIn date of the stay)
  //   secondary → _stayEnd   (checkOut date of the stay)
  //   tertiary  → _isCheckout: 0 = check-in, 1 = check-out
  //
  // Example — three same-day stays A(Jul10→Jul15), B(Jul15↔Jul15), C(Jul15→Jul20):
  //   check-out A  →  (Jul10, Jul15, 1) — earliest stayStart
  //   check-in  B  →  (Jul15, Jul15, 0) — same stayStart, earlier stayEnd, is check-in
  //   check-out B  →  (Jul15, Jul15, 1) — same stayStart, earlier stayEnd, is check-out
  //   check-in  C  →  (Jul15, Jul20, 0) — same stayStart, later stayEnd
  //
  // This is ID-independent: inserting stays out of DB-creation order or with
  // non-chronological IDs produces the same result.
  type AccomEvent = (typeof events)[number] & {
    _stayStart:  string;
    _stayEnd:    string;
    _isCheckout: 0 | 1;
  };

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    // When exactly one event lacks a time, type priority decides the order
    // rather than treating null as "00:00".  This prevents a null-time
    // activity from accidentally appearing before a timed flight simply
    // because "00:00" < "14:30".  When both events share the same type
    // priority (e.g. two activities), the priority delta is zero and we
    // fall through to the normalised time comparison so "00:00" < "09:00"
    // still puts the null-time event first.
    if ((a.time === null) !== (b.time === null)) {
      const priorityDiff = eventPriority(a) - eventPriority(b);
      if (priorityDiff !== 0) return priorityDiff;
    }
    const at = a.time ?? "00:00";
    const bt = b.time ?? "00:00";
    if (at !== bt) return at.localeCompare(bt);
    // Within accommodations, use stay-date keys to preserve handoff order.
    if (a.type === "accommodation" && b.type === "accommodation") {
      const aa = a as AccomEvent;
      const bb = b as AccomEvent;
      if (aa._stayStart !== bb._stayStart) return aa._stayStart.localeCompare(bb._stayStart);
      if (aa._stayEnd   !== bb._stayEnd)   return aa._stayEnd.localeCompare(bb._stayEnd);
      return aa._isCheckout - bb._isCheckout;
    }
    const priorityDiff = eventPriority(a) - eventPriority(b);
    if (priorityDiff !== 0) return priorityDiff;
    // Final tiebreaker: explicit sort_order for activities and reservations
    // Null sort_order sorts after explicit values, then fall back to id.
    const aOrd: number | null = (a as any)._sortOrder ?? null;
    const bOrd: number | null = (b as any)._sortOrder ?? null;
    if (aOrd !== null && bOrd !== null && aOrd !== bOrd) return aOrd - bOrd;
    if (aOrd !== null && bOrd === null) return -1;
    if (aOrd === null && bOrd !== null) return 1;
    return String(a.id).localeCompare(String(b.id));
  });

  // Strip the internal sorting helpers before sending the response.
  return events.map(e => {
    const { _stayStart, _stayEnd, _isCheckout, _sortOrder, ...rest } = e as AccomEvent & { _sortOrder?: number | null };
    return rest;
  });
}
