/**
 * Options Service orchestration — stub adapter, injected deps.
 * Covers the §8 refresh triggers (cache hit shared across travelers,
 * view-if-stale refetch, explicit refresh, parameter change), the
 * stale-fallback on refresh failure, the disabled-adapter answer, and
 * TC-3 rule filtering through the REAL service (rules → filter →
 * casualties / relaxed labels).
 *
 * @workspace/db is mocked because optionsService's default wiring
 * imports it; every test here injects its own deps, so no query runs.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@workspace/db", () => {
  const table = (name: string) => ({ __table: name });
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "returning"]) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res);
  const db = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
  };
  return {
    db,
    fxRateSnapshotsTable: table("fx_rate_snapshots"),
    usersTable: table("users"),
    savedGroupsTable: table("saved_groups"),
    travelerCompanionsTable: table("traveler_companions"),
    travelerContextTable: table("traveler_context"),
    travelerRulesTable: table("traveler_rules"),
    tripParticipantsTable: table("trip_participants"),
    tripsTable: table("trips"),
  };
});

import { money } from "@workspace/money";
import {
  OptionCache,
  parseDecimalToRational,
  type OptionsAdapter,
  type StayOption,
  type StaySearchContext,
  type StaySummary,
  type WanderOption,
} from "./options";
import { OptionsService } from "./optionsService";
import type { RuleInput } from "./rulesEngine";

const T0 = Date.parse("2026-11-18T08:00:00Z");
const PRICED_AT = "2026-11-18T08:00:00Z";
const SEARCH = { origin: "EWR", destination: "MUC", departureDate: "2026-12-03", passengerCount: 2 };

function flightOption(id: string, amount: number, fareClass: string, changeable: boolean): WanderOption {
  return {
    id,
    kind: "flight",
    adapter: "stub",
    supplier: "United Airlines",
    summary: {
      carrier: "United Airlines",
      carrierCode: "UA",
      slices: [
        {
          origin: "EWR",
          destination: "MUC",
          departAt: "2026-12-03T17:00:00-05:00",
          arriveAt: "2026-12-04T07:10:00+01:00",
          stops: 0,
          layovers: [],
          durationMinutes: 490,
          flightNumbers: ["UA30"],
        },
      ],
      totalDurationMinutes: 490,
      totalStops: 0,
      fareClass,
      cabinClass: "economy",
      changeable,
      connectionAirports: [],
      label: `UA30 ${fareClass}`,
    },
    money: money(amount, "USD"),
    homeEquivalent: null,
    pricedAt: PRICED_AT,
    priceNature: "firm",
    fulfillment: "api_rail",
    ruleViolations: [],
    partner: null,
  };
}

class StubAdapter implements OptionsAdapter {
  readonly id = "stub";
  readonly enabled = true;
  readonly disabledReason = "";
  calls = 0;
  failWith: Error | null = null;
  constructor(private readonly results: WanderOption[]) {}
  async searchFlights(): Promise<WanderOption[]> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    return this.results;
  }
}

class DisabledAdapter implements OptionsAdapter {
  readonly id = "duffel";
  readonly enabled = false;
  readonly disabledReason = "Duffel isn't configured (no DUFFEL_API_TOKEN), so live flight prices are unavailable.";
  async searchFlights(): Promise<WanderOption[]> {
    throw new Error("must never be called while disabled");
  }
}

const NO_BASIC: RuleInput = {
  id: 1,
  ruleClass: "hard",
  ruleType: "fare_class_ban",
  params: { banned: ["Basic Economy"] },
  scope: "all",
  source: "explicit",
  active: true,
};

function makeService(adapter: OptionsAdapter, opts: { rules?: RuleInput[]; now?: () => number } = {}) {
  return new OptionsService({
    adapters: [adapter],
    cache: new OptionCache(opts.now ?? (() => T0)),
    loadRules: async () => opts.rules ?? [],
    loadHomeCurrency: async () => "EUR",
    fxResolver: async (from) =>
      from === "USD"
        ? { ...parseDecimalToRational("0.92")!, snapshotId: 7, asOf: "2026-11-17T00:00:00Z" }
        : null,
    now: opts.now ?? (() => T0),
  });
}

describe("OptionsService.searchFlights — cache & refresh triggers (§8)", () => {
  it("fetches once, then serves the same leg from the shared cache — for ANY traveler", async () => {
    const adapter = new StubAdapter([flightOption("a", 61200, "Economy", true)]);
    const service = makeService(adapter);
    const first = await service.searchFlights(42, SEARCH);
    expect(adapter.calls).toBe(1);
    expect(first.fromCache).toBe(false);
    expect(first.options).toHaveLength(1);

    const second = await service.searchFlights(42, SEARCH);
    expect(second.fromCache).toBe(true);
    expect(adapter.calls).toBe(1);

    // A different traveler searching the same leg hits the same entry:
    // spend scales with distinct searches, not stored users (§8.4).
    const otherTraveler = await service.searchFlights(77, SEARCH);
    expect(otherTraveler.fromCache).toBe(true);
    expect(adapter.calls).toBe(1);
  });

  it("refetches on view-if-stale, on explicit refresh, and on parameter change", async () => {
    let now = T0;
    const adapter = new StubAdapter([flightOption("a", 61200, "Economy", true)]);
    const service = makeService(adapter, { now: () => now });

    await service.searchFlights(42, SEARCH);
    expect(adapter.calls).toBe(1);

    now = T0 + 21 * 60000; // past the 20-minute flight TTL
    const staleView = await service.searchFlights(42, SEARCH);
    expect(adapter.calls).toBe(2);
    expect(staleView.fromCache).toBe(false);

    const refreshed = await service.searchFlights(42, SEARCH, { refresh: true });
    expect(adapter.calls).toBe(3);
    expect(refreshed.fromCache).toBe(false);

    await service.searchFlights(42, { ...SEARCH, departureDate: "2026-12-04" });
    expect(adapter.calls).toBe(4); // parameter change = a new search, a new key
  });

  it("serves the stale set, labeled, when a refresh fails — old true numbers over an error", async () => {
    let now = T0;
    const adapter = new StubAdapter([flightOption("a", 61200, "Economy", true)]);
    const service = makeService(adapter, { now: () => now });
    await service.searchFlights(42, SEARCH);

    now = T0 + 30 * 60000;
    adapter.failWith = new Error("upstream down");
    const fallback = await service.searchFlights(42, SEARCH);
    expect(fallback.fromCache).toBe(true);
    expect(fallback.stale).toBe(true);
    expect(fallback.options).toHaveLength(1);
    expect(fallback.notices.join(" ")).toContain("Couldn't refresh");
  });

  it("propagates adapter errors when there is nothing cached to fall back on", async () => {
    const adapter = new StubAdapter([]);
    adapter.failWith = new Error("upstream down");
    const service = makeService(adapter);
    await expect(service.searchFlights(42, SEARCH)).rejects.toThrow("upstream down");
  });

  it("answers plainly when no adapter is enabled — empty set, reason, no invented prices", async () => {
    const service = makeService(new DisabledAdapter());
    const set = await service.searchFlights(42, SEARCH);
    expect(set.options).toEqual([]);
    expect(set.casualties).toEqual([]);
    expect(set.notices.join(" ")).toContain("DUFFEL_API_TOKEN");
    expect(set.adapterId).toBe("duffel");
  });
});

describe("OptionsService — TC-3 through the real service", () => {
  it("filters Basic Economy into casualties with the rule named, and attaches snapshot-backed home equivalents", async () => {
    const adapter = new StubAdapter([
      flightOption("basic", 45000, "Basic Economy", false),
      flightOption("standard", 61200, "Economy", true),
    ]);
    const service = makeService(adapter, { rules: [NO_BASIC] });
    const set = await service.searchFlights(42, SEARCH);
    expect(set.relaxed).toBe(false);
    expect(set.options.map((o) => o.option.id)).toEqual(["standard"]);
    expect(set.options[0].option.homeEquivalent).toEqual({
      money: money(56304, "EUR"),
      fxSnapshotId: 7,
      rateAsOf: "2026-11-17T00:00:00Z",
    });
    expect(set.casualties).toHaveLength(1);
    expect(set.casualties[0].option.id).toBe("basic");
    expect(set.casualties[0].violations[0].message).toContain("never Basic Economy");
    expect(set.staleness).toBe("priced just now");
  });

  it("only-Basic route: the set comes back relaxed, each option labeled with its violation", async () => {
    const adapter = new StubAdapter([
      flightOption("basic1", 45000, "Basic Economy", false),
      flightOption("basic2", 47000, "Basic Economy", false),
    ]);
    const service = makeService(adapter, { rules: [NO_BASIC] });
    const set = await service.searchFlights(42, SEARCH);
    expect(set.relaxed).toBe(true);
    expect(set.options).toHaveLength(2);
    for (const o of set.options) {
      expect(o.violations.length).toBeGreaterThan(0);
    }
    expect(set.casualties).toHaveLength(0);
  });

  it("a work-scoped rule does not leak onto a personal search (scope-aware filtering)", async () => {
    const workRule: RuleInput = { ...NO_BASIC, id: 9, scope: "work" };
    const adapter = new StubAdapter([flightOption("basic", 45000, "Basic Economy", false)]);
    const service = makeService(adapter, { rules: [workRule] });
    const personal = await service.searchFlights(42, SEARCH, { tripScope: "personal" });
    expect(personal.relaxed).toBe(false);
    expect(personal.casualties).toHaveLength(0);
    expect(personal.options.map((o) => o.option.id)).toEqual(["basic"]);
  });
});

// ─── Stays through the service (Task 3) ──────────────────────────────────────

const STAY_SEARCH: StaySearchContext = {
  latitude: 48.137,
  longitude: 11.575,
  radiusKm: 5,
  checkInDate: "2026-12-03",
  checkOutDate: "2026-12-08",
  guestCount: 5,
  rooms: 1,
};

function stayOptionFixture(
  overrides: Partial<StayOption> & { id: string; summary?: Partial<StaySummary> },
): StayOption {
  const base: StayOption = {
    id: overrides.id,
    kind: "stay",
    adapter: "stub",
    supplier: "Hotel Beispiel",
    summary: {
      propertyName: "Hotel Beispiel",
      propertyType: "hotel",
      stayStyle: "boutique",
      isWholeHome: false,
      chainName: null,
      cityName: "Munich",
      areaLabel: "Munich, Bavaria",
      starRating: 4,
      reviewScore: 8.7,
      reviewCount: 100,
      roomName: "Double Room",
      beds: null,
      checkInDate: "2026-12-03",
      checkOutDate: "2026-12-08",
      nights: 5,
      guestCount: 5,
      rooms: 1,
      breakdown: { base: null, tax: null, fee: null, taxesAndFees: null, dueAtAccommodation: null },
      nightlyRate: null,
      perPersonPerNight: null,
      cancellationTerms: null,
      freeCancellation: false,
      boardType: null,
      label: "Hotel Beispiel, Munich",
    },
    money: money(80000, "EUR"),
    homeEquivalent: null,
    pricedAt: PRICED_AT,
    priceNature: "estimate",
    fulfillment: "api_rail",
    ruleViolations: [],
    partner: null,
  };
  return { ...base, ...overrides, summary: { ...base.summary, ...(overrides.summary ?? {}) } };
}

class StubStayAdapter implements OptionsAdapter {
  readonly id = "stub-stays";
  readonly enabled = true;
  readonly disabledReason = "";
  calls = 0;
  constructor(private readonly results: WanderOption[]) {}
  async searchStays(): Promise<WanderOption[]> {
    this.calls++;
    return this.results;
  }
}

class DisabledStayAdapter implements OptionsAdapter {
  readonly id = "duffel";
  readonly enabled = false;
  readonly disabledReason =
    "Duffel isn't configured (no DUFFEL_API_TOKEN), so live stay prices are unavailable.";
  async searchStays(): Promise<WanderOption[]> {
    throw new Error("must never be called while disabled");
  }
}

const BOUTIQUE_ONLY: RuleInput = {
  id: 11,
  ruleClass: "hard",
  ruleType: "stay_style",
  params: { style: "boutique" },
  scope: "all",
  source: "explicit",
  active: true,
};

function makeStayService(
  adapters: OptionsAdapter[],
  opts: { rules?: RuleInput[]; now?: () => number } = {},
) {
  return new OptionsService({
    adapters,
    cache: new OptionCache(opts.now ?? (() => T0)),
    loadRules: async () => opts.rules ?? [],
    loadHomeCurrency: async () => "EUR",
    fxResolver: async (from) =>
      from === "USD"
        ? { ...parseDecimalToRational("0.92")!, snapshotId: 7, asOf: "2026-11-17T00:00:00Z" }
        : null,
    now: opts.now ?? (() => T0),
  });
}

describe("OptionsService.searchStays", () => {
  it("selects adapters by capability: flights and stays never cross", async () => {
    const flightAdapter = new StubAdapter([flightOption("f1", 61200, "Economy", true)]);
    const stayAdapter = new StubStayAdapter([stayOptionFixture({ id: "s1" })]);
    const service = makeStayService([stayAdapter, flightAdapter]); // stays listed FIRST on purpose
    const stays = await service.searchStays(42, STAY_SEARCH);
    expect(stayAdapter.calls).toBe(1);
    expect(flightAdapter.calls).toBe(0);
    expect(stays.kind).toBe("stay");
    expect(stays.options.map((o) => o.option.id)).toEqual(["s1"]);

    const flights = await service.searchFlights(42, SEARCH);
    expect(flightAdapter.calls).toBe(1);
    expect(stayAdapter.calls).toBe(1);
    expect(flights.kind).toBe("flight");
  });

  it("serves the same search from the shared cache for ANY traveler, within the 6h stay TTL", async () => {
    let now = T0;
    const stayAdapter = new StubStayAdapter([stayOptionFixture({ id: "s1" })]);
    const service = makeStayService([stayAdapter], { now: () => now });
    const first = await service.searchStays(42, STAY_SEARCH);
    expect(first.fromCache).toBe(false);
    now = T0 + 60 * 60 * 1000; // +1h: a flight entry would be stale; a stay entry is not
    const second = await service.searchStays(77, STAY_SEARCH);
    expect(second.fromCache).toBe(true);
    expect(stayAdapter.calls).toBe(1);
    now = T0 + 7 * 60 * 60 * 1000; // +7h: past the stay TTL → re-price on view
    const third = await service.searchStays(42, STAY_SEARCH);
    expect(third.fromCache).toBe(false);
    expect(stayAdapter.calls).toBe(2);
  });

  it("applies the stay_style hard rule through the real service (TC-3 shape)", async () => {
    const stayAdapter = new StubStayAdapter([
      stayOptionFixture({ id: "chain", summary: { stayStyle: "chain", chainName: "Accor", label: "Chain Hotel, Munich" } }),
      stayOptionFixture({ id: "boutique" }),
    ]);
    const service = makeStayService([stayAdapter], { rules: [BOUTIQUE_ONLY] });
    const set = await service.searchStays(42, STAY_SEARCH);
    expect(set.options.map((o) => o.option.id)).toEqual(["boutique"]);
    expect(set.casualties.map((c) => c.option.id)).toEqual(["chain"]);
    expect(set.casualties[0].violations[0].message).toContain("boutique stays only");
    expect(set.relaxed).toBe(false);
  });

  it("attaches a snapshot-backed home equivalent to a foreign-currency stay", async () => {
    const stayAdapter = new StubStayAdapter([
      stayOptionFixture({ id: "usd", money: money(100000, "USD") }),
    ]);
    const service = makeStayService([stayAdapter]);
    const set = await service.searchStays(42, STAY_SEARCH);
    const option = set.options[0].option;
    expect(option.money).toEqual(money(100000, "USD")); // supplier currency untouched
    expect(option.homeEquivalent?.money).toEqual(money(92000, "EUR")); // $1,000 × 0.92 exactly
    expect(option.homeEquivalent?.fxSnapshotId).toBe(7);
  });

  it("answers plainly when no stay provider is configured — empty set, no invented prices", async () => {
    const service = makeStayService([new DisabledStayAdapter()]);
    const set = await service.searchStays(42, STAY_SEARCH);
    expect(set.kind).toBe("stay");
    expect(set.options).toEqual([]);
    expect(set.casualties).toEqual([]);
    expect(set.notices[0]).toContain("live stay prices are unavailable");
  });
});
