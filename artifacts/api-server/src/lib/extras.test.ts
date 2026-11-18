/**
 * Extras Service — DB-level tests with a recording @workspace/db mock
 * (same pattern as watching.test.ts / outreach.test.ts).
 *
 * Covers: the pass end-to-end (TC-8: a golf trip gets suggestions
 * unprompted, with the materialization trigger recorded), idempotency
 * (a second pass inserts nothing), dismissal memory (a dismissed item
 * never re-suggests), applicability against resolved facts, Family
 * Budget cap reporting, and access control on reads/state changes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name });
  const ops: Array<{ op: string; table: string; values?: unknown; set?: unknown }> = [];
  const selectQueues: Record<string, unknown[][]> = {};
  const insertReturns: Record<string, unknown[]> = {};
  const updateReturns: Record<string, unknown[]> = {};

  function makeChain(kind: string, tableName?: string): Record<string, unknown> {
    const ctx = { table: tableName };
    const resolve = (): Promise<unknown> => {
      if (kind === "select") return Promise.resolve(selectQueues[ctx.table ?? ""]?.shift() ?? []);
      if (kind === "insert") return Promise.resolve(insertReturns[ctx.table ?? ""] ?? []);
      if (kind === "update") return Promise.resolve(updateReturns[ctx.table ?? ""] ?? []);
      return Promise.resolve([]);
    };
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolve().then(res, rej),
      catch: (rej: (e: unknown) => unknown) => resolve().catch(rej),
      finally: (fin: () => void) => resolve().finally(fin),
    };
    chain.from = (t: { __table: string }) => {
      ctx.table = t.__table;
      return chain;
    };
    for (const m of ["where", "orderBy", "limit", "returning"]) {
      chain[m] = () => chain;
    }
    chain.values = (v: unknown) => {
      ops.push({ op: "insert", table: ctx.table ?? "", values: v });
      return chain;
    };
    chain.set = (v: unknown) => {
      ops.push({ op: "update", table: ctx.table ?? "", set: v });
      return chain;
    };
    return chain;
  }

  const db = {
    select: vi.fn(() => makeChain("select")),
    insert: vi.fn((t: { __table: string }) => makeChain("insert", t.__table)),
    update: vi.fn((t: { __table: string }) => makeChain("update", t.__table)),
    delete: vi.fn((t: { __table: string }) => makeChain("delete", t.__table)),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { table, ops, selectQueues, insertReturns, updateReturns, db };
});

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
}));

vi.mock("@workspace/db", () => ({
  db: store.db,
  tripsTable: store.table("trips"),
  intakeSessionsTable: store.table("intake_sessions"),
  tripParticipantsTable: store.table("trip_participants"),
  accommodationsTable: store.table("accommodations"),
  flightsTable: store.table("flights"),
  carRentalsTable: store.table("car_rentals"),
  travelerRulesTable: store.table("traveler_rules"),
  extrasSuggestionsTable: store.table("extras_suggestions"),
}));

import {
  ExtrasAccessDenied,
  listExtrasSuggestions,
  runExtrasPass,
  setExtrasSuggestionState,
} from "./extras.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TRIP = {
  id: 7,
  title: "Scottsdale — golf trip",
  destination: "Scottsdale, Arizona",
  startDate: "2027-03-10",
  endDate: "2027-03-14",
  description: null,
  coverImage: null,
  status: "planning",
  adminNotes: null,
  createdAt: new Date(),
};

function intakeSession(style: Record<string, unknown> | null) {
  return {
    id: 5,
    userId: 42,
    state: "MATERIALIZED",
    slots: {
      ...(style ? { style: { value: style, provenance: "asked" } } : {}),
      destination: { value: { kind: "place", text: "Scottsdale" }, provenance: "stated" },
    },
    openItems: [],
    draftTripId: 7,
    channel: "text",
    questionsAsked: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function participants(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    tripId: 7,
    userId: 42 + i,
    isTripAdmin: i === 0,
  }));
}

function suggestionRow(itemKey: string, state = "suggested") {
  return {
    id: 100 + itemKey.length,
    tripId: 7,
    pack: "golf",
    itemKey,
    title: itemKey,
    detail: "detail",
    detailData: {},
    priceAmountMinor: null,
    priceCurrency: null,
    priceNature: null,
    state,
    trigger: "intake_materialization",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

/** Enqueue one full fact-resolution round for a golf trip. */
function enqueueGolfFacts(style: Record<string, unknown> | null = { text: "golf trip", tier: "premium" }) {
  store.selectQueues["trips"] = [[TRIP]];
  store.selectQueues["intake_sessions"] = [[intakeSession(style)]];
  store.selectQueues["trip_participants"] = [participants(4)];
  store.selectQueues["accommodations"] = [[]];
  store.selectQueues["flights"] = [[]];
  store.selectQueues["car_rentals"] = [[]];
  store.selectQueues["traveler_rules"] = [[]];
}

function inserts() {
  return store.ops.filter((o) => o.op === "insert" && o.table === "extras_suggestions");
}

beforeEach(() => {
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
  store.insertReturns["extras_suggestions"] = [suggestionRow("inserted")];
});

// ─── The pass ────────────────────────────────────────────────────────────────

describe("runExtrasPass", () => {
  it("TC-8: a golf trip gets suggestions unprompted at materialization", async () => {
    enqueueGolfFacts();
    store.selectQueues["extras_suggestions"] = [[], []]; // none existing; final list (mock returns inserts' row shape)
    const result = await runExtrasPass(7, "intake_materialization");
    expect(result).not.toBeNull();
    expect(result!.packsMatched).toEqual(["golf"]);
    const keys = inserts().map((o) => (o.values as { itemKey: string }).itemKey);
    expect(keys).toEqual(expect.arrayContaining(["club_shipping", "tee_times", "caddie", "resort_packages"]));
    for (const op of inserts()) {
      expect((op.values as { trigger: string }).trigger).toBe("intake_materialization");
    }
    const club = inserts().find((o) => (o.values as { itemKey: string }).itemKey === "club_shipping")!;
    const values = club.values as { priceAmountMinor: number; priceNature: string };
    expect(values.priceNature).toBe("estimate");
    expect(values.priceAmountMinor).toBe(Math.round(((8900 * 4 + 19900 * 4) / 2)));
  });

  it("idempotency: a second pass inserts nothing new", async () => {
    enqueueGolfFacts();
    const existing = ["club_shipping", "tee_times", "caddie", "resort_packages"].map((k) => suggestionRow(k));
    store.selectQueues["extras_suggestions"] = [existing, existing];
    const result = await runExtrasPass(7, "flight_added");
    expect(inserts()).toEqual([]);
    expect(result!.created).toEqual([]);
    expect(result!.suggestions).toHaveLength(4);
  });

  it("dismissal memory: a dismissed item never re-suggests", async () => {
    enqueueGolfFacts();
    const existing = [suggestionRow("club_shipping", "dismissed")];
    store.selectQueues["extras_suggestions"] = [existing, existing];
    await runExtrasPass(7, "on_demand");
    const keys = inserts().map((o) => (o.values as { itemKey: string }).itemKey);
    expect(keys).not.toContain("club_shipping");
    expect(keys).toEqual(expect.arrayContaining(["tee_times", "caddie", "resort_packages"]));
  });

  it("unmatched character: no packs, no inserts", async () => {
    enqueueGolfFacts({ text: "work conference", tier: "premium" });
    store.selectQueues["trips"] = [[{ ...TRIP, title: "Chicago — work conference", destination: "Chicago" }]];
    store.selectQueues["extras_suggestions"] = [[], []];
    const result = await runExtrasPass(7, "on_demand");
    expect(result!.packsMatched).toEqual([]);
    expect(inserts()).toEqual([]);
  });

  it("missing trip → null, no writes", async () => {
    store.selectQueues["trips"] = [[]];
    const result = await runExtrasPass(999, "on_demand");
    expect(result).toBeNull();
    expect(inserts()).toEqual([]);
  });
});

describe("Family Budget pass", () => {
  it("reports the running extras total against the cap from the style slot", async () => {
    enqueueGolfFacts({
      text: "family beach getaway",
      tier: "family_budget",
      budgetCapMinor: 20000,
      budgetCurrency: "USD",
    });
    store.selectQueues["trips"] = [[{ ...TRIP, title: "Beach — family beach getaway", destination: "Outer Banks beach" }]];
    store.selectQueues["accommodations"] = [[{ id: 1, tripId: 7, type: "airbnb" }]];
    // Final list: what the pass would have persisted (cabana estimate
    // 5 days × $75–$250/day midpoint = 81250 — deliberately over a
    // $200 cap, plus a quote-only boat day).
    const finalRows = [
      { ...suggestionRow("cabana_gear"), pack: "beach", priceAmountMinor: 81250, priceCurrency: "USD", priceNature: "estimate" },
      { ...suggestionRow("boat_day"), pack: "beach", priceNature: "quote" },
      { ...suggestionRow("grocery_prestock"), pack: "beach", priceAmountMinor: 5500, priceCurrency: "USD", priceNature: "estimate" },
    ];
    store.selectQueues["extras_suggestions"] = [[], finalRows];
    const result = await runExtrasPass(7, "intake_materialization");
    expect(result!.tier).toBe("family_budget");
    expect(result!.budgetReport).not.toBeNull();
    expect(result!.budgetReport!.cap).toEqual({ amountMinor: 20000, currency: "USD" });
    expect(result!.budgetReport!.pricedTotalMinor).toBe(81250 + 5500);
    expect(result!.budgetReport!.unpricedItemCount).toBe(1);
    expect(result!.budgetReport!.overCap).toBe(true);
  });
});

// ─── Reads / state ───────────────────────────────────────────────────────────

describe("access + state", () => {
  it("listExtrasSuggestions denies a non-participant", async () => {
    store.selectQueues["trip_participants"] = [[]];
    await expect(listExtrasSuggestions(7, 99, "traveler")).rejects.toBeInstanceOf(ExtrasAccessDenied);
  });

  it("setExtrasSuggestionState updates the row for a participant", async () => {
    const row = suggestionRow("club_shipping");
    store.selectQueues["extras_suggestions"] = [[row]];
    store.selectQueues["trip_participants"] = [[{ tripId: 7, userId: 42, isTripAdmin: true }]];
    store.updateReturns["extras_suggestions"] = [{ ...row, state: "dismissed" }];
    const updated = await setExtrasSuggestionState(row.id, 42, "traveler", "dismissed");
    expect(updated.state).toBe("dismissed");
    const update = store.ops.find((o) => o.op === "update" && o.table === "extras_suggestions");
    expect((update!.set as { state: string }).state).toBe("dismissed");
  });

  it("setExtrasSuggestionState denies a non-participant before any update", async () => {
    const row = suggestionRow("club_shipping");
    store.selectQueues["extras_suggestions"] = [[row]];
    store.selectQueues["trip_participants"] = [[]];
    await expect(setExtrasSuggestionState(row.id, 99, "traveler", "accepted")).rejects.toBeInstanceOf(
      ExtrasAccessDenied,
    );
    expect(store.ops.filter((o) => o.op === "update")).toEqual([]);
  });
});
