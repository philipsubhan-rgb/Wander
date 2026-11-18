/**
 * Speech rendering — the spoken text is the SAME text as the screen's,
 * minus markdown syntax (§2.4 / Story 2.2: what is said matches what
 * is shown). The fixtures are the real presentation formatters'
 * output (options presentation, booking review surface), so the
 * invariant under test is the one travelers depend on: every price,
 * total, time, and name in the text survives into the spoken rendering
 * byte-identical — the pass can remove syntax, never re-author facts.
 */

import { describe, it, expect, vi } from "vitest";
import type { BookingAttempt, BookingAttemptTraveler } from "@workspace/db";

// The formatters under test are pure, but their modules import
// @workspace/db at load — substitute the chainable mock (the
// agent.loop.test.ts pattern) so the suite runs without a database.
vi.mock("@workspace/db", () => {
  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
    };
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "set", "values", "returning"]) {
      chain[m] = () => chain;
    }
    return chain;
  };
  const fakeTable = new Proxy({}, { get: (_t, p) => p });
  return {
    db: {
      select: vi.fn(() => makeChain()),
      insert: vi.fn(() => makeChain()),
      update: vi.fn(() => makeChain()),
      delete: vi.fn(() => makeChain()),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    },
    bookingAttemptsTable: fakeTable,
    bookingAttemptTravelersTable: fakeTable,
    bookingsTable: fakeTable,
    bookingTravelersTable: fakeTable,
    bookingSplitsTable: fakeTable,
    commissionRecordsTable: fakeTable,
    flightsTable: fakeTable,
    tripsTable: fakeTable,
    tripParticipantsTable: fakeTable,
    usersTable: fakeTable,
    accommodationsTable: fakeTable,
    activitiesTable: fakeTable,
    itineraryDaysTable: fakeTable,
    carRentalsTable: fakeTable,
    reservationsTable: fakeTable,
    advisoriesTable: fakeTable,
    flightWatchesTable: fakeTable,
    travelerProfilesTable: fakeTable,
    profileAccessLogTable: fakeTable,
    tripRosterEntriesTable: fakeTable,
    travelerRulesTable: fakeTable,
    travelerContextTable: fakeTable,
    travelerCompanionsTable: fakeTable,
    savedGroupsTable: fakeTable,
    marcoMessagesTable: fakeTable,
    intakeSessionsTable: fakeTable,
    fxRateSnapshotsTable: fakeTable,
    pool: { query: vi.fn(), end: vi.fn() },
  };
});

import { renderSpeechText } from "./voiceRendering";
import { formatOptionSetText } from "./agentOptionsTools";
import { formatReviewText } from "./agentBookingTools";
import type { FlightOption, OptionSet } from "./options";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function flightOption(overrides: Partial<FlightOption> = {}): FlightOption {
  return {
    id: "off_123",
    kind: "flight",
    adapter: "duffel",
    supplier: "United",
    money: { amountMinor: 61200, currency: "USD" },
    homeEquivalent: {
      money: { amountMinor: 56304, currency: "EUR" },
      fxSnapshotId: 5,
      asOf: "2026-11-18",
    },
    pricedAt: "2026-11-18T09:00:00Z",
    priceNature: "firm",
    fulfillment: "api_rail",
    ruleViolations: [],
    partner: null,
    summary: {
      carrier: "United",
      carrierCode: "UA",
      slices: [
        {
          origin: "EWR",
          destination: "MUC",
          departAt: "2026-09-23T17:00:00-04:00",
          arriveAt: "2026-09-24T07:10:00+02:00",
          stops: 0,
          layovers: [],
          durationMinutes: 490,
          flightNumbers: ["UA30"],
        },
      ],
      totalDurationMinutes: 490,
      totalStops: 0,
      fareClass: "Main Cabin",
      cabinClass: "economy",
      changeable: true,
      refundable: false,
      connectionAirports: [],
      label: "UA30 Main Cabin",
    },
    ...overrides,
  } as FlightOption;
}

function optionSetText(): string {
  const option = flightOption();
  const set: OptionSet = {
    kind: "flight",
    options: [
      {
        option,
        score: 10,
        reasons: ["cheapest option that fits your rules"],
        against: [],
        violations: [],
        disclosure: null,
      },
    ],
    casualties: [
      {
        option: flightOption({
          id: "off_basic",
          money: { amountMinor: 49900, currency: "USD" },
          summary: { ...flightOption().summary, fareClass: "Basic Economy", label: "UA30 Basic Economy" },
        }),
        violations: [
          {
            ruleType: "fare_class_ban",
            message: "Excluded by your no-Basic-Economy rule.",
          } as OptionSet["casualties"][number]["violations"][number],
        ],
      },
    ],
    relaxed: false,
    pricedAt: "2026-11-18T09:00:00Z",
    fromCache: false,
    stale: false,
    staleness: "fresh",
    adapterId: "duffel",
    notices: [],
  };
  return formatOptionSetText(set, {
    origin: "EWR",
    destination: "MUC",
    departureDate: "2026-09-23",
    passengerCount: 2,
  });
}

function reviewText(): string {
  const attempt = {
    id: 42,
    supplier: "United",
    kind: "flight",
    state: "review",
    presentedAmountMinor: 61200,
    presentedCurrency: "USD",
    reviewedAmountMinor: 61200,
    reviewedCurrency: "USD",
    homeEquivalentMinor: 56304,
    homeCurrency: "EUR",
    changeTerms: "Changes are allowed by the fare rules (any fare difference still applies).",
    cancelTerms: "Non-refundable — cancelling forfeits the fare.",
    whyThisOptionText: "UA30 Main Cabin was the cheapest option that fit your rules.",
    visibility: "shared",
  } as unknown as BookingAttempt;
  const coverage = [{ confirmedAt: null }] as unknown as BookingAttemptTraveler[];
  return formatReviewText(attempt, coverage);
}

const MONEY_RE = /\$\d[\d,]*\.\d{2}|€\d[\d,]*\.\d{2}/g;

function moneyFigures(text: string): string[] {
  return [...text.matchAll(MONEY_RE)].map((m) => m[0]);
}

// ─── The pass itself ─────────────────────────────────────────────────────────

describe("renderSpeechText", () => {
  it("strips markdown syntax while keeping every word", () => {
    const spoken = renderSpeechText(
      "## Your trip\n\n**Total: $612.00** — `UA30` departs at **5:00 PM**.\n\n- First item\n- Second item",
    );
    expect(spoken).toBe(
      "Your trip\n\nTotal: $612.00 — UA30 departs at 5:00 PM.\n\nFirst item\nSecond item",
    );
    expect(spoken).not.toContain("**");
    expect(spoken).not.toContain("`");
    expect(spoken).not.toContain("##");
  });

  it("flattens numbered and bulleted lists and drops code fences", () => {
    const spoken = renderSpeechText("```\n1. Alpha\n2) Beta\n• Gamma\n```");
    expect(spoken).toBe("Alpha\nBeta\nGamma");
  });

  it("collapses blank runs and trims the ends", () => {
    expect(renderSpeechText("\n\nHello\n\n\n\nWorld\n\n")).toBe("Hello\n\nWorld");
  });
});

// ─── Fidelity over the real presentation fixtures ────────────────────────────

describe("spoken rendering equals text rendering", () => {
  it("priced flight options: every figure in the text is spoken verbatim", () => {
    const text = optionSetText();
    const spoken = renderSpeechText(text);
    // The fixture really carries figures (guard against a vacuous pass).
    expect(moneyFigures(text)).toContain("$612.00");
    expect(moneyFigures(text).length).toBeGreaterThanOrEqual(2);
    expect(moneyFigures(spoken)).toEqual(moneyFigures(text));
    // Times, flight numbers, and the casualty section survive too.
    expect(spoken).toContain("UA30");
    expect(spoken).toContain("Total: $612.00");
    expect(spoken).toContain("Not shown — excluded by your rules:");
    expect(spoken).toContain("UA30 Basic Economy");
  });

  it("booking review surface: the total the screen shows is the total spoken", () => {
    const text = reviewText();
    const spoken = renderSpeechText(text);
    expect(moneyFigures(text)).toContain("$612.00");
    expect(moneyFigures(spoken)).toEqual(moneyFigures(text));
    expect(spoken).toContain("Total to be charged: $612.00");
    expect(spoken).toContain("Nothing is booked yet.");
  });

  it("a markdown-flavored Marco reply keeps its figures through the pass", () => {
    const reply =
      "Here's the best fit: **United UA30**, nonstop, arriving **7:10 AM**.\n\n" +
      "- Total: **$612.00** for 2 adults\n" +
      "- ≈ **€563.04** in your currency (estimate)";
    const spoken = renderSpeechText(reply);
    expect(moneyFigures(spoken)).toEqual(["$612.00", "€563.04"]);
    expect(spoken).toContain("7:10 AM");
    expect(spoken).not.toContain("**");
  });
});
