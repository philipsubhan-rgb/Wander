/**
 * Watching scheduler (architecture-north-star §6/§8). One daily tick —
 * the ONLY scheduled watching work in the system — running three
 * bounded passes:
 *
 *   1. Registration: flights on open trips without a watch get one
 *      (a flight is registered exactly once, ever).
 *   2. T-24h catch-all: one FlightAware lookup per leg departing
 *      within 24h that hasn't had it (§8.3.1) — a batch, never a sweep
 *      or a polling loop.
 *   3. Completion: watches on finished trips are deregistered and
 *      closed, so alert spend stops when the trip ends (§8.3.5).
 *
 * Real-time status arrives by push (alerts), not from this job. The
 * §8.4 invariant holds by construction: paid-data spend scales with
 * booked legs, never with elapsed time × stored users.
 */

import cron from "node-cron";
import { logger } from "./logger.js";
import {
  completeWatchesForFinishedTrips,
  runPredepartureCheck,
  syncWatchRegistrations,
  type WatchingDeps,
} from "./watching.js";

export interface WatchingTickSummary {
  registered: number;
  registrationSkipped: number;
  predepartureChecked: number;
  watchesCompleted: number;
}

/** One daily pass. Exported for tests; the cron job calls it. */
export async function runWatchingDailyTick(
  deps: WatchingDeps = {},
): Promise<WatchingTickSummary> {
  const summary: WatchingTickSummary = {
    registered: 0,
    registrationSkipped: 0,
    predepartureChecked: 0,
    watchesCompleted: 0,
  };
  try {
    const reg = await syncWatchRegistrations(deps);
    summary.registered = reg.registered;
    summary.registrationSkipped = reg.skipped;
  } catch (err) {
    logger.error({ err }, "[Watching] registration sweep failed");
  }
  try {
    const pre = await runPredepartureCheck(deps);
    summary.predepartureChecked = pre.checked;
  } catch (err) {
    logger.error({ err }, "[Watching] T-24h check failed");
  }
  try {
    const done = await completeWatchesForFinishedTrips(deps);
    summary.watchesCompleted = done.completed;
  } catch (err) {
    logger.error({ err }, "[Watching] completion sweep failed");
  }
  if (summary.registered > 0 || summary.predepartureChecked > 0 || summary.watchesCompleted > 0) {
    logger.info(summary, "[Watching] daily tick complete");
  }
  return summary;
}

/** Start the daily watching schedule. No tick on boot. */
export function startWatchingScheduler(): void {
  cron.schedule("15 6 * * *", () => {
    runWatchingDailyTick().catch((err) => {
      logger.error({ err }, "[Watching] daily tick failed");
    });
  });
  logger.info("Watching scheduler started (daily)");
}
