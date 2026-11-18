/**
 * Context/Profile service (context layer) — DB-level tests with a
 * recording @workspace/db mock (outreach.test.ts pattern).
 *
 * Load-bearing behaviors:
 *  - learned home values are PROPOSALS: unconfirmed, and never
 *    overwriting a confirmed default (Story 6.1);
 *  - rules are validated by the engine at write time (a malformed rule
 *    can never reach the store);
 *  - companions store only organizer-provided data + a user-id link;
 *  - saved groups resolve members and are owner-scoped;
 *  - the digest separates confirmed knowledge from proposals.
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
    for (const m of ["where", "orderBy", "limit", "returning", "innerJoin", "leftJoin"]) {
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
  inArray: (...args: unknown[]) => args,
  desc: (...args: unknown[]) => args,
}));

vi.mock("@workspace/db", () => ({
  db: store.db,
  travelerContextTable: store.table("traveler_context"),
  travelerRulesTable: store.table("traveler_rules"),
  travelerCompanionsTable: store.table("traveler_companions"),
  savedGroupsTable: store.table("saved_groups"),
  usersTable: store.table("users"),
  tripsTable: store.table("trips"),
  tripParticipantsTable: store.table("trip_participants"),
}));

import {
  ContextValidationError,
  addCompanion,
  addRule,
  confirmLearnedHome,
  createSavedGroup,
  deactivateRule,
  getSavedGroupWithMembers,
  listRules,
  loadContextDigest,
  rankDestinationSuggestions,
  setHomeAirports,
  setHomeBase,
} from "./travelerContext.js";
import { RuleValidationError } from "./rulesEngine.js";

function queue(table: string, rows: unknown[]): void {
  (store.selectQueues[table] ??= []).push(rows);
}

function inserts(table: string): Array<Record<string, unknown>> {
  return store.ops
    .filter((o) => o.op === "insert" && o.table === table)
    .map((o) => o.values as Record<string, unknown>);
}

function updates(table: string): Array<Record<string, unknown>> {
  return store.ops
    .filter((o) => o.op === "update" && o.table === table)
    .map((o) => o.set as Record<string, unknown>);
}

function contextRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: 42,
    homeBase: null,
    homeBaseLat: null,
    homeBaseLon: null,
    homeBaseSource: null,
    homeBaseConfirmed: false,
    homeAirports: [],
    homeAirportsSource: null,
    homeAirportsConfirmed: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
});

// ─── Home base & airports (Story 6.1) ────────────────────────────────────────

describe("home base & airports", () => {
  it("an explicit home base is born confirmed", async () => {
    queue("traveler_context", []); // upsert: load — none yet
    queue("traveler_context", []); // upsertContextRow: load again — none
    store.insertReturns["traveler_context"] = [
      contextRow({ homeBase: "Lawrenceville, NJ", homeBaseSource: "explicit", homeBaseConfirmed: true }),
    ];
    const row = await setHomeBase(42, { text: "Lawrenceville, NJ", source: "explicit" });
    expect(row.homeBaseConfirmed).toBe(true);
    expect(inserts("traveler_context")[0]).toMatchObject({
      homeBase: "Lawrenceville, NJ",
      homeBaseSource: "explicit",
      homeBaseConfirmed: true,
    });
  });

  it("a LEARNED home base lands unconfirmed — a proposal, not a default", async () => {
    queue("traveler_context", []);
    queue("traveler_context", []);
    store.insertReturns["traveler_context"] = [
      contextRow({ homeBase: "Austin, TX", homeBaseSource: "learned", homeBaseConfirmed: false }),
    ];
    const row = await setHomeBase(42, { text: "Austin, TX", source: "learned" });
    expect(row.homeBaseConfirmed).toBe(false);
    expect(inserts("traveler_context")[0]).toMatchObject({
      homeBaseSource: "learned",
      homeBaseConfirmed: false,
    });
  });

  it("a learned proposal NEVER overwrites a confirmed home base", async () => {
    const confirmed = contextRow({
      homeBase: "Lawrenceville, NJ",
      homeBaseSource: "explicit",
      homeBaseConfirmed: true,
    });
    queue("traveler_context", [confirmed]); // setHomeBase's guard load
    const row = await setHomeBase(42, { text: "Austin, TX", source: "learned" });
    expect(row.homeBase).toBe("Lawrenceville, NJ");
    expect(store.ops.filter((o) => o.op !== "select")).toHaveLength(0); // no write at all
  });

  it("home airports normalize (uppercase, dedupe, order kept); bad codes are rejected", async () => {
    queue("traveler_context", []);
    queue("traveler_context", []);
    store.insertReturns["traveler_context"] = [
      contextRow({ homeAirports: ["EWR", "PHL"], homeAirportsSource: "explicit", homeAirportsConfirmed: true }),
    ];
    const row = await setHomeAirports(42, ["ewr", "PHL", "EWR"], "explicit");
    expect(row.homeAirports).toEqual(["EWR", "PHL"]);
    await expect(setHomeAirports(42, ["Newark"], "explicit")).rejects.toBeInstanceOf(
      ContextValidationError,
    );
  });

  it("confirmLearnedHome flips pending proposals to confirmed", async () => {
    const pending = contextRow({
      homeBase: "Austin, TX",
      homeBaseSource: "learned",
      homeBaseConfirmed: false,
      homeAirports: ["AUS"],
      homeAirportsSource: "learned",
      homeAirportsConfirmed: false,
    });
    queue("traveler_context", [pending]); // confirm load
    queue("traveler_context", [pending]); // upsert load
    store.updateReturns["traveler_context"] = [
      { ...pending, homeBaseConfirmed: true, homeAirportsConfirmed: true },
    ];
    const row = await confirmLearnedHome(42);
    expect(row?.homeBaseConfirmed).toBe(true);
    expect(row?.homeAirportsConfirmed).toBe(true);
    expect(updates("traveler_context")[0]).toMatchObject({
      homeBaseConfirmed: true,
      homeAirportsConfirmed: true,
    });
  });
});

// ─── Rules (Story 6.4) ───────────────────────────────────────────────────────

describe("rules", () => {
  it("addRule validates params through the engine before writing", async () => {
    store.insertReturns["traveler_rules"] = [
      { id: 5, userId: 42, ruleClass: "hard", ruleType: "fare_class_ban", params: { banned: ["Basic Economy"] }, scope: "all", source: "explicit", active: true },
    ];
    const row = await addRule(42, {
      ruleClass: "hard",
      ruleType: "fare_class_ban",
      params: { banned: ["Basic Economy"] },
    });
    expect(row.id).toBe(5);
    expect(inserts("traveler_rules")[0]).toMatchObject({
      ruleClass: "hard",
      ruleType: "fare_class_ban",
      scope: "all",
      active: true,
    });
    await expect(
      addRule(42, { ruleClass: "hard", ruleType: "fare_class_ban", params: { banned: [] } }),
    ).rejects.toBeInstanceOf(RuleValidationError);
    await expect(
      addRule(42, {
        ruleClass: "hard",
        ruleType: "booking_channel_required",
        params: { channel: "Egencia" },
        scope: "sometimes" as never,
      }),
    ).rejects.toBeInstanceOf(ContextValidationError);
    expect(inserts("traveler_rules")).toHaveLength(1); // only the valid write landed
  });

  it("listRules returns active rules by default and all rules on request", async () => {
    const rows = [
      { id: 1, userId: 42, active: true },
      { id: 2, userId: 42, active: false },
    ];
    queue("traveler_rules", rows);
    expect((await listRules(42)).map((r) => r.id)).toEqual([1]);
    queue("traveler_rules", rows);
    expect((await listRules(42, { activeOnly: false })).map((r) => r.id)).toEqual([1, 2]);
  });

  it("deactivateRule is owner-scoped: another traveler's rule is untouchable", async () => {
    queue("traveler_rules", []); // lookup by (id, userId) finds nothing
    await expect(deactivateRule(42, 99)).resolves.toBe(false);
    expect(updates("traveler_rules")).toHaveLength(0);

    queue("traveler_rules", [{ id: 5, userId: 42, active: true }]);
    await expect(deactivateRule(42, 5)).resolves.toBe(true);
    expect(updates("traveler_rules")[0]).toMatchObject({ active: false });
  });
});

// ─── Companions & groups (Story 6.3) ─────────────────────────────────────────

const kurt = { id: 1, userId: 42, name: "Kurt", email: "kurt@example.com", linkedUserId: null, createdAt: new Date(), updatedAt: new Date() };
const pradip = { id: 2, userId: 42, name: "Pradip", email: "pradip@example.com", linkedUserId: 56, createdAt: new Date(), updatedAt: new Date() };

describe("companions & saved groups", () => {
  it("addCompanion links by user id when the email is a Wander account — and stores nothing else of theirs", async () => {
    queue("users", [{ id: 56 }]); // email lookup finds the account
    store.insertReturns["traveler_companions"] = [pradip];
    const row = await addCompanion(42, { name: "Pradip", email: "Pradip@Example.com" });
    expect(row.linkedUserId).toBe(56);
    // The insert carries ONLY what the organizer provided + the link id.
    expect(inserts("traveler_companions")[0]).toEqual({
      userId: 42,
      name: "Pradip",
      email: "pradip@example.com",
      linkedUserId: 56,
    });
  });

  it("createSavedGroup rejects members that are not the organizer's companions", async () => {
    queue("traveler_companions", [kurt]); // only 1 of the 2 ids is theirs
    await expect(
      createSavedGroup(42, { name: "Munich guys", companionIds: [1, 2] }),
    ).rejects.toBeInstanceOf(ContextValidationError);
    expect(inserts("saved_groups")).toHaveLength(0);
  });

  it("createSavedGroup resolves members; getSavedGroupWithMembers is owner-scoped", async () => {
    queue("traveler_companions", [kurt, pradip]); // ownership check
    store.insertReturns["saved_groups"] = [
      { id: 7, userId: 42, name: "Munich guys", memberCompanionIds: [1, 2], createdAt: new Date(), updatedAt: new Date() },
    ];
    const view = await createSavedGroup(42, { name: "Munich guys", companionIds: [1, 2] });
    expect(view.members.map((m) => m.name)).toEqual(["Kurt", "Pradip"]);

    queue("saved_groups", []); // not theirs / not found
    await expect(getSavedGroupWithMembers(42, 999)).resolves.toBeNull();

    queue("saved_groups", [
      { id: 7, userId: 42, name: "Munich guys", memberCompanionIds: [2, 1], createdAt: new Date(), updatedAt: new Date() },
    ]);
    queue("traveler_companions", [kurt, pradip]);
    const found = await getSavedGroupWithMembers(42, 7);
    expect(found?.members.map((m) => m.name)).toEqual(["Pradip", "Kurt"]); // group order wins
  });
});

// ─── Destination suggestions + digest ────────────────────────────────────────

describe("rankDestinationSuggestions", () => {
  it("ranks by visit count, then recency, capped at 3", () => {
    const suggestions = rankDestinationSuggestions([
      { destination: "Munich", startDate: "2025-09-24" },
      { destination: "Austin", startDate: "2026-10-24" },
      { destination: "Munich", startDate: "2026-09-24" },
      { destination: "Denver", startDate: "2026-06-01" },
      { destination: "Miami", startDate: "2026-08-01" },
    ]);
    expect(suggestions.map((s) => s.text)).toEqual(["Munich", "Austin", "Miami"]);
    expect(suggestions[0].reason).toContain("2 times");
  });
});

describe("loadContextDigest", () => {
  it("separates confirmed knowledge from learned proposals and splits rules by class", async () => {
    queue("traveler_context", [
      contextRow({
        homeBase: "Lawrenceville, NJ",
        homeBaseSource: "explicit",
        homeBaseConfirmed: true,
        homeAirports: ["EWR"],
        homeAirportsSource: "learned",
        homeAirportsConfirmed: false,
      }),
    ]);
    queue("traveler_rules", [
      { id: 1, userId: 42, ruleClass: "hard", ruleType: "fare_class_ban", params: { banned: ["Basic Economy"] }, scope: "all", source: "explicit", active: true },
      { id: 2, userId: 42, ruleClass: "preference", ruleType: "stay_style", params: { style: "boutique" }, scope: "all", source: "explicit", active: true },
      { id: 3, userId: 42, ruleClass: "hard", ruleType: "changeability_required", params: {}, scope: "all", source: "explicit", active: false },
    ]);
    queue("traveler_companions", [kurt, pradip]); // digest companions
    queue("saved_groups", [
      { id: 7, userId: 42, name: "Munich guys", memberCompanionIds: [1, 2], createdAt: new Date(), updatedAt: new Date() },
    ]);
    queue("traveler_companions", [kurt, pradip]); // group member resolution
    queue("trips", [{ destination: "Munich", startDate: "2026-09-24" }]);

    const digest = await loadContextDigest(42);
    expect(digest.homeBase?.text).toBe("Lawrenceville, NJ");
    expect(digest.homeAirports).toEqual([]); // learned airports are NOT the default yet
    expect(digest.proposedHomeAirports).toEqual(["EWR"]);
    expect(digest.proposedHomeBase).toBeNull();
    expect(digest.hardRules.map((r) => r.ruleType)).toEqual(["fare_class_ban"]); // inactive excluded
    expect(digest.preferences.map((r) => r.ruleType)).toEqual(["stay_style"]);
    expect(digest.groups[0].members.map((m) => m.name)).toEqual(["Kurt", "Pradip"]);
    expect(digest.destinationSuggestions[0].text).toBe("Munich");
  });

  it("an unknown traveler digests to empty — new travelers are asked everything", async () => {
    queue("traveler_context", []);
    queue("traveler_rules", []);
    queue("traveler_companions", []);
    queue("saved_groups", []);
    queue("traveler_companions", []);
    queue("trips", []);
    const digest = await loadContextDigest(99);
    expect(digest.homeBase).toBeNull();
    expect(digest.hardRules).toEqual([]);
    expect(digest.groups).toEqual([]);
    expect(digest.destinationSuggestions).toEqual([]);
  });
});
