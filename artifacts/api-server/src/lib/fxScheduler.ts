/**
 * FX scheduler — one daily tick that refreshes the ECB reference-rate
 * snapshots (lib/fxRates.ts), on the same pattern as the briefing and
 * watching schedulers. ECB rates publish once per business day
 * (~16:00 CET); the 05:30 UTC tick picks up the latest published set
 * well before the day's planning starts. No tick on boot.
 *
 * Failure posture: a failed refresh writes nothing and is logged —
 * yesterday's snapshots keep serving home equivalents, honestly
 * dated, rather than today's being guessed.
 */

import cron from "node-cron";
import { logger } from "./logger.js";
import { refreshFxSnapshots, type FxRefreshDeps } from "./fxRates.js";

export interface FxTickSummary {
  ok: boolean;
  snapshotsWritten: number;
  asOf: string | null;
}

/** One daily pass. Exported for tests; the cron job calls it. Never throws. */
export async function runFxDailyTick(deps: FxRefreshDeps = {}): Promise<FxTickSummary> {
  try {
    const result = await refreshFxSnapshots(deps);
    return { ok: true, snapshotsWritten: result.inserted, asOf: result.asOf };
  } catch (err) {
    logger.error(
      { err },
      "[FX] daily snapshot refresh failed — previous snapshots remain in place",
    );
    return { ok: false, snapshotsWritten: 0, asOf: null };
  }
}

/** Start the daily FX schedule. No tick on boot. */
export function startFxScheduler(): void {
  cron.schedule("30 5 * * *", () => {
    runFxDailyTick().catch((err) => {
      logger.error({ err }, "[FX] daily tick failed");
    });
  });
  logger.info("FX scheduler started (daily)");
}
