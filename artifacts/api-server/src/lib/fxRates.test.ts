/**
 * FX snapshot population — mocked Frankfurter fetch, injected store.
 * The discipline under test: all-or-nothing. Every payload validates
 * completely before any row is written; any failure (HTTP, network,
 * missing/invalid rate, base mismatch) writes nothing, so yesterday's
 * snapshots stand. @workspace/db is mocked because fxRates imports it
 * for the default store; every test injects its own store seam.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => {
  const table = (name: string) => ({ __table: name, id: `${name}.id` });
  const chain: Record<string, unknown> = {};
  for (const m of ["values", "onConflictDoNothing", "returning"]) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res);
  return {
    db: { insert: vi.fn(() => chain) },
    fxRateSnapshotsTable: table("fx_rate_snapshots"),
  };
});

import {
  FX_BASES,
  FX_CURRENCIES,
  FX_SOURCE,
  parseFrankfurterLatest,
  rateToDecimalString,
  refreshFxSnapshots,
  type FxFetchLike,
  type FxSnapshotRow,
} from "./fxRates.js";
import { runFxDailyTick } from "./fxScheduler.js";

const DATE = "2026-11-17";

/** A complete, valid rates map for `base` (every other currency). */
function ratesFor(base: string): Record<string, number> {
  const pinned: Record<string, Record<string, number>> = {
    EUR: { USD: 1.0825, GBP: 0.8546, JPY: 169.42 },
    USD: { EUR: 0.9238, GBP: 0.7891, JPY: 156.5 },
    GBP: { EUR: 1.1701, USD: 1.2673, JPY: 200 },
  };
  const rates: Record<string, number> = {};
  for (const code of FX_CURRENCIES) {
    if (code === base) continue;
    rates[code] = pinned[base]?.[code] ?? 1.5;
  }
  return rates;
}

function payloadFor(base: string, mutate?: (p: Record<string, unknown>) => void) {
  const p: Record<string, unknown> = { amount: 1, base, date: DATE, rates: ratesFor(base) };
  mutate?.(p);
  return p;
}

/** A fetch that serves valid payloads, with per-base overrides. */
function mockFetch(overrides: Partial<Record<string, () => Promise<unknown>>> = {}): FxFetchLike {
  return async (url: string) => {
    const base = new URL(url).searchParams.get("from") ?? "";
    const override = overrides[base];
    if (override) return override() as ReturnType<FxFetchLike>;
    return { ok: true, status: 200, json: async () => payloadFor(base) };
  };
}

function recordingStore() {
  const calls: FxSnapshotRow[][] = [];
  return {
    calls,
    insert: async (rows: FxSnapshotRow[]) => {
      calls.push(rows);
      return rows.length;
    },
  };
}

describe("rateToDecimalString", () => {
  it("renders exact decimal strings, trimming scale-10 padding", () => {
    expect(rateToDecimalString(1.0825)).toBe("1.0825");
    expect(rateToDecimalString(200)).toBe("200");
    expect(rateToDecimalString(0.8546)).toBe("0.8546");
    expect(rateToDecimalString(169.42345678901)).toBe("169.423456789");
    expect(rateToDecimalString(156.5)).toBe("156.5");
  });

  it("throws on anything that cannot be a real rate", () => {
    for (const bad of [0, -1.2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => rateToDecimalString(bad)).toThrow();
    }
  });
});

describe("parseFrankfurterLatest", () => {
  it("builds one row per quote with source and as-of from the payload date", () => {
    const { date, rows } = parseFrankfurterLatest(payloadFor("EUR"), "EUR", FX_CURRENCIES);
    expect(date).toBe(DATE);
    expect(rows).toHaveLength(FX_CURRENCIES.length - 1);
    expect(rows.every((r) => r.baseCurrency === "EUR" && r.source === FX_SOURCE)).toBe(true);
    expect(rows.every((r) => r.asOf.toISOString() === `${DATE}T00:00:00.000Z`)).toBe(true);
    expect(rows.find((r) => r.quoteCurrency === "USD")?.rate).toBe("1.0825");
    expect(rows.find((r) => r.quoteCurrency === "JPY")?.rate).toBe("169.42");
    expect(rows.some((r) => r.quoteCurrency === "EUR")).toBe(false); // no self rows
  });

  it("rejects a base mismatch, a bad date, a missing rate, and a non-positive rate", () => {
    expect(() => parseFrankfurterLatest(payloadFor("USD"), "EUR", FX_CURRENCIES)).toThrow(/base mismatch/);
    expect(() =>
      parseFrankfurterLatest(payloadFor("EUR", (p) => (p.date = "17/11/2026")), "EUR", FX_CURRENCIES),
    ).toThrow(/invalid date/);
    expect(() =>
      parseFrankfurterLatest(
        payloadFor("EUR", (p) => delete (p.rates as Record<string, number>).JPY),
        "EUR",
        FX_CURRENCIES,
      ),
    ).toThrow(/missing rate EUR→JPY/);
    expect(() =>
      parseFrankfurterLatest(
        payloadFor("EUR", (p) => ((p.rates as Record<string, number>).CHF = 0)),
        "EUR",
        FX_CURRENCIES,
      ),
    ).toThrow(/not a finite positive number/);
    expect(() =>
      parseFrankfurterLatest(
        payloadFor("EUR", (p) => ((p.rates as Record<string, unknown>).CHF = "0.94")),
        "EUR",
        FX_CURRENCIES,
      ),
    ).toThrow(/not a finite positive number/);
  });
});

describe("refreshFxSnapshots", () => {
  it("fetches all three bases and writes the whole day in ONE insert", async () => {
    const store = recordingStore();
    const summary = await refreshFxSnapshots({ fetchFn: mockFetch(), insertSnapshots: store.insert });
    expect(store.calls).toHaveLength(1);
    const rows = store.calls[0];
    expect(rows).toHaveLength(FX_BASES.length * (FX_CURRENCIES.length - 1)); // 90
    expect(summary).toEqual({ fetched: 90, inserted: 90, asOf: DATE });
    const byPair = new Map(rows.map((r) => [`${r.baseCurrency}→${r.quoteCurrency}`, r.rate]));
    expect(byPair.get("EUR→USD")).toBe("1.0825");
    expect(byPair.get("USD→GBP")).toBe("0.7891");
    expect(byPair.get("GBP→JPY")).toBe("200");
    expect(byPair.get("GBP→USD")).toBe("1.2673");
    expect(rows.every((r) => r.source === "ECB/Frankfurter")).toBe(true);
  });

  it("writes NOTHING when one base's fetch fails (HTTP 500)", async () => {
    const store = recordingStore();
    const fetchFn = mockFetch({
      GBP: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    await expect(refreshFxSnapshots({ fetchFn, insertSnapshots: store.insert })).rejects.toThrow(/HTTP 500/);
    expect(store.calls).toHaveLength(0);
  });

  it("writes NOTHING when the network throws", async () => {
    const store = recordingStore();
    const fetchFn: FxFetchLike = async () => {
      throw new Error("socket hang up");
    };
    await expect(refreshFxSnapshots({ fetchFn, insertSnapshots: store.insert })).rejects.toThrow(/socket hang up/);
    expect(store.calls).toHaveLength(0);
  });

  it("writes NOTHING when one payload in the set is invalid", async () => {
    const store = recordingStore();
    const fetchFn = mockFetch({
      USD: async () => ({
        ok: true,
        status: 200,
        json: async () =>
          payloadFor("USD", (p) => delete (p.rates as Record<string, number>).KRW),
      }),
    });
    await expect(refreshFxSnapshots({ fetchFn, insertSnapshots: store.insert })).rejects.toThrow(
      /missing rate USD→KRW/,
    );
    expect(store.calls).toHaveLength(0);
  });
});

describe("runFxDailyTick", () => {
  it("reports success with the day's as-of", async () => {
    const store = recordingStore();
    const summary = await runFxDailyTick({ fetchFn: mockFetch(), insertSnapshots: store.insert });
    expect(summary).toEqual({ ok: true, snapshotsWritten: 90, asOf: DATE });
  });

  it("swallows a failure into ok:false — yesterday's snapshots stand, nothing written", async () => {
    const store = recordingStore();
    const fetchFn: FxFetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const summary = await runFxDailyTick({ fetchFn, insertSnapshots: store.insert });
    expect(summary).toEqual({ ok: false, snapshotsWritten: 0, asOf: null });
    expect(store.calls).toHaveLength(0);
  });
});
