/**
 * ICS (iCalendar) export for a trip's itinerary.
 *
 * Builds a standards-shaped .ics file (RFC 5545) from the trip's timeline
 * events so travelers can import the whole itinerary into Apple/Google/
 * Outlook calendars. Timed events become floating local-time VEVENTs (the
 * times Wander stores are already local to the trip); untimed events become
 * all-day events. UIDs are stable per trip/date/index, so re-importing the
 * file updates the events instead of duplicating them.
 */

import { eq } from "drizzle-orm";
import { db, tripsTable } from "@workspace/db";
import { buildTimelineEvents } from "./timeline.js";

/** Default duration in minutes per event type when no end time is known. */
const DEFAULT_DURATIONS: Record<string, number> = {
  flight: 180,
  reservation: 120,
  activity: 120,
  car_rental: 60,
  accommodation: 60,
};

/** Escape text per RFC 5545 §3.3.11. */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Fold a content line at 75 octets per RFC 5545 §3.1. */
export function foldIcsLine(line: string): string {
  if (Buffer.byteLength(line, "utf8") <= 75) return line;
  let out = "";
  let current = "";
  let currentBytes = 0;
  for (const ch of line) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (currentBytes + chBytes > 75) {
      out += current + "\r\n ";
      current = "";
      currentBytes = 0;
    }
    current += ch;
    currentBytes += chBytes;
  }
  return out + current;
}

/** "2026-09-24" + "17:15" → "20260924T171500" (floating local time). */
export function toFloatingLocal(dateISO: string, timeHM: string): string {
  const hm = timeHM.trim().slice(0, 5);
  return `${dateISO.replace(/-/g, "")}T${hm.replace(":", "")}00`;
}

/** Add minutes to a floating-local timestamp string. */
export function addMinutesToFloating(floating: string, minutes: number): string {
  const dt = new Date(
    Date.UTC(
      +floating.slice(0, 4),
      +floating.slice(4, 6) - 1,
      +floating.slice(6, 8),
      +floating.slice(9, 11),
      +floating.slice(11, 13)
    )
  );
  dt.setUTCMinutes(dt.getUTCMinutes() + minutes);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${dt.getUTCFullYear()}${p(dt.getUTCMonth() + 1)}${p(dt.getUTCDate())}` +
    `T${p(dt.getUTCHours())}${p(dt.getUTCMinutes())}00`
  );
}

export interface TripIcsResult {
  ics: string;
  filename: string;
  eventCount: number;
}

/**
 * Build the .ics content for a whole trip. Throws when the trip is missing;
 * never throws on odd event data (bad times fall back to all-day events).
 */
export async function buildTripIcs(tripId: number): Promise<TripIcsResult> {
  const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, tripId));
  if (!trip) {
    throw new Error(`Trip ${tripId} not found`);
  }

  const events = (await buildTimelineEvents(tripId)).filter(
    (e) => e.type !== "itinerary"
  );
  const stamp =
    new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";

  const rawLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Wander//Trip Itinerary//EN",
    "CALSCALE:GREGORIAN",
    `X-WR-CALNAME:${escapeIcsText(trip.title)}`,
  ];

  let count = 0;
  events.forEach((e, i) => {
    const date = e.date.substring(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;

    const description = [
      e.location ? `Where: ${e.location}` : null,
      e.confirmationCode ? `Confirmation: ${e.confirmationCode}` : null,
      e.description ? e.description : null,
    ]
      .filter((p): p is string => p !== null)
      .join("\n");

    rawLines.push("BEGIN:VEVENT");
    rawLines.push(`UID:wander-${tripId}-${date}-${i}@wander`);
    rawLines.push(`DTSTAMP:${stamp}`);
    rawLines.push(`SUMMARY:${escapeIcsText(e.title || "Trip event")}`);
    if (e.location) rawLines.push(`LOCATION:${escapeIcsText(e.location)}`);
    if (description) rawLines.push(`DESCRIPTION:${escapeIcsText(description)}`);

    const timeOk = e.time !== null && /^\d{2}:\d{2}/.test(e.time);
    if (timeOk) {
      const start = toFloatingLocal(date, e.time as string);
      const duration = DEFAULT_DURATIONS[e.type] ?? 60;
      rawLines.push(`DTSTART:${start}`);
      rawLines.push(`DTEND:${addMinutesToFloating(start, duration)}`);
    } else {
      rawLines.push(`DTSTART;VALUE=DATE:${date.replace(/-/g, "")}`);
    }
    rawLines.push("END:VEVENT");
    count += 1;
  });

  rawLines.push("END:VCALENDAR");
  const ics = rawLines.map(foldIcsLine).join("\r\n") + "\r\n";

  return {
    ics,
    filename: `wander-itinerary-${tripId}.ics`,
    eventCount: count,
  };
}
