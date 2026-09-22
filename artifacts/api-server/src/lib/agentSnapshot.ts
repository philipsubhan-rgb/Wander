/**
 * Marco agent — server-side trip snapshot.
 *
 * Loads the trip's core tables in one parallel batch (modeled on
 * buildTimelineEvents in src/lib/timeline.ts) and serializes a LEAN context
 * block: trip basics + per-table counts + the next few upcoming timeline
 * items. Full detail comes via the agent tools; the snapshot just orients
 * the model. Capped at ~4000 chars.
 */

import { eq } from "drizzle-orm";
import {
  db,
  tripsTable,
  itineraryDaysTable,
  reservationsTable,
  flightsTable,
  accommodationsTable,
  activitiesTable,
  carRentalsTable,
} from "@workspace/db";
import { buildTimelineEvents } from "./timeline";

const SNAPSHOT_MAX_CHARS = 4000;

export interface TripSnapshot {
  tripId: number;
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
  status: string;
  counts: {
    itineraryDays: number;
    reservations: number;
    flights: number;
    accommodations: number;
    activities: number;
    carRentals: number;
  };
  /** Next few upcoming timeline items, one line each. */
  upcoming: string[];
}

export async function loadTripSnapshot(tripId: number): Promise<TripSnapshot> {
  const [
    tripRows,
    itineraryDays,
    reservations,
    flights,
    accommodations,
    activities,
    carRentals,
  ] = await Promise.all([
    db.select().from(tripsTable).where(eq(tripsTable.id, tripId)),
    db.select().from(itineraryDaysTable).where(eq(itineraryDaysTable.tripId, tripId)),
    db.select().from(reservationsTable).where(eq(reservationsTable.tripId, tripId)),
    db.select().from(flightsTable).where(eq(flightsTable.tripId, tripId)),
    db.select().from(accommodationsTable).where(eq(accommodationsTable.tripId, tripId)),
    db.select().from(activitiesTable).where(eq(activitiesTable.tripId, tripId)),
    db.select().from(carRentalsTable).where(eq(carRentalsTable.tripId, tripId)),
  ]);

  const trip = tripRows[0];
  if (!trip) {
    throw new Error(`Trip ${tripId} not found`);
  }

  // buildTimelineEvents re-queries the same tables (not the rows above) — it
  // does its own batched Promise.all, and reuse keeps the merge/sort logic in
  // exactly one place. One extra round of cheap indexed selects is fine.
  const events = await buildTimelineEvents(tripId);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = events
    .filter((e) => e.date >= today)
    .slice(0, 6)
    .map(
      (e) =>
        `${e.date}${e.time ? " " + e.time : ""} [${e.type}] ${e.title}` +
        (e.location ? ` @ ${e.location}` : ""),
    );

  return {
    tripId: trip.id,
    title: trip.title,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    status: trip.status,
    counts: {
      itineraryDays: itineraryDays.length,
      reservations: reservations.length,
      flights: flights.length,
      accommodations: accommodations.length,
      activities: activities.length,
      carRentals: carRentals.length,
    },
    upcoming,
  };
}

/** Render the snapshot as a system ChatMessage for the model API. */

/** "2026-09-26" -> "Sat" / "Saturday". Noon UTC avoids any TZ day-shift. */
function weekday(isoDate: string, style: "short" | "long"): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: style,
    timeZone: "UTC",
  });
}

export function buildSnapshotSystemMessage(snapshot: TripSnapshot): { role: "system"; content: string } {
  const c = snapshot.counts;
  const todayIso = new Date().toISOString().slice(0, 10);
  const body = [
    `Today is ${weekday(todayIso, "long")} (${todayIso}).`,
    `Trip: ${snapshot.title} (ID ${snapshot.tripId} — pass this as tripId in every tool call)`,
    `Destination: ${snapshot.destination}`,
    `Dates: ${weekday(snapshot.startDate, "short")} ${snapshot.startDate} – ` +
      `${weekday(snapshot.endDate, "short")} ${snapshot.endDate} (status: ${snapshot.status})`,
    `On file: ${c.itineraryDays} itinerary day(s), ${c.reservations} reservation(s), ` +
      `${c.flights} flight(s), ${c.accommodations} stay(s), ${c.activities} activit${c.activities === 1 ? "y" : "ies"}, ` +
      `${c.carRentals} car rental(s).`,
    snapshot.upcoming.length > 0
      ? `Next upcoming items:\n${snapshot.upcoming.map((u) => `  ${u}`).join("\n")}`
      : "No upcoming timeline items.",
    "Full detail is available via your tools — query them for times, confirmation codes, and the full itinerary.",
  ].join("\n");

  const content = (
    "Current trip context (server-loaded; do not invent anything beyond it).\n" +
    body
  ).slice(0, SNAPSHOT_MAX_CHARS);

  return { role: "system", content };
}
