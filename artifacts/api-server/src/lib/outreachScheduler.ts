/**
 * Outreach chase scheduler (architecture-north-star §3.5, Story 4.2).
 *
 * Hourly tick on the briefingScheduler pattern (in-process node-cron, no
 * tick on boot). Each pass loads every roster entry in a chaseable
 * status and asks the pure `decideChaseAction` what to do:
 *
 *   - "remind"   → one reminder email (fresh setup link, general-terms
 *                  missing labels), chase state advanced a full interval
 *   - "escalate" → chasing stops for that entry; the organizer gets ONE
 *                  batched status alert per trip per tick
 *   - "none"     → not due, paused, complete, already escalated, …
 *
 * Cadence numbers live in OUTREACH_CONFIG (outreachLogic.ts) — the caps
 * are enforced by decideChaseAction + the state transitions, not here.
 */

import cron from "node-cron";
import { eq } from "drizzle-orm";
import { db, tripsTable, type Trip, type TripRosterEntry } from "@workspace/db";
import { logger } from "./logger.js";
import { decideChaseAction, parseChaseState } from "./outreachLogic.js";
import {
  applyChaseEscalation,
  applyChaseReminder,
  loadChaseCandidates,
  loadTripOrganizer,
  sendEscalationAlert,
  type OrganizerInfo,
} from "./outreach.js";

export interface OutreachTickSummary {
  candidates: number;
  reminded: number;
  escalated: number;
  skipped: number;
}

/**
 * One scheduler pass. Exported for tests; the cron job calls it.
 * Per-entry failures are logged and never sink the whole tick.
 */
export async function runOutreachChaseTick(
  now: Date = new Date(),
): Promise<OutreachTickSummary> {
  const summary: OutreachTickSummary = { candidates: 0, reminded: 0, escalated: 0, skipped: 0 };

  let candidates: TripRosterEntry[];
  try {
    candidates = await loadChaseCandidates();
  } catch (err) {
    logger.error({ err }, "Outreach chase tick failed to load candidates");
    return summary;
  }
  summary.candidates = candidates.length;

  // Escalations are collected per trip so the organizer gets one alert.
  const escalations = new Map<
    number,
    { trip: Trip; organizer: OrganizerInfo; reason: "reminders_exhausted" | "deadline_approaching"; entries: TripRosterEntry[] }
  >();
  const tripCache = new Map<number, Trip | null>();
  const organizerCache = new Map<number, OrganizerInfo | null>();

  const loadTripCached = async (tripId: number): Promise<Trip | null> => {
    if (!tripCache.has(tripId)) {
      const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, tripId));
      tripCache.set(tripId, trip ?? null);
    }
    return tripCache.get(tripId) ?? null;
  };
  const loadOrganizerCached = async (tripId: number): Promise<OrganizerInfo | null> => {
    if (!organizerCache.has(tripId)) {
      organizerCache.set(tripId, await loadTripOrganizer(tripId));
    }
    return organizerCache.get(tripId) ?? null;
  };

  for (const entry of candidates) {
    try {
      const trip = await loadTripCached(entry.tripId);
      if (!trip) {
        summary.skipped++;
        continue;
      }
      const decision = decideChaseAction({
        status: entry.status,
        missingFields: entry.missingFields,
        chaseState: parseChaseState(entry.chaseState),
        tripStartDate: trip.startDate,
        now,
      });

      if (decision.action === "none") {
        summary.skipped++;
        continue;
      }

      const organizer = await loadOrganizerCached(entry.tripId);
      if (!organizer) {
        summary.skipped++;
        continue;
      }

      if (decision.action === "remind") {
        const outcome = await applyChaseReminder(entry, trip, organizer, now);
        if (outcome === "sent") summary.reminded++;
        else summary.skipped++;
        continue;
      }

      // escalate: record state now, alert once per trip after the loop.
      await applyChaseEscalation(entry, now);
      summary.escalated++;
      const bucket = escalations.get(entry.tripId) ?? {
        trip,
        organizer,
        reason: decision.reason,
        entries: [],
      };
      bucket.entries.push(entry);
      escalations.set(entry.tripId, bucket);
    } catch (err) {
      logger.error({ err, entryId: entry.id }, "Outreach chase tick failed for entry");
      summary.skipped++;
    }
  }

  for (const { trip, organizer, reason, entries } of escalations.values()) {
    try {
      await sendEscalationAlert(trip, organizer, reason, entries);
    } catch (err) {
      logger.error({ err, tripId: trip.id }, "Outreach escalation alert failed");
    }
  }

  if (summary.reminded > 0 || summary.escalated > 0) {
    logger.info(summary, "[Outreach] chase tick complete");
  }
  return summary;
}

/**
 * Start the hourly chase schedule. No tick runs on boot — the first
 * chase action can only happen on a scheduled tick, avoiding surprise
 * sends right after a deploy/restart.
 */
export function startOutreachScheduler(): void {
  cron.schedule("0 * * * *", () => {
    runOutreachChaseTick().catch((err) => {
      logger.error({ err }, "Outreach chase tick failed");
    });
  });
  logger.info("Outreach chase scheduler started (hourly)");
}
