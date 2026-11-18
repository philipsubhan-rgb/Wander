/**
 * Pure mapping from a Wander reservation to a Google Calendar event payload,
 * plus the idempotency planning for write-back sync.
 *
 * Kept free of DB/Google imports so it is unit-testable in isolation:
 *   - time parsing accepts both shapes Wander stores: 24h "19:30" (UI) and
 *     12h "7:30 PM" (Gmail parser).
 *   - timed events are floating local wall-clock times with an explicit
 *     timeZone (the Wander calendar's own zone) — Wander stores reservation
 *     times as local-to-the-trip wall clock with no zone, exactly like the
 *     ICS export does.
 *   - untimed reservations become all-day events.
 *   - planEventSync decides create / update / skip from the stored link's
 *     payload hash, so re-syncing an unchanged booking is a no-op and a
 *     changed booking updates its existing event instead of duplicating.
 */

import { createHash } from "node:crypto";

export interface MappableReservation {
  id: number;
  type: string;
  title: string;
  venue?: string | null;
  address?: string | null;
  date: string; // YYYY-MM-DD
  time?: string | null;
  endTime?: string | null;
  confirmationCode?: string | null;
  numberOfPeople?: number | null;
  notes?: string | null;
  url?: string | null;
}

export interface GoogleEventDateTime {
  dateTime: string; // floating local "YYYY-MM-DDTHH:MM:SS"
  timeZone?: string;
}

export interface GoogleEventDate {
  date: string; // YYYY-MM-DD
}

export interface GoogleCalendarEventPayload {
  summary: string;
  location?: string;
  description?: string;
  start: GoogleEventDateTime | GoogleEventDate;
  end: GoogleEventDateTime | GoogleEventDate;
}

/** Default event length when a reservation has no end time (matches ICS). */
export const DEFAULT_EVENT_MINUTES = 120;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_24H_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
const TIME_12H_RE = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i;

/**
 * Parse a stored reservation time into minutes since midnight.
 * Accepts "19:30", "7:30 PM", "7:30PM", "12:00 AM". Returns null for
 * anything unparseable (caller falls back to an all-day event).
 */
export function parseTimeToMinutes(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const s = raw.trim();
  const m12 = TIME_12H_RE.exec(s);
  if (m12) {
    let h = parseInt(m12[1], 10);
    const min = parseInt(m12[2], 10);
    if (h < 1 || h > 12 || min > 59) return null;
    const pm = m12[3].toUpperCase() === "PM";
    if (pm && h !== 12) h += 12;
    if (!pm && h === 12) h = 0;
    return h * 60 + min;
  }
  const m24 = TIME_24H_RE.exec(s);
  if (m24) {
    const h = parseInt(m24[1], 10);
    const min = parseInt(m24[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }
  return null;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "2026-09-24" + 1170 → "2026-09-24T19:30:00" (may roll into the next day). */
export function floatingDateTime(dateISO: string, minutes: number): string {
  const dt = new Date(
    Date.UTC(+dateISO.slice(0, 4), +dateISO.slice(5, 7) - 1, +dateISO.slice(8, 10)),
  );
  dt.setUTCMinutes(dt.getUTCMinutes() + minutes);
  return (
    `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}` +
    `T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:00`
  );
}

/** "2026-09-24" + 1 → "2026-09-25" (Google all-day end dates are exclusive). */
export function addDays(dateISO: string, days: number): string {
  const dt = new Date(
    Date.UTC(+dateISO.slice(0, 4), +dateISO.slice(5, 7) - 1, +dateISO.slice(8, 10)),
  );
  dt.setUTCDate(dt.getUTCDate() + days);
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/**
 * Map a reservation to a Google Calendar event payload.
 * Returns null when the reservation has no usable date (nothing to write).
 * `timeZone` is the Wander calendar's zone, attached to timed events.
 */
export function mapReservationToCalendarEvent(
  r: MappableReservation,
  opts: { timeZone?: string; tripTitle?: string } = {},
): GoogleCalendarEventPayload | null {
  if (!DATE_RE.test(r.date)) return null;

  const location = [r.venue, r.address].filter(Boolean).join(", ") || undefined;
  const descriptionLines = [
    r.confirmationCode ? `Confirmation: ${r.confirmationCode}` : null,
    r.numberOfPeople ? `Party of ${r.numberOfPeople}` : null,
    opts.tripTitle ? `Trip: ${opts.tripTitle}` : null,
    r.notes ?? null,
    r.url ?? null,
    "Booked via Wander",
  ].filter((p): p is string => Boolean(p));

  const payload: GoogleCalendarEventPayload = {
    summary: r.title || "Wander reservation",
    start: { date: r.date },
    end: { date: addDays(r.date, 1) },
  };
  if (location) payload.location = location;
  if (descriptionLines.length > 0) payload.description = descriptionLines.join("\n");

  const startMinutes = parseTimeToMinutes(r.time);
  if (startMinutes !== null) {
    let endMinutes = parseTimeToMinutes(r.endTime);
    // An end time at or before the start is bad data, not a zero-length
    // event — fall back to the default duration.
    if (endMinutes === null || endMinutes <= startMinutes) {
      endMinutes = startMinutes + DEFAULT_EVENT_MINUTES;
    }
    payload.start = { dateTime: floatingDateTime(r.date, startMinutes) };
    payload.end = { dateTime: floatingDateTime(r.date, endMinutes) };
    if (opts.timeZone) {
      (payload.start as GoogleEventDateTime).timeZone = opts.timeZone;
      (payload.end as GoogleEventDateTime).timeZone = opts.timeZone;
    }
  }
  return payload;
}

/** Stable content hash of a payload — what "changed?" is judged against. */
export function hashCalendarEventPayload(payload: GoogleCalendarEventPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export interface ExistingEventLink {
  googleEventId: string;
  lastSyncedHash: string;
}

export type EventSyncPlan =
  | { action: "create" }
  | { action: "update"; googleEventId: string }
  | { action: "skip"; googleEventId: string };

/**
 * Decide what a sync pass should do for one (account, reservation) pair:
 * no link → create; link with a different payload hash → update the stored
 * event; link with the same hash → skip (idempotent no-op).
 */
export function planEventSync(
  existing: ExistingEventLink | null,
  payload: GoogleCalendarEventPayload,
): EventSyncPlan {
  if (!existing) return { action: "create" };
  if (existing.lastSyncedHash !== hashCalendarEventPayload(payload)) {
    return { action: "update", googleEventId: existing.googleEventId };
  }
  return { action: "skip", googleEventId: existing.googleEventId };
}
