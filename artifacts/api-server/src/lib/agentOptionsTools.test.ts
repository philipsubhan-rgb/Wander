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

import { money } from "@workspace/money";
import { OptionCache, parseDecimalToRational, type OptionsAdapter, type WanderOption } from "./options";
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
