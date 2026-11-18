/**
 * Context tools (`context_*`) — direct tool-run tests with a recording
 * @workspace/db mock (travelerContext.test.ts pattern). Identity comes
 * from the ToolContext: no tool accepts a userId, so every write lands
 * on the CALLER's context — asserted here by the recorded inserts.
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

import { getContextToolDefinition } from "./agentContextTools.js";
import type { ToolContext } from "./agentTools.js";

const CTX: ToolContext = { userId: 42, role: "traveler" };

function queue(table: string, rows: unknown[]): void {
  (store.selectQueues[table] ??= []).push(rows);
}

function inserts(table: string): Array<Record<string, unknown>> {
  return store.ops
    .filter((o) => o.op === "insert" && o.table === table)
    .map((o) => o.values as Record<string, unknown>);
}

async function run(name: string, args: Record<string, unknown>) {
  const def = getContextToolDefinition(name);
  if (!def) throw new Error(`unknown tool ${name}`);
  const parsed = def.input.safeParse(args);
  if (!parsed.success) throw new Error(`bad args for ${name}: ${parsed.error.message}`);
  return def.run(CTX, parsed.data as never);
}

beforeEach(() => {
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
});

describe("context_* tools", () => {
  it("context_add_rule records a hard rule on the CALLER's context, in plain language", async () => {
    store.insertReturns["traveler_rules"] = [
      { id: 5, userId: 42, ruleClass: "hard", ruleType: "fare_class_ban", params: { banned: ["Basic Economy"] }, scope: "all", source: "explicit", active: true },
    ];
    const result = await run("context_add_rule", {
      ruleClass: "hard",
      ruleType: "fare_class_ban",
      params: { banned: ["Basic Economy"] },
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Never Basic Economy");
    expect(inserts("traveler_rules")[0]).toMatchObject({ userId: 42, ruleClass: "hard" });
  });

  it("context_add_rule surfaces invalid params as a tool error, not a write", async () => {
    const result = await run("context_add_rule", {
      ruleClass: "hard",
      ruleType: "fare_class_ban",
      params: { banned: [] },
    });
    expect(result.ok).toBe(false);
    expect(inserts("traveler_rules")).toHaveLength(0);
  });

  it("context_set_home_base + context_set_home_airports teach Wander where the traveler lives", async () => {
    queue("traveler_context", []);
    queue("traveler_context", []);
    store.insertReturns["traveler_context"] = [
      { userId: 42, homeBase: "Lawrenceville, NJ", homeBaseConfirmed: true, homeAirports: [] },
    ];
    const base = await run("context_set_home_base", { text: "Lawrenceville, NJ" });
    expect(base.ok).toBe(true);
    expect(base.text).toContain("Lawrenceville, NJ");

    queue("traveler_context", [{ userId: 42, homeBase: "Lawrenceville, NJ", homeAirports: [] }]);
    queue("traveler_context", [{ userId: 42, homeBase: "Lawrenceville, NJ", homeAirports: [] }]);
    store.updateReturns["traveler_context"] = [
      { userId: 42, homeBase: "Lawrenceville, NJ", homeAirports: ["EWR", "PHL"], homeAirportsConfirmed: true },
    ];
    const airports = await run("context_set_home_airports", { airports: ["EWR", "PHL"] });
    expect(airports.ok).toBe(true);
    expect(airports.text).toContain("EWR, PHL");
  });

  it("context_get renders the digest: home, rules, groups — the traveler's own data only", async () => {
    queue("traveler_context", [
      {
        userId: 42, homeBase: "Lawrenceville, NJ", homeBaseLat: null, homeBaseLon: null,
        homeBaseSource: "explicit", homeBaseConfirmed: true,
        homeAirports: ["EWR"], homeAirportsSource: "explicit", homeAirportsConfirmed: true,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    queue("traveler_rules", [
      { id: 1, userId: 42, ruleClass: "hard", ruleType: "fare_class_ban", params: { banned: ["Basic Economy"] }, scope: "all", source: "explicit", active: true },
    ]);
    const kurt = { id: 1, userId: 42, name: "Kurt", email: "kurt@example.com", linkedUserId: null, createdAt: new Date(), updatedAt: new Date() };
    queue("traveler_companions", [kurt]);
    queue("saved_groups", [
      { id: 7, userId: 42, name: "Munich guys", memberCompanionIds: [1], createdAt: new Date(), updatedAt: new Date() },
    ]);
    queue("traveler_companions", [kurt]);
    queue("trips", []);

    const result = await run("context_get", {});
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Home base: Lawrenceville, NJ");
    expect(result.text).toContain("Never Basic Economy");
    expect(result.text).toContain('"Munich guys" (group 7): Kurt');
  });

  it("context_deactivate_rule reports a rule that isn't the traveler's as an error", async () => {
    queue("traveler_rules", []); // (id, userId) lookup finds nothing
    const result = await run("context_deactivate_rule", { ruleId: 99 });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("not found");
  });

  it("context_save_group + context_list_groups round-trip a named group", async () => {
    const kurt = { id: 1, userId: 42, name: "Kurt", email: "kurt@example.com", linkedUserId: null, createdAt: new Date(), updatedAt: new Date() };
    queue("traveler_companions", [kurt]); // ownership check
    store.insertReturns["saved_groups"] = [
      { id: 7, userId: 42, name: "Munich guys", memberCompanionIds: [1], createdAt: new Date(), updatedAt: new Date() },
    ];
    const saved = await run("context_save_group", { name: "Munich guys", companionIds: [1] });
    expect(saved.ok).toBe(true);
    expect(saved.text).toContain("Munich guys");
    expect(inserts("saved_groups")[0]).toMatchObject({ userId: 42, name: "Munich guys" });
  });
});
