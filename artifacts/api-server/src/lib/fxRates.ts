/**
 * FX snapshot population (international-foundation §2.2/§2.5; Task 2 of
 * the stays-fx build). A daily job fetches the ECB reference rates via
 * the Frankfurter API (free, no key) and writes `fx_rate_snapshots`
 * rows — the provenance record the Options Service's home-equivalent
 * conversion reads (dbFxRateResolver). Until this job existed the table
 * was schema-only and every home equivalent silently came back null.
 *
 * The v1 currency set is the full ECB reference list Frankfurter
 * publishes — the currencies Wander actually encounters are a subset of
 * it, and storing the whole list costs nothing extra per day:
 *   EUR USD GBP CHF JPY CAD AUD NZD SEK NOK DKK PLN CZK HUF ISK BGN
 *   RON CNY HKD SGD INR KRW BRL MXN ZAR TRY ILS THB MYR IDR PHP  (31)
 * Snapshots are stored for three bases — EUR (the ECB's own base), USD
 * and GBP — so any pair with one of those on either side resolves
 * through the resolver's direct-or-inverse lookup. 3 bases × 30 quotes
 * = 90 rows/day.
 *
 * All-or-nothing discipline: every base is fetched and the ENTIRE
 * payload set is validated (base match, date shape, every rate a
 * finite positive number) before a single row is written, and the
 * write is one multi-row INSERT (atomic in Postgres). Any failure —
 * network, HTTP, malformed payload, a missing or non-positive rate —
 * writes NOTHING: yesterday's snapshots stay in place and the failure
 * is logged by the caller. Rates are never partial and never guessed.
 */

import { db, fxRateSnapshotsTable } from "@workspace/db";
import { logger } from "./logger.js";

export const FX_SOURCE = "ECB/Frankfurter";
export const FRANKFURTER_BASE_URL = "https://api.frankfurter.app";

/** The ECB reference currency list (Frankfurter's published set). */
export const FX_CURRENCIES = [
  "EUR", "USD", "GBP", "CHF", "JPY", "CAD", "AUD", "NZD", "SEK", "NOK",
  "DKK", "PLN", "CZK", "HUF", "ISK", "BGN", "RON", "CNY", "HKD", "SGD",
  "INR", "KRW", "BRL", "MXN", "ZAR", "TRY", "ILS", "THB", "MYR", "IDR",
  "PHP",
] as const;

/** Bases stored daily: the ECB base plus the two currencies Wander
 * prices and displays in most (the resolver inverts, so three bases
 * cover every EUR/USD/GBP-touching pair). */
export const FX_BASES = ["EUR", "USD", "GBP"] as const;

export class FxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FxError";
  }
}

/** Minimal fetch surface (mockable, same discipline as the adapters). */
export type FxFetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface FrankfurterClient {
  fetchLatest(base: string, quotes: readonly string[]): Promise<unknown>;
}

export function createFrankfurterClient(deps: {
  fetchFn?: FxFetchLike;
  baseUrl?: string;
} = {}): FrankfurterClient {
  const fetchFn: FxFetchLike =
    deps.fetchFn ?? ((url, init) => fetch(url, init) as ReturnType<FxFetchLike>);
  const baseUrl = deps.baseUrl ?? FRANKFURTER_BASE_URL;
  return {
    async fetchLatest(base, quotes) {
      const url = `${baseUrl}/latest?from=${encodeURIComponent(base)}&to=${quotes.join(",")}`;
      let res: Awaited<ReturnType<FxFetchLike>>;
      try {
        res = await fetchFn(url, { headers: { accept: "application/json" } });
      } catch (err) {
        throw new FxError(
          `Frankfurter request for base ${base} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!res.ok) {
        throw new FxError(`Frankfurter request for base ${base} failed (HTTP ${res.status})`);
      }
      try {
        return await res.json();
      } catch {
        throw new FxError(`Frankfurter response for base ${base} was not valid JSON`);
      }
    },
  };
}

/**
 * A JSON number → the exact decimal string for the numeric(18,10)
 * column. Frankfurter rates arrive as JSON numbers (doubles); the ECB
 * publishes at most ~6 significant decimals, far inside double
 * precision at these magnitudes, and toFixed(10) reproduces the
 * published decimal faithfully. Throws on anything that cannot be a
 * real rate (non-finite, ≤ 0, or too small to represent at scale 10) —
 * a bad rate must fail the whole refresh, never be stored.
 */
export function rateToDecimalString(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new FxError(`FX rate is not a finite positive number: ${String(value)}`);
  }
  if (value >= 1e21) {
    throw new FxError(`FX rate out of representable range: ${value}`);
  }
  const fixed = value.toFixed(10);
  const trimmed = fixed.includes(".")
    ? fixed.replace(/0+$/, "").replace(/\.$/, "")
    : fixed;
  if (trimmed === "0") {
    throw new FxError(`FX rate too small to represent at scale 10: ${value}`);
  }
  return trimmed;
}

export interface FxSnapshotRow {
  baseCurrency: string;
  quoteCurrency: string;
  rate: string;
  source: string;
  asOf: Date;
}

/**
 * Validate one Frankfurter /latest payload for `expectedBase` and turn
 * it into snapshot rows for every expected quote. Pure; throws FxError
 * on ANY deviation — the caller writes nothing unless every base
 * validates.
 */
export function parseFrankfurterLatest(
  payload: unknown,
  expectedBase: string,
  expectedQuotes: readonly string[],
): { date: string; rows: FxSnapshotRow[] } {
  if (!payload || typeof payload !== "object") {
    throw new FxError(`Frankfurter payload for base ${expectedBase} is not an object`);
  }
  const p = payload as { base?: unknown; date?: unknown; rates?: unknown };
  if (p.base !== expectedBase) {
    throw new FxError(
      `Frankfurter payload base mismatch: expected ${expectedBase}, got ${String(p.base)}`,
    );
  }
  if (
    typeof p.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(p.date) ||
    Number.isNaN(Date.parse(p.date))
  ) {
    throw new FxError(`Frankfurter payload for base ${expectedBase} has an invalid date: ${String(p.date)}`);
  }
  if (!p.rates || typeof p.rates !== "object") {
    throw new FxError(`Frankfurter payload for base ${expectedBase} has no rates object`);
  }
  const rates = p.rates as Record<string, unknown>;
  const asOf = new Date(`${p.date}T00:00:00.000Z`);
  const rows: FxSnapshotRow[] = [];
  for (const quote of expectedQuotes) {
    if (quote === expectedBase) continue;
    const raw = rates[quote];
    if (raw === undefined) {
      throw new FxError(`Frankfurter payload for base ${expectedBase} is missing rate ${expectedBase}→${quote}`);
    }
    let rate: string;
    try {
      rate = rateToDecimalString(raw as number);
    } catch {
      throw new FxError(
        `Frankfurter rate ${expectedBase}→${quote} is not a finite positive number: ${String(raw)}`,
      );
    }
    rows.push({ baseCurrency: expectedBase, quoteCurrency: quote, rate, source: FX_SOURCE, asOf });
  }
  return { date: p.date, rows };
}

export interface FxRefreshDeps {
  client?: FrankfurterClient;
  fetchFn?: FxFetchLike;
  /** Store seam for tests; defaults to the real one-statement insert. */
  insertSnapshots?: (rows: FxSnapshotRow[]) => Promise<number>;
}

export interface FxRefreshSummary {
  /** Snapshot rows offered to the store. */
  fetched: number;
  /** Rows actually inserted (re-runs of the same day insert 0 — the
   * (base, quote, source, as_of) unique index makes the job
   * idempotent). */
  inserted: number;
  /** The ECB reference date the snapshots are as of. */
  asOf: string;
}

async function defaultInsertSnapshots(rows: FxSnapshotRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  // ONE statement for the whole day: atomic by construction — the day
  // lands complete or not at all.
  const inserted = await db
    .insert(fxRateSnapshotsTable)
    .values(rows)
    .onConflictDoNothing()
    .returning({ id: fxRateSnapshotsTable.id });
  return inserted.length;
}

/**
 * Fetch → validate everything → write once. Throws (FxError or the
 * store's error) on any failure, having written nothing itself; the
 * scheduler wrapper logs and leaves yesterday's rows standing.
 */
export async function refreshFxSnapshots(deps: FxRefreshDeps = {}): Promise<FxRefreshSummary> {
  const client = deps.client ?? createFrankfurterClient({ fetchFn: deps.fetchFn });
  const insertSnapshots = deps.insertSnapshots ?? defaultInsertSnapshots;

  const rows: FxSnapshotRow[] = [];
  let asOf = "";
  for (const base of FX_BASES) {
    const payload = await client.fetchLatest(base, FX_CURRENCIES);
    const parsed = parseFrankfurterLatest(payload, base, FX_CURRENCIES);
    rows.push(...parsed.rows);
    asOf = parsed.date;
  }
  const inserted = await insertSnapshots(rows);
  logger.info(
    { fetched: rows.length, inserted, asOf, source: FX_SOURCE },
    "[FX] snapshots refreshed",
  );
  return { fetched: rows.length, inserted, asOf };
}
