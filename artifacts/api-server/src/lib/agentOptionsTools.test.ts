/**
 * Options tools (`options_*`) — tool-run tests with an injected
 * OptionsService (stub adapter). Verifies what Marco actually voices:
 * ranked options with totals and priced-at age, casualties with their
 * rules, home-equivalent estimates labeled, and the plain disabled
 * answer when Duffel isn't configured. Identity comes from the
 * ToolContext — the tool has no userId argument to aim at anyone else.
 *
 * @workspace/db is mocked because the tool's service module imports it
 * for its default wiring; the injected service never queries it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

// The stays tool geocodes its place name through the weather module's
// geocoder; mock it so tool tests stay offline and deterministic.
const geoMock = vi.hoisted(() => ({ geocode: vi.fn() }));
vi.mock("./weather", () => ({ geocodeDestination: geoMock.geocode }));

import { money } from "@workspace/money";
import {
  OptionCache,
  parseDecimalToRational,
  type OptionsAdapter,
  type StayOption,
  type StaySummary,
  type WanderOption,
} from "./options";
import { OptionsService, setDefaultOptionsServiceForTests } from "./optionsService";
import { OPTIONS_TOOLS } from "./agentOptionsTools";
import type { ToolContext } from "./agentTools";
import type { RuleInput } from "./rulesEngine";

const T0 = Date.parse("2026-11-18T08:00:00Z");
const CTX: ToolContext = { userId: 42, role: "traveler" };
const tool = OPTIONS_TOOLS.find((t) => t.name === "options_search_flights")!;

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
    pricedAt: "2026-11-18T08:00:00Z",
    priceNature: "firm",
    fulfillment: "api_rail",
    ruleViolations: [],
    partner: null,
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

function stubAdapter(options: WanderOption[]): OptionsAdapter {
  return {
    id: "stub",
    enabled: true,
    disabledReason: "",
    searchFlights: async () => options,
  };
}

function injectService(adapter: OptionsAdapter, rules: RuleInput[] = []) {
  setDefaultOptionsServiceForTests(
    new OptionsService({
      adapters: [adapter],
      cache: new OptionCache(() => T0),
      loadRules: async () => rules,
      loadHomeCurrency: async () => "EUR",
      fxResolver: async (from) =>
        from === "USD"
          ? { ...parseDecimalToRational("0.92")!, snapshotId: 7, asOf: "2026-11-17T00:00:00Z" }
          : null,
      now: () => T0,
    }),
  );
}

beforeEach(() => {
  injectService(
    stubAdapter([
      flightOption("basic", 90000, "Basic Economy", false),
      flightOption("standard", 122400, "Economy", true),
    ]),
    [NO_BASIC],
  );
});

afterEach(() => {
  setDefaultOptionsServiceForTests(null);
});

describe("options_search_flights", () => {
  it("voices ranked options with totals, priced-at age, home-equivalent estimate, and rule casualties", async () => {
    const result = await tool.run(CTX, {
      origin: "EWR",
      destination: "MUC",
      departureDate: "2026-12-03",
      passengers: 2,
    } as never);
    expect(result.ok).toBe(true);
    const text = result.text;
    expect(text).toContain("Flight options EWR → MUC, departing 2026-12-03 (2 adults)");
    expect(text).toContain("priced just now");
    expect(text).toContain("United Airlines — nonstop");
    expect(text).toContain("Total: $1,224.00");
    expect(text).toContain("≈ €1,126.08 in your currency (estimate)");
    expect(text).toContain("Not shown — excluded by your rules:");
    expect(text).toContain("UA30 Basic Economy — Breaks your rule: never Basic Economy.");
    // The structured payload rides along for the UI.
    const data = result.data as { options: unknown[]; casualties: unknown[] };
    expect(data.options).toHaveLength(1);
    expect(data.casualties).toHaveLength(1);
  });

  it("labels the relaxed path when every option breaks a rule", async () => {
    injectService(stubAdapter([flightOption("basic", 90000, "Basic Economy", false)]), [NO_BASIC]);
    const result = await tool.run(CTX, {
      origin: "EWR",
      destination: "MUC",
      departureDate: "2026-12-03",
    } as never);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Every option breaks at least one of your rules");
    expect(result.text).toContain("⚠ Breaks your rule: never Basic Economy.");
  });

  it("says plainly when flight search isn't configured — and shows no prices", async () => {
    injectService({
      id: "duffel",
      enabled: false,
      disabledReason: "Duffel isn't configured (no DUFFEL_API_TOKEN), so live flight prices are unavailable.",
      searchFlights: async () => {
        throw new Error("must never be called while disabled");
      },
    });
    const result = await tool.run(CTX, {
      origin: "EWR",
      destination: "MUC",
      departureDate: "2026-12-03",
    } as never);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Duffel isn't configured");
    expect(result.text).toContain("No prices are shown rather than invented ones.");
    expect(result.text).not.toContain("$");
  });

  it("takes identity from the ToolContext — there is no userId argument to spoof", () => {
    const props = (tool.parameters as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(props)).not.toContain("userId");
    expect(Object.keys(props)).not.toContain("tripId");
  });
});

// ─── options_search_stays (Task 3) ───────────────────────────────────────────

const stayTool = OPTIONS_TOOLS.find((t) => t.name === "options_search_stays")!;

function stayOptionFixture(
  // Omit first: intersecting Partial<StayOption> with { summary?: Partial<…> }
  // would make the effective summary type StaySummary & Partial<StaySummary>
  // (a full summary), defeating the partial-override intent.
  overrides: Omit<Partial<StayOption>, "summary"> & { id: string; summary?: Partial<StaySummary> },
): StayOption {
  const base: StayOption = {
    id: overrides.id,
    kind: "stay",
    adapter: "stub",
    supplier: "Accor",
    summary: {
      propertyName: "Hotel Beispiel",
      propertyType: "hotel",
      stayStyle: "chain",
      isWholeHome: false,
      chainName: "Accor",
      cityName: "Munich",
      areaLabel: "Munich, Bavaria",
      starRating: 4,
      reviewScore: 8.7,
      reviewCount: 1240,
      roomName: "Deluxe King Room",
      beds: "king bed",
      checkInDate: "2026-12-03",
      checkOutDate: "2026-12-08",
      nights: 5,
      guestCount: 5,
      rooms: 1,
      breakdown: {
        base: money(66583, "GBP"),
        tax: money(8223, "GBP"),
        fee: money(5094, "GBP"),
        taxesAndFees: null,
        dueAtAccommodation: money(3995, "GBP"),
      },
      nightlyRate: money(15980, "GBP"),
      perPersonPerNight: money(3196, "GBP"),
      cancellationTerms: "Free cancellation until 2026-12-01",
      freeCancellation: true,
      boardType: "Breakfast included",
      rateId: "rat_test",
      quoteId: null,
      addressLine: null,
      label: "Hotel Beispiel, Munich",
    },
    money: money(79900, "GBP"),
    homeEquivalent: null,
    pricedAt: "2026-11-18T08:00:00Z",
    priceNature: "estimate",
    fulfillment: "api_rail",
    ruleViolations: [],
    partner: null,
  };
  return { ...base, ...overrides, summary: { ...base.summary, ...(overrides.summary ?? {}) } };
}

function homeFixture(): StayOption {
  return stayOptionFixture({
    id: "home1",
    supplier: "Altstadt Loft",
    money: money(120000, "EUR"),
    summary: {
      propertyName: "Altstadt Loft",
      propertyType: "apartment",
      stayStyle: "home",
      isWholeHome: true,
      chainName: null,
      roomName: null,
      beds: null,
      boardType: null,
      breakdown: {
        base: money(100000, "EUR"),
        tax: null,
        fee: null,
        taxesAndFees: money(20000, "EUR"),
        dueAtAccommodation: null,
      },
      nightlyRate: money(24000, "EUR"),
      perPersonPerNight: money(4800, "EUR"),
      cancellationTerms: null,
      freeCancellation: false,
      label: "Altstadt Loft, Munich",
    },
  });
}

function stubStayAdapter(options: WanderOption[]): OptionsAdapter {
  return {
    id: "stub",
    enabled: true,
    disabledReason: "",
    searchStays: async () => options,
  };
}

describe("options_search_stays", () => {
  beforeEach(() => {
    geoMock.geocode.mockResolvedValue({ lat: 48.137, lon: 11.575 });
    injectService(stubStayAdapter([stayOptionFixture({ id: "hotel1" }), homeFixture()]));
  });

  it("voices FULL-STAY totals with itemization, due-at-property, and derived per-night figures", async () => {
    const result = await stayTool.run(CTX, {
      location: "Munich",
      checkInDate: "2026-12-03",
      checkOutDate: "2026-12-08",
      guests: 5,
    } as never);
    expect(result.ok).toBe(true);
    const text = result.text;
    expect(text).toContain("Stay options near Munich");
    expect(text).toContain("(5 nights) (5 guests)");
    expect(text).toContain("priced just now");
    // The total is the whole stay — and the itemization sums to it.
    expect(text).toContain("Total for 5 nights: £799.00");
    expect(text).toContain("rent £665.83");
    expect(text).toContain("taxes £82.23");
    expect(text).toContain("fees £50.94");
    expect(text).toContain("£39.95 due at the property");
    expect(text).toContain("≈ £159.80 per night");
    expect(text).toContain("≈ £31.96 per person per night (5 guests)");
    expect(text).toContain("Free cancellation until 2026-12-01");
    // The home shows its combined taxes & fees (no invented split).
    expect(text).toContain("Total for 5 nights: €1,200.00");
    expect(text).toContain("taxes & fees €200.00");
    expect(text).toContain("Cancellation terms aren't stated at search time");
    const data = result.data as { kind: string; options: unknown[] };
    expect(data.kind).toBe("stay");
    expect(data.options).toHaveLength(2);
  });

  it("surfaces the whole-home signal for a group/long stay when homes are in the list", async () => {
    const result = await stayTool.run(CTX, {
      location: "Munich",
      checkInDate: "2026-12-03",
      checkOutDate: "2026-12-08",
      guests: 5,
    } as never);
    expect(result.text).toContain("Whole-home note: this list includes 1 whole-home option");
    expect(result.text).toContain("a group of 5 staying 5 nights");
  });

  it("surfaces the signal honestly when NO whole home came back", async () => {
    injectService(stubStayAdapter([stayOptionFixture({ id: "hotel1" })]));
    const result = await stayTool.run(CTX, {
      location: "Munich",
      checkInDate: "2026-12-03",
      checkOutDate: "2026-12-05", // 2 nights — the signal comes from the group size alone
      guests: 6,
    } as never);
    expect(result.text).toContain("Whole-home note: no whole-home options came back in this search");
    expect(result.text).toContain("a group of 6");
  });

  it("stays silent about whole homes for a small party on a short stay", async () => {
    const result = await stayTool.run(CTX, {
      location: "Munich",
      checkInDate: "2026-12-03",
      checkOutDate: "2026-12-05",
      guests: 2,
    } as never);
    expect(result.ok).toBe(true);
    expect(result.text).not.toContain("Whole-home note");
  });

  it("says plainly when the place can't be found — no search, no invented prices", async () => {
    geoMock.geocode.mockResolvedValue(null);
    const result = await stayTool.run(CTX, {
      location: "Nowheresville",
      checkInDate: "2026-12-03",
      checkOutDate: "2026-12-08",
    } as never);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("couldn't find a place called \"Nowheresville\"");
    expect(result.text).toContain("No prices are shown rather than invented ones.");
    expect(result.text).not.toContain("£");
  });

  it("rejects a check-out that isn't after check-in", async () => {
    const result = await stayTool.run(CTX, {
      location: "Munich",
      checkInDate: "2026-12-08",
      checkOutDate: "2026-12-03",
    } as never);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("must be after check-in");
  });

  it("says plainly when stay search isn't configured — and shows no prices", async () => {
    injectService({
      id: "duffel",
      enabled: false,
      disabledReason: "Duffel isn't configured (no DUFFEL_API_TOKEN), so live stay prices are unavailable.",
      searchStays: async () => {
        throw new Error("must never be called while disabled");
      },
    });
    const result = await stayTool.run(CTX, {
      location: "Munich",
      checkInDate: "2026-12-03",
      checkOutDate: "2026-12-08",
    } as never);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Duffel isn't configured");
    expect(result.text).toContain("live stay prices are unavailable");
    expect(result.text).toContain("No prices are shown rather than invented ones.");
    expect(result.text).not.toContain("£");
  });
});
