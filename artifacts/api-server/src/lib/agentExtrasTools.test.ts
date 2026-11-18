/**
 * Marco extras tools — formatting tests (pure; fabricated rows).
 *
 * Covers: honest price rendering per nature (estimate labeled, quote
 * shows no number, note-only shows no charge), dismissed items hidden,
 * and the Family Budget framing — opt-in language, never
 * included-by-default, with the running total against the cap.
 */

import { describe, it, expect, vi } from "vitest";

// @workspace/db is mocked because the tool's service module imports it
// for its DB wiring; these formatting tests never query it.
vi.mock("@workspace/db", () => {
  const table = (name: string) => ({ __table: name });
  const chain: Record<string, unknown> = {};
  for (const m of ["from", "where", "orderBy", "limit", "returning", "values", "set"]) chain[m] = () => chain;
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res);
  const db = {
    select: vi.fn(() => chain),
    insert: vi.fn(() => chain),
    update: vi.fn(() => chain),
    delete: vi.fn(() => chain),
  };
  return {
    db,
    tripsTable: table("trips"),
    intakeSessionsTable: table("intake_sessions"),
    tripParticipantsTable: table("trip_participants"),
    accommodationsTable: table("accommodations"),
    flightsTable: table("flights"),
    carRentalsTable: table("car_rentals"),
    travelerRulesTable: table("traveler_rules"),
    extrasSuggestionsTable: table("extras_suggestions"),
  };
});

import type { ExtrasSuggestion } from "@workspace/db";
import { formatExtrasPassText } from "./agentExtrasTools";
import type { ExtrasPassResult } from "./extras";

function row(overrides: Partial<ExtrasSuggestion> = {}): ExtrasSuggestion {
  return {
    id: 1,
    tripId: 7,
    pack: "golf",
    itemKey: "club_shipping",
    title: "Ship your clubs instead of hauling them",
    detail: "The math.",
    detailData: {},
    priceAmountMinor: 57600,
    priceCurrency: "USD",
    priceNature: "estimate",
    state: "suggested",
    trigger: "intake_materialization",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as ExtrasSuggestion;
}

function result(overrides: Partial<ExtrasPassResult> = {}): ExtrasPassResult {
  return {
    tripId: 7,
    trigger: "on_demand",
    packsMatched: ["golf"],
    created: [],
    suggestions: [row()],
    tier: "premium",
    budgetReport: null,
    ...overrides,
  };
}

describe("formatExtrasPassText", () => {
  it("renders an estimate labeled as an estimate", () => {
    const text = formatExtrasPassText(result());
    expect(text).toContain("Ship your clubs instead of hauling them");
    expect(text).toContain("estimated $576.00");
    expect(text).toContain("Nothing here is booked");
  });

  it("quote-only items show no number", () => {
    const text = formatExtrasPassText(
      result({
        suggestions: [row({ itemKey: "tee_times", title: "Book tee times", priceAmountMinor: null, priceCurrency: null, priceNature: "quote" })],
      }),
    );
    expect(text).toContain("quote needed — no price until a supplier quotes it");
    expect(text).not.toContain("$");
  });

  it("note-only items render as a no-charge check", () => {
    const text = formatExtrasPassText(
      result({
        suggestions: [row({ itemKey: "entry_requirements", title: "Check entry requirements", priceAmountMinor: null, priceCurrency: null, priceNature: null })],
      }),
    );
    expect(text).toContain("no charge — a check Wander runs");
  });

  it("dismissed items are hidden; all-dismissed says so plainly", () => {
    const text = formatExtrasPassText(result({ suggestions: [row({ state: "dismissed" })] }));
    expect(text).toContain("won't be suggested again");
    expect(text).not.toContain("Ship your clubs");
  });

  it("unmatched character reports no packs", () => {
    const text = formatExtrasPassText(result({ packsMatched: [], suggestions: [] }));
    expect(text).toContain("No extras pass applies");
  });

  it("Family Budget: opt-in framing + running total against the cap", () => {
    const text = formatExtrasPassText(
      result({
        tier: "family_budget",
        budgetReport: {
          cap: { amountMinor: 100000, currency: "USD" },
          pricedTotalMinor: 57600,
          pricedItemCount: 1,
          unpricedItemCount: 1,
          overCap: false,
          remainingMinor: 42400,
        },
      }),
    );
    expect(text).toContain("opt-ins, NOT included in the plan or the budget unless you say yes");
    expect(text).toContain("Extras total so far: $576.00 of your $1,000.00 budget cap");
    expect(text).toContain("$424.00 of room left");
    expect(text).toContain("1 item still needs a quote");
  });

  it("Family Budget: over-cap is flagged in the framing", () => {
    const text = formatExtrasPassText(
      result({
        tier: "family_budget",
        budgetReport: {
          cap: { amountMinor: 20000, currency: "USD" },
          pricedTotalMinor: 57600,
          pricedItemCount: 1,
          unpricedItemCount: 0,
          overCap: true,
          remainingMinor: -37600,
        },
      }),
    );
    expect(text).toContain("OVER the cap on priced items alone");
  });
});
