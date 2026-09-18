/**
 * Daily briefing scheduler.
 *
 * Every 15 minutes a tick loads all enabled trip-briefing configs and sends
 * the one-page PDF briefing email when ALL of the following hold for a row:
 *
 *   - the trip status is "confirmed" or "active"
 *   - today (in the briefing's timezone) falls within the trip's start/end dates
 *   - nothing has been sent for today yet (lastSentForDate)
 *   - the current local time is at/after the configured sendTimeLocal
 *
 * NOTE: this module imports the day-sheet builder, weather lookup and PDF
 * renderer. Those live in sibling lib files that are created by parallel
 * work (daySheet.ts, weather.ts, daySheetPdf.ts); until they land, this
 * module (and its tests) can only be type-checked / run with them mocked.
 */

import cron from "node-cron";
import { eq } from "drizzle-orm";
import {
  db,
  tripBriefingsTable,
  tripsTable,
  tripParticipantsTable,
  usersTable,
  type TripBriefing,
  type Trip,
} from "@workspace/db";
import { logger } from "./logger.js";
import { buildDaySheet, tripDates, type DaySheet } from "./daySheet.js";
import { geocodeDestination, fetchWeatherForDate } from "./weather.js";
import { renderDaySheetPdf, renderDaySheetsPdf } from "./daySheetPdf.js";
import { sendDailyBriefingEmail } from "./email.js";
import { buildTripIcs } from "./tripIcs.js";

// ---------------------------------------------------------------------------
// Timezone helpers (pure, unit-testable)
// ---------------------------------------------------------------------------

/** True when `tz` is a valid IANA timezone identifier. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** YYYY-MM-DD for `now` in `timeZone`. Falls back to UTC on invalid timezone. */
export function todayInZone(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  }
}

/** "HH:MM" (24h) for `now` in `timeZone`. Falls back to UTC on invalid timezone. */
export function nowHMInZone(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
  }
}

// ---------------------------------------------------------------------------
// Due logic (pure, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Whether a briefing is due right now. All inputs are pre-computed for the
 * briefing's timezone so this stays side-effect free and easy to test.
 */
export function isBriefingDue(
  briefing: Pick<TripBriefing, "sendTimeLocal" | "lastSentForDate">,
  trip: Pick<Trip, "status" | "startDate" | "endDate">,
  today: string,
  nowHM: string
): boolean {
  if (trip.status !== "confirmed" && trip.status !== "active") return false;

  const start = trip.startDate.substring(0, 10);
  const end = trip.endDate.substring(0, 10);
  if (today < start || today > end) return false;

  if (briefing.lastSentForDate === today) return false;

  // Lexicographic comparison is safe for zero-padded "HH:MM".
  if (nowHM < briefing.sendTimeLocal) return false;

  return true;
}

// ---------------------------------------------------------------------------
// Weather attachment (shared by the scheduler tick, send-now and preview)
// ---------------------------------------------------------------------------

/**
 * Resolve lat/lon (cached, else freshly geocoded and cached) and attach the
 * weather snapshot for `dateISO` onto the sheet. Weather lookup failure is
 * non-fatal: the sheet keeps `weather: null`.
 */
export async function attachWeather(
  sheet: DaySheet,
  briefing: TripBriefing,
  trip: Trip,
  dateISO: string
): Promise<void> {
  let lat = briefing.cachedLat;
  let lon = briefing.cachedLon;

  if (lat == null || lon == null) {
    const fresh = await geocodeDestination(trip.destination);
    if (fresh) {
      lat = fresh.lat;
      lon = fresh.lon;
      // Cache the fresh coordinates even if the weather fetch below fails.
      if (briefing.id != null) {
        await db
          .update(tripBriefingsTable)
          .set({ cachedLat: lat, cachedLon: lon, updatedAt: new Date() })
          .where(eq(tripBriefingsTable.id, briefing.id));
      }
      briefing.cachedLat = lat;
      briefing.cachedLon = lon;
    }
  }

  sheet.weather = lat != null && lon != null
    ? await fetchWeatherForDate(lat, lon, dateISO, briefing.timezone)
    : null;
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/**
 * Participant emails for the trip plus the briefing's extraEmails,
 * deduplicated, lowercased, non-empty.
 */
export async function loadBriefingRecipients(
  briefing: Pick<TripBriefing, "extraEmails">,
  tripId: number
): Promise<string[]> {
  const rows = await db
    .select({ email: usersTable.email })
    .from(tripParticipantsTable)
    .innerJoin(usersTable, eq(usersTable.id, tripParticipantsTable.userId))
    .where(eq(tripParticipantsTable.tripId, tripId));

  const emails = [
    ...rows.map((r) => r.email),
    ...(briefing.extraEmails ?? []),
  ]
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  return [...new Set(emails)];
}

// ---------------------------------------------------------------------------
// Send one briefing
// ---------------------------------------------------------------------------

export interface SendTripBriefingResult {
  sent: boolean;
  recipientCount: number;
}

/**
 * Build and send the briefing for `dateISO`. Shared by the scheduler tick and
 * the admin "send now" route.
 *
 * `briefing.id` may be unset when the caller is working from transient
 * defaults (send-now with no persisted row); in that case persistence steps
 * are skipped but the email is still sent.
 *
 * Pass `attachIcs: true` to also attach the whole-trip itinerary as a
 * calendar (.ics) file. The scheduled daily tick keeps its PDF-only format;
 * only manual sends attach the ICS.
 */
export async function sendTripBriefing(
  briefing: TripBriefing,
  trip: Trip,
  dateISO: string,
  opts?: { attachIcs?: boolean }
): Promise<SendTripBriefingResult> {
  try {
    const sheet = await buildDaySheet(trip.id, dateISO);
    await attachWeather(sheet, briefing, trip, dateISO);

    const pdf = await renderDaySheetPdf(sheet);

    const recipients = await loadBriefingRecipients(briefing, trip.id);
    if (recipients.length === 0) {
      logger.info({ tripId: trip.id }, "Briefing not sent — no recipients");
      return { sent: false, recipientCount: 0 };
    }

    let ics: { filename: string; content: string } | undefined;
    if (opts?.attachIcs) {
      try {
        const built = await buildTripIcs(trip.id);
        ics = { filename: built.filename, content: built.ics };
      } catch (err) {
        // ICS is a bonus attachment — never let it sink the email.
        logger.warn({ err, tripId: trip.id }, "ICS itinerary build failed — sending PDF only");
      }
    }

    const result = await sendDailyBriefingEmail({
      to: recipients,
      tripTitle: trip.title,
      dateLabel: sheet.dateLabel,
      pdfBuffer: pdf,
      filename: `wander-one-pager-${trip.id}-${dateISO}.pdf`,
      ...(ics ? { ics } : {}),
    });

    if (result.sent && briefing.id != null) {
      await db
        .update(tripBriefingsTable)
        .set({ lastSentForDate: dateISO, updatedAt: new Date() })
        .where(eq(tripBriefingsTable.id, briefing.id));
    }

    return { sent: result.sent, recipientCount: recipients.length };
  } catch (err) {
    // Never mark sent on exception — the next tick retries.
    logger.error({ err, tripId: trip.id }, "Failed to send trip briefing");
    return { sent: false, recipientCount: 0 };
  }
}

export interface SendAllBriefingsResult {
  sent: boolean;
  recipientCount: number;
  dayCount: number;
}

/**
 * Build and send a combined briefing — one PDF page per trip day — for the
 * whole trip. Used by the admin "send all days" action. Unlike the daily
 * tick, this does not touch lastSentForDate: it is an explicit one-off, not
 * part of the scheduled per-day cadence.
 */
export async function sendAllBriefings(
  briefing: TripBriefing,
  trip: Trip
): Promise<SendAllBriefingsResult> {
  try {
    const start = trip.startDate.substring(0, 10);
    const end = trip.endDate.substring(0, 10);
    const dates = tripDates(start, end);

    const sheets: DaySheet[] = [];
    for (const dateISO of dates) {
      const sheet = await buildDaySheet(trip.id, dateISO);
      await attachWeather(sheet, briefing, trip, dateISO);
      sheets.push(sheet);
    }

    const pdf = await renderDaySheetsPdf(sheets);

    const recipients = await loadBriefingRecipients(briefing, trip.id);
    if (recipients.length === 0) {
      logger.info({ tripId: trip.id }, "All-days briefing not sent — no recipients");
      return { sent: false, recipientCount: 0, dayCount: dates.length };
    }

    const dateLabel = `${dates[0]} – ${dates[dates.length - 1]} (${dates.length} day${
      dates.length === 1 ? "" : "s"
    })`;

    let ics: { filename: string; content: string } | undefined;
    try {
      const built = await buildTripIcs(trip.id);
      ics = { filename: built.filename, content: built.ics };
    } catch (err) {
      logger.warn({ err, tripId: trip.id }, "ICS itinerary build failed — sending PDF only");
    }

    const result = await sendDailyBriefingEmail({
      to: recipients,
      tripTitle: trip.title,
      dateLabel,
      pdfBuffer: pdf,
      filename: `wander-all-days-${trip.id}-${dates[0]}-to-${dates[dates.length - 1]}.pdf`,
      ...(ics ? { ics } : {}),
    });

    return { sent: result.sent, recipientCount: recipients.length, dayCount: dates.length };
  } catch (err) {
    logger.error({ err, tripId: trip.id }, "Failed to send all-days trip briefing");
    return { sent: false, recipientCount: 0, dayCount: 0 };
  }
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

interface BriefingRow {
  briefing: TripBriefing;
  trip: Trip;
}

/**
 * One scheduler pass: load enabled briefings joined to their trips and send
 * every briefing that is due. Exported for tests; the cron job calls it.
 */
export async function runBriefingTick(now: Date = new Date()): Promise<void> {
  let rows: BriefingRow[];
  try {
    rows = await db
      .select({ briefing: tripBriefingsTable, trip: tripsTable })
      .from(tripBriefingsTable)
      .innerJoin(tripsTable, eq(tripsTable.id, tripBriefingsTable.tripId))
      .where(eq(tripBriefingsTable.enabled, true));
  } catch (err) {
    logger.error({ err }, "Briefing scheduler tick failed to load enabled briefings");
    return;
  }

  for (const { briefing, trip } of rows) {
    // Skip rows with an invalid timezone rather than crashing the whole tick.
    if (!isValidTimeZone(briefing.timezone)) {
      logger.warn({ tripId: trip.id }, "Skipping briefing with invalid timezone");
      continue;
    }

    const today = todayInZone(briefing.timezone, now);
    const nowHM = nowHMInZone(briefing.timezone, now);

    if (!isBriefingDue(briefing, trip, today, nowHM)) continue;

    await sendTripBriefing(briefing, trip, today);
  }
}

/**
 * Start the 15-minute briefing schedule. No tick runs on boot — the first
 * send can only happen on a scheduled tick, avoiding surprise sends right
 * after a deploy/restart.
 */
export function startBriefingScheduler(): void {
  cron.schedule("*/15 * * * *", () => {
    runBriefingTick().catch((err) => {
      logger.error({ err }, "Briefing scheduler tick failed");
    });
  });
  logger.info("Briefing scheduler started (every 15 min)");
}
