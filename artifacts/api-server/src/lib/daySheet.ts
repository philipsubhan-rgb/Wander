/**
 * Day-sheet data builder.
 *
 * Assembles one printable travel-day sheet for a trip: the trip's metadata,
 * the timeline items for that date, the overnight stay, day notes (from the
 * itinerary-day row), and a weather snapshot. The scheduler fills in
 * `weather` later — this module never calls weather APIs itself.
 */

import { eq } from "drizzle-orm";
import { db, tripsTable, accommodationsTable, tripBriefingsTable } from "@workspace/db";
import { buildTimelineEvents, type TimelineEvent } from "./timeline";
import type { WeatherSnapshot } from "./weather";

export interface DaySheetItem {
  time: string | null;
  title: string;
  location: string | null;
  confirmationCode: string | null;
  type: string;
}

export interface DaySheet {
  tripTitle: string;
  destination: string;
  dateISO: string;
  dateLabel: string;
  dayNumber: number;
  dayCount: number;
  items: DaySheetItem[];
  stayTonight: { name: string; address: string | null } | null;
  dayNotes: string | null;
  weather: WeatherSnapshot | null;
}

// ── Pure helpers (unit-tested in daySheet.test.ts) ────────────────────────────

/**
 * "Thursday, September 24" — format a YYYY-MM-DD date in the given IANA
 * timezone. Parsed at noon UTC so the date never shifts across midnight when
 * rendered in a different zone.
 */
export function formatDayLabel(dateISO: string, timeZone: string): string {
  const date = new Date(`${dateISO}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone,
  }).format(date);
}

/**
 * 1-based index of dateISO within startISO..endISO (inclusive), clamped to a
 * minimum of 1.
 */
export function dayNumberFor(dateISO: string, startISO: string): number {
  const start = new Date(`${startISO}T12:00:00Z`);
  const date = new Date(`${dateISO}T12:00:00Z`);
  const diffDays = Math.round((date.getTime() - start.getTime()) / (1000 * 60 * 60 * 24));
  return Math.max(1, diffDays + 1);
}

/** Inclusive day count between startISO and endISO (e.g. Sep 24–Sep 27 = 4). */
export function dayCountFor(startISO: string, endISO: string): number {
  const start = new Date(`${startISO}T12:00:00Z`);
  const end = new Date(`${endISO}T12:00:00Z`);
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1);
}

/** Sort day items by time; items with no time sort last. */
export function sortDayItems(items: DaySheetItem[]): DaySheetItem[] {
  return [...items].sort((a, b) => {
    if (a.time === null && b.time === null) return 0;
    if (a.time === null) return 1;
    if (b.time === null) return -1;
    return a.time.localeCompare(b.time);
  });
}

export interface StayRow {
  name: string;
  address: string | null;
  checkIn: string;
  checkOut: string;
}

/**
 * Pick tonight's stay: the accommodation whose [checkIn, checkOut) range
 * contains dateISO. First match wins.
 */
export function pickStayTonight(
  stays: StayRow[],
  dateISO: string,
): { name: string; address: string | null } | null {
  for (const stay of stays) {
    const inISO = stay.checkIn.substring(0, 10);
    const outISO = stay.checkOut.substring(0, 10);
    if (inISO <= dateISO && dateISO < outISO) {
      return { name: stay.name, address: stay.address };
    }
  }
  return null;
}

/** Map a timeline event to a day-sheet item row. */
export function timelineEventToItem(event: TimelineEvent): DaySheetItem {
  return {
    time: event.time,
    title: event.title,
    location: event.location,
    confirmationCode: event.confirmationCode,
    type: event.type,
  };
}

// ── Main builder ─────────────────────────────────────────────────────────────

export async function buildDaySheet(tripId: number, dateISO: string): Promise<DaySheet> {
  const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, tripId));
  if (!trip) {
    throw new Error(`Trip ${tripId} not found`);
  }

  const startISO = trip.startDate.substring(0, 10);
  const endISO = trip.endDate.substring(0, 10);

  // Briefing timezone if the trip has a briefing row, else Eastern.
  const [briefing] = await db
    .select({ timezone: tripBriefingsTable.timezone })
    .from(tripBriefingsTable)
    .where(eq(tripBriefingsTable.tripId, tripId));
  const timeZone = briefing?.timezone ?? "America/New_York";

  const events = await buildTimelineEvents(tripId);
  const dayEvents = events.filter(e => e.date === dateISO);

  const itineraryForDay = dayEvents.find(e => e.type === "itinerary");
  const items = sortDayItems(
    dayEvents.filter(e => e.type !== "itinerary").map(timelineEventToItem),
  );

  const stays = await db
    .select()
    .from(accommodationsTable)
    .where(eq(accommodationsTable.tripId, tripId));
  const stayTonight = pickStayTonight(stays, dateISO);

  return {
    tripTitle: trip.title,
    destination: trip.destination,
    dateISO,
    dateLabel: formatDayLabel(dateISO, timeZone),
    dayNumber: dayNumberFor(dateISO, startISO),
    dayCount: dayCountFor(startISO, endISO),
    items,
    stayTonight,
    dayNotes: itineraryForDay?.description ?? null,
    // The scheduler fills this in later — never fetched here.
    weather: null,
  };
}
