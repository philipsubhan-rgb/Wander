/**
 * Options Service core — cache freshness (§8), FX home equivalents
 * (snapshot-backed only, exact rational math), hard-rule filtering with
 * casualties, and ranking purity (§5.5: flipping partner metadata must
 * leave ordering byte-identical).
 */

import { describe, it, expect } from "vitest";
import { money } from "@workspace/money";
import {
  OptionCache,
  attachHomeEquivalents,
  convertWithRate,
  flightCacheKey,
  isStale,
  nightsBetween,
  parseDecimalToRational,
  presentRankedSet,
  stayCacheKey,
  toNormalizedOption,
  type StayOption,
  type StaySearchContext,
  type StaySummary,
  rankOptionSet,
  stalenessLabel,
  type FlightOption,
  type FxRate,
  type RankableOption,
  type WanderOption,
} from "./options";
import type { RuleInput } from "./rulesEngine";

const T0 = Date.parse("2026-11-18T08:00:00Z");
const PRICED_AT = "2026-11-18T08:00:00Z";

function flightOption(overrides: Partial<FlightOption> & { id: string }): FlightOption {
  const base: FlightOption = {
    id: overrides.id,
    kind: "flight",
    adapter: "duffel",
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
      fareClass: "Economy",
      cabinClass: "economy",
      changeable: true,
      connectionAirports: [],
      label: "UA30 Economy",
    },
    money: money(60000, "USD"),
    homeEquivalent: null,
    pricedAt: PRICED_AT,
    priceNature: "firm",
    fulfillment: "api_rail",
    ruleViolations: [],
    partner: null,
  };
  return {
    ...base,
    ...overrides,
    summary: { ...base.summary, ...(overrides.summary ?? {}) },
  };
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

describe("OptionCache + flightCacheKey (§8 near-time tier)", () => {
  it("serves fresh entries within the 20-minute flight TTL and flags them stale after — computed at read, no timers", () => {
    let now = T0;
    const cache = new OptionCache(() => now);
    const options = [flightOption({ id: "a" })];
    cache.set(flightCacheKey({ origin: "EWR", destination: "MUC", departureDate: "2026-12-03", passengerCount: 2 }), options, PRICED_AT);
    const key = flightCacheKey({ origin: "EWR", destination: "MUC", departureDate: "2026-12-03", passengerCount: 2 });

    now = T0 + 10 * 60000;
    expect(cache.get(key)?.fresh).toBe(true);
    expect(cache.get(key)?.options).toBe(options);

    now = T0 + 21 * 60000;
    const stale = cache.get(key);
    expect(stale).toBeDefined();
    expect(stale!.fresh).toBe(false);
    expect(stale!.ageMs).toBe(21 * 60000);
  });

  it("keys by search parameters only — shared across travelers, distinct per parameter change", () => {
    const a = flightCacheKey({ origin: "ewr", destination: "muc", departureDate: "2026-12-03", passengerCount: 2 });
    const b = flightCacheKey({ origin: "EWR", destination: "MUC", departureDate: "2026-12-03", passengerCount: 2 });
    // Same leg, same parameters → same key, whoever asks (no user in the key).
    expect(a).toBe(b);
    const otherDate = flightCacheKey({ origin: "EWR", destination: "MUC", departureDate: "2026-12-04", passengerCount: 2 });
    const otherParty = flightCacheKey({ origin: "EWR", destination: "MUC", departureDate: "2026-12-03", passengerCount: 3 });
    expect(otherDate).not.toBe(a);
    expect(otherParty).not.toBe(a);
  });

  it("labels staleness in traveler language", () => {
    expect(stalenessLabel(PRICED_AT, T0)).toBe("priced just now");
    expect(stalenessLabel(PRICED_AT, T0 + 12 * 60000)).toBe("priced 12 min ago");
    expect(stalenessLabel(PRICED_AT, T0 + 125 * 60000)).toBe("priced 2 h 5 min ago");
    expect(isStale(PRICED_AT, "flight", T0 + 19 * 60000)).toBe(false);
    expect(isStale(PRICED_AT, "flight", T0 + 21 * 60000)).toBe(true);
    // Stays get the 6-hour TTL from §8.2.
    expect(isStale(PRICED_AT, "stay", T0 + 21 * 60000)).toBe(false);
  });
});

describe("FX home equivalents — exact, snapshot-backed, never guessed", () => {
  it("converts with exact rational math, exponent-aware", () => {
    const rate = parseDecimalToRational("0.9200000000")!;
    expect(convertWithRate(money(61200, "USD"), rate, "EUR")).toEqual(money(56304, "EUR"));
    // ¥15,234 at 0.0066 USD/JPY → $100.54 (0-decimal → 2-decimal shift).
    const jpyRate = parseDecimalToRational("0.0066")!;
    expect(convertWithRate(money(15234, "JPY"), jpyRate, "USD")).toEqual(money(10054, "USD"));
    expect(parseDecimalToRational("not-a-rate")).toBeNull();
  });

  it("attaches an equivalent only when a snapshot resolves; same-currency and no-snapshot stay bare", async () => {
    const usd = flightOption({ id: "usd" });
    const eur = flightOption({ id: "eur", money: money(50000, "EUR") });
    const gbp = flightOption({ id: "gbp", money: money(40000, "GBP") });
    const snapshot: FxRate = { ...parseDecimalToRational("0.92")!, snapshotId: 7, asOf: "2026-11-17T00:00:00Z" };
    let resolverCalls = 0;
    const out = await attachHomeEquivalents([usd, eur, gbp], "EUR", async (from) => {
      resolverCalls++;
      return from === "USD" ? snapshot : null;
    });
    expect(out[0].homeEquivalent).toEqual({
      money: money(55200, "EUR"),
      fxSnapshotId: 7,
      rateAsOf: "2026-11-17T00:00:00Z",
    });
    expect(out[1].homeEquivalent).toBeNull(); // already home currency — no conversion performed
    expect(out[2].homeEquivalent).toBeNull(); // no snapshot for GBP→EUR — never guessed
    expect(resolverCalls).toBe(2); // USD and GBP pairs only; EUR never queried

    const untouched = await attachHomeEquivalents([usd], null, async () => snapshot);
    expect(untouched[0].homeEquivalent).toBeNull(); // no home currency on file → no equivalent
  });
});

describe("rankOptionSet — hard rules filter, casualties reported (TC-3 shape)", () => {
  const basic = flightOption({
    id: "basic",
    money: money(45000, "USD"),
    summary: { fareClass: "Basic Economy", changeable: false, label: "UA30 Basic Economy" } as FlightOption["summary"],
  });
  const standard = flightOption({
    id: "standard",
    money: money(61200, "USD"),
    summary: { fareClass: "Economy", label: "UA31 Economy" } as FlightOption["summary"],
  });
  const strip = (o: WanderOption): RankableOption => {
    const { partner: _p, ...rest } = o;
    return rest;
  };

  it("excludes the Basic Economy option and reports it as a casualty with its rule", () => {
    const set = rankOptionSet([strip(basic), strip(standard)], [NO_BASIC]);
    expect(set.relaxed).toBe(false);
    expect(set.ranked.map((r) => r.option.id)).toEqual(["standard"]);
    expect(set.casualties).toHaveLength(1);
    expect(set.casualties[0].option.id).toBe("basic");
    expect(set.casualties[0].violations[0].message).toContain("never Basic Economy");
  });

  it("when ONLY Basic options exist, returns them least-violating and labeled — never silently clean", () => {
    const basic2 = flightOption({
      id: "basic2",
      money: money(47000, "USD"),
      summary: { fareClass: "Basic Economy", changeable: false, label: "LH458 Basic Economy" } as FlightOption["summary"],
    });
    const set = rankOptionSet([strip(basic), strip(basic2)], [NO_BASIC]);
    expect(set.relaxed).toBe(true);
    expect(set.ranked).toHaveLength(2);
    for (const r of set.ranked) {
      expect(r.violations.length).toBeGreaterThan(0);
      expect(r.violations[0].message).toContain("never Basic Economy");
    }
    expect(set.casualties).toHaveLength(0);
  });

  it("ranks by preference fit before price: a changeability preference lifts the changeable fare", () => {
    const pref: RuleInput = {
      id: 2,
      ruleClass: "preference",
      ruleType: "changeability_required",
      params: {},
      scope: "all",
      source: "explicit",
      active: true,
    };
    const cheapRigid = flightOption({
      id: "rigid",
      money: money(40000, "USD"),
      summary: { changeable: false, label: "UA1 Economy" } as FlightOption["summary"],
    });
    const pricierFlex = flightOption({
      id: "flex",
      money: money(50000, "USD"),
      summary: { changeable: true, label: "UA2 Economy" } as FlightOption["summary"],
    });
    const set = rankOptionSet([strip(cheapRigid), strip(pricierFlex)], [pref]);
    expect(set.ranked.map((r) => r.option.id)).toEqual(["flex", "rigid"]);
    expect(set.ranked[0].reasons.join(" ")).toContain("Changeable fare");
    // With no rules at all, the deterministic fit order is price asc.
    const bare = rankOptionSet([strip(pricierFlex), strip(cheapRigid)], []);
    expect(bare.ranked.map((r) => r.option.id)).toEqual(["rigid", "flex"]);
    expect(bare.ranked[0].reasons).toContain("Cheapest option that fits your rules");
  });

  it("never compares prices across currencies when ordering", () => {
    const eurCheap = flightOption({ id: "eur", money: money(10000, "EUR") });
    const usdDear = flightOption({ id: "usd", money: money(90000, "USD") });
    // Adapter order is preserved across currencies (no silent FX in ranking).
    const set = rankOptionSet([strip(eurCheap), strip(usdDear)], []);
    expect(set.ranked.map((r) => r.option.id)).toEqual(["eur", "usd"]);
  });
});

describe("ranking purity (§5.5) — partner metadata cannot move the ordering", () => {
  it("flipping partner flags on a fixed scenario leaves ordering and reasons byte-identical", () => {
    const mk = (id: string, amount: number, partner: WanderOption["partner"]): WanderOption =>
      flightOption({ id, money: money(amount, "USD"), partner });
    const scenarioA = [mk("o1", 70000, { id: "p1", name: "Partner One" }), mk("o2", 50000, null), mk("o3", 60000, { id: "p2", name: "Partner Two" })];
    const scenarioB = [mk("o1", 70000, null), mk("o2", 50000, { id: "p2", name: "Partner Two" }), mk("o3", 60000, { id: "p1", name: "Partner One" })];
    const stripAll = (os: WanderOption[]): RankableOption[] =>
      os.map(({ partner: _p, ...rest }) => rest);
    const a = rankOptionSet(stripAll(scenarioA), [NO_BASIC]);
    const b = rankOptionSet(stripAll(scenarioB), [NO_BASIC]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.ranked.map((r) => r.option.id)).toEqual(["o2", "o3", "o1"]);
  });

  it("presentation re-attaches partner + disclosure AFTER ordering, without reordering", () => {
    const mk = (id: string, amount: number): WanderOption => flightOption({ id, money: money(amount, "USD") });
    const options = [mk("o1", 70000), mk("o2", 50000)];
    const stripped = options.map(({ partner: _p, ...rest }) => rest);
    const ranked = rankOptionSet(stripped, []);
    const partners = new Map([
      ["o1", { id: "p1", name: "Partner One" }],
      ["o2", null],
    ]);
    const presented = presentRankedSet(ranked, partners);
    expect(presented.options.map((p) => p.option.id)).toEqual(["o2", "o1"]); // order untouched
    expect(presented.options[0].disclosure).toBeNull();
    expect(presented.options[1].disclosure).toBe("Partner: Partner One");
    expect(presented.options[1].option.partner).toEqual({ id: "p1", name: "Partner One" });
  });
});

// ─── Stays through the core (Task 3) ─────────────────────────────────────────

function stayOption(
  // Omit first: intersecting Partial<StayOption> with { summary?: Partial<…> }
  // would make the effective summary type StaySummary & Partial<StaySummary>
  // (a full summary), defeating the partial-override intent.
  overrides: Omit<Partial<StayOption>, "summary"> & { id: string; summary?: Partial<StaySummary> },
): StayOption {
  const base: StayOption = {
    id: overrides.id,
    kind: "stay",
    adapter: "duffel",
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
      guestCount: 2,
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
  return {
    ...base,
    ...overrides,
    summary: { ...base.summary, ...(overrides.summary ?? {}) },
  };
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

const CAP_500_EUR: RuleInput = {
  id: 12,
  ruleClass: "hard",
  ruleType: "budget_cap",
  params: { capMinor: 50000, currency: "EUR" },
  scope: "all",
  source: "explicit",
  active: true,
};

const stripStay = (o: StayOption): RankableOption => {
  const { partner: _p, ...rest } = o;
  return rest;
};

describe("stays — normalization, rules, ranking", () => {
  it("projects a stay onto the rules engine with its style and full-stay price", () => {
    const n = toNormalizedOption(stripStay(stayOption({ id: "s1" })));
    expect(n.kind).toBe("stay");
    expect(n.stayStyle).toBe("boutique");
    expect(n.priceMinor).toBe(80000);
    expect(n.currency).toBe("EUR");
    expect(n.label).toBe("Hotel Beispiel, Munich");
  });

  it("stay_style hard rule filters chain stays, keeps boutique", () => {
    const chain = stayOption({
      id: "chain",
      summary: { stayStyle: "chain", chainName: "Accor", label: "Chain Hotel, Munich" },
    });
    const boutique = stayOption({ id: "boutique" });
    const { ranked, casualties, relaxed } = rankOptionSet(
      [stripStay(chain), stripStay(boutique)],
      [BOUTIQUE_ONLY],
    );
    expect(relaxed).toBe(false);
    expect(ranked.map((r) => r.option.id)).toEqual(["boutique"]);
    expect(casualties.map((c) => c.option.id)).toEqual(["chain"]);
    expect(casualties[0].violations[0].message).toContain("boutique stays only");
  });

  it("budget_cap judges the FULL-STAY total, not a nightly figure", () => {
    const over = stayOption({ id: "over", money: money(80000, "EUR") }); // €800 for 5 nights
    const under = stayOption({ id: "under", money: money(40000, "EUR") });
    const { ranked, casualties } = rankOptionSet(
      [stripStay(over), stripStay(under)],
      [CAP_500_EUR],
    );
    expect(ranked.map((r) => r.option.id)).toEqual(["under"]);
    expect(casualties.map((c) => c.option.id)).toEqual(["over"]);
    expect(casualties[0].violations[0].message).toContain("budget cap");
  });

  it("ranks stays by preference fit then price, with no duration input", () => {
    const dear = stayOption({ id: "dear", money: money(90000, "EUR") });
    const cheap = stayOption({ id: "cheap", money: money(70000, "EUR") });
    const { ranked } = rankOptionSet([stripStay(dear), stripStay(cheap)], []);
    expect(ranked.map((r) => r.option.id)).toEqual(["cheap", "dear"]);
    expect(ranked[0].reasons).toContain("Cheapest option that fits your rules");
  });
});

describe("stays — cache key, TTL (§8: 6h), nights", () => {
  const STAY_CTX: StaySearchContext = {
    latitude: 48.137154,
    longitude: 11.576124,
    radiusKm: 5,
    checkInDate: "2026-12-03",
    checkOutDate: "2026-12-08",
    guestCount: 5,
    rooms: 1,
  };

  it("stayCacheKey is parameter-canonical and coordinate-tolerant", () => {
    expect(stayCacheKey(STAY_CTX)).toBe(stayCacheKey({ ...STAY_CTX }));
    // A 4th-decimal geocode wobble is the same search.
    expect(stayCacheKey(STAY_CTX)).toBe(
      stayCacheKey({ ...STAY_CTX, latitude: 48.137149, longitude: 11.576131 }),
    );
    expect(stayCacheKey(STAY_CTX)).not.toBe(stayCacheKey({ ...STAY_CTX, checkOutDate: "2026-12-09" }));
    expect(stayCacheKey(STAY_CTX)).not.toBe(stayCacheKey({ ...STAY_CTX, guestCount: 2 }));
  });

  it("a stay entry is fresh at 5h and stale at 7h (TTL 6h, unlike flights' 20m)", () => {
    let now = T0;
    const cache = new OptionCache(() => now);
    cache.set(stayCacheKey(STAY_CTX), [stayOption({ id: "s1" })], PRICED_AT);
    now = T0 + 60 * 60 * 1000; // +1h — long past the flight TTL
    expect(cache.get(stayCacheKey(STAY_CTX))?.fresh).toBe(true);
    now = T0 + 5 * 60 * 60 * 1000;
    expect(cache.get(stayCacheKey(STAY_CTX))?.fresh).toBe(true);
    now = T0 + 7 * 60 * 60 * 1000;
    expect(cache.get(stayCacheKey(STAY_CTX))?.fresh).toBe(false);
    expect(isStale(PRICED_AT, "stay", T0 + 7 * 60 * 60 * 1000)).toBe(true);
    expect(isStale(PRICED_AT, "stay", T0 + 5 * 60 * 60 * 1000)).toBe(false);
  });

  it("nightsBetween counts whole nights and rejects nonsense", () => {
    expect(nightsBetween("2026-12-03", "2026-12-08")).toBe(5);
    expect(nightsBetween("2026-12-08", "2026-12-03")).toBeNull();
    expect(nightsBetween("2026-12-03", "2026-12-03")).toBeNull();
    expect(nightsBetween("soon", "later")).toBeNull();
  });
});
