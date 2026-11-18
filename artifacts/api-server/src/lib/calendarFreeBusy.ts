/**
 * Calendar free/busy read — context layer rung 2 (architecture §4.1).
 *
 * When a traveler with a connected Google account proposes trip dates
 * in intake, Wander may consult their calendar's free/busy over that
 * window and flag a collision in plain terms: "you have something on
 * those dates." That is ALL it can ever say:
 *
 *   - The freebusy endpoint returns busy INTERVALS only — no titles,
 *     no attendees, no event content exists in the response.
 *   - This module never fetches event details and never stores busy
 *     data. A check's result is a boolean + a count; the intervals
 *     themselves are discarded the moment the overlap is computed.
 *   - Logs carry counts only — never interval times.
 *
 * Freshness (ADR-11): reads happen at DATES time only — no polling, no
 * background refresh. A short in-process cache (5 minutes) keeps a
 * multi-turn date negotiation from re-querying Google per turn; the
 * cache holds the boolean result, never the intervals.
 */

import { eq } from "drizzle-orm";
import { db, connectedAccountsTable, type ConnectedAccount } from "@workspace/db";
import { logger } from "./logger";
import { decryptToken } from "./credentialCrypto";
import { getAccountClient } from "./gmailScan";
import { hasFreeBusyScope } from "./scanLogic";
import { queryFreeBusy, type BusyInterval } from "./googleCalendar";
import type { OAuth2Client } from "google-auth-library";

export interface FreeBusyCheckResult {
  /** A connected account with a free/busy-capable grant exists. */
  connected: boolean;
  /** At least one busy block overlaps the proposed window. */
  conflict: boolean;
  /** How many busy blocks overlapped (never their times or content). */
  busyCount: number;
}

export interface FreeBusyDeps {
  loadAccounts?: (userId: number) => Promise<ConnectedAccount[]>;
  getClient?: (refreshToken: string) => Promise<OAuth2Client>;
  queryBusy?: (
    client: OAuth2Client,
    calendarIds: string[],
    timeMin: string,
    timeMax: string,
  ) => Promise<Record<string, BusyInterval[]>>;
  now?: () => Date;
}

const NOT_CONNECTED: FreeBusyCheckResult = { connected: false, conflict: false, busyCount: 0 };

/** Cache lifetime — one date negotiation, not a watcher (ADR-11). */
export const FREEBUSY_CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  result: FreeBusyCheckResult;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

/** Test seam: the cache is process state; suites start clean. */
export function clearFreeBusyCacheForTests(): void {
  cache.clear();
}

async function defaultLoadAccounts(userId: number): Promise<ConnectedAccount[]> {
  return db
    .select()
    .from(connectedAccountsTable)
    .where(eq(connectedAccountsTable.userId, userId));
}

/** True when ANY of the traveler's Google accounts can serve free/busy. */
export async function hasFreeBusyAccount(
  userId: number,
  deps: FreeBusyDeps = {},
): Promise<boolean> {
  try {
    const load = deps.loadAccounts ?? defaultLoadAccounts;
    const accounts = await load(userId);
    return accounts.some((a) => a.provider === "google" && hasFreeBusyScope(a.scopes));
  } catch (err) {
    logger.warn({ userId, err }, "[FreeBusy] account lookup failed");
    return false;
  }
}

/**
 * Check whether the traveler's connected calendar is busy anywhere in
 * [startDate, endDate] (trip dates, "YYYY-MM-DD"; the window covers the
 * full days, end-exclusive). Best-effort: any failure reads as "not
 * connected / no conflict" so a Google outage never blocks planning —
 * and never fabricates a conflict either.
 */
export async function checkFreeBusyForDates(
  userId: number,
  startDate: string,
  endDate: string,
  deps: FreeBusyDeps = {},
): Promise<FreeBusyCheckResult> {
  const cacheKey = `${userId}|${startDate}|${endDate}`;
  const now = deps.now ?? (() => new Date());
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > now().getTime()) return hit.result;

  let result: FreeBusyCheckResult = NOT_CONNECTED;
  try {
    result = await runCheck(userId, startDate, endDate, deps);
  } catch (err) {
    logger.warn({ userId, err }, "[FreeBusy] check failed — treating as no data");
    result = NOT_CONNECTED;
  }
  cache.set(cacheKey, { result, expiresAt: now().getTime() + FREEBUSY_CACHE_TTL_MS });
  return result;
}

async function runCheck(
  userId: number,
  startDate: string,
  endDate: string,
  deps: FreeBusyDeps,
): Promise<FreeBusyCheckResult> {
  const load = deps.loadAccounts ?? defaultLoadAccounts;
  const accounts = (await load(userId)).filter(
    (a) => a.provider === "google" && hasFreeBusyScope(a.scopes),
  );
  if (accounts.length === 0) return NOT_CONNECTED;

  // Full days in UTC, end-exclusive: [start 00:00Z, day-after-end 00:00Z).
  const timeMin = `${startDate}T00:00:00.000Z`;
  const endPlus = new Date(`${endDate}T00:00:00.000Z`);
  if (Number.isNaN(endPlus.getTime())) return NOT_CONNECTED;
  endPlus.setUTCDate(endPlus.getUTCDate() + 1);
  const timeMax = endPlus.toISOString();

  const getClient =
    deps.getClient ?? (async (rt: string) => getAccountClient(rt));
  const query = deps.queryBusy ?? queryFreeBusy;

  let busyCount = 0;
  let queried = false;
  for (const account of accounts) {
    try {
      const client = await getClient(decryptToken(account.encryptedRefreshToken));
      const byCalendar = await query(client, ["primary"], timeMin, timeMax);
      queried = true;
      for (const intervals of Object.values(byCalendar)) {
        for (const iv of intervals) {
          // Half-open overlap: [iv.start, iv.end) ∩ [timeMin, timeMax).
          if (iv.start < timeMax && iv.end > timeMin) busyCount += 1;
        }
      }
    } catch (err) {
      logger.warn(
        { userId, accountId: account.id, err },
        "[FreeBusy] account query failed — skipping account",
      );
    }
  }
  if (!queried) return NOT_CONNECTED;
  if (busyCount > 0) {
    // Counts only — the intervals themselves are never logged/stored.
    logger.info({ userId, busyCount }, "[FreeBusy] proposed dates collide with busy blocks");
  }
  return { connected: true, conflict: busyCount > 0, busyCount };
}
