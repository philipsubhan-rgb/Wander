/**
 * Intake list — service tests for listResumableIntakeSessions
 * (design Decision 2: the dashboard's "Continue planning" cards).
 *
 * Same recording @workspace/db mock pattern as intake.test.ts, extended
 * to capture the select's where clause so owner scoping is asserted at
 * the query the service actually builds: the filter must carry the
 * caller's id on the session owner column — there is no code path that
 * could return another traveler's sessions.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => {
  const table = (name: string) => ({
    __table: name,
    userId: `${name}.user_id`,
    updatedAt: `${name}.updated_at`,
  });
  const selectQueues: Record<string, unknown[][]> = {};
  const whereCalls: unknown[] = [];

  function makeSelectChain(): Record<string, unknown> {
    const ctx = { table: "" };
    const resolve = (): Promise<unknown> =>
      Promise.resolve(selectQueues[ctx.table ?? ""]?.shift() ?? []);
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolve().then(res, rej),
      catch: (rej: (e: unknown) => unknown) => resolve().catch(rej),
      finally: (fin: () => void) => resolve().finally(fin),
    };
    chain.from = (t: { __table: string }) => {
      ctx.table = t.__table;
      return chain;
    };
    chain.where = (arg: unknown) => {
      whereCalls.push(arg);
      return chain;
    };
    for (const m of ["orderBy", "limit", "returning", "values", "set"]) {
      chain[m] = () => chain;
    }
    return chain;
  }

  const chainFor = () => makeSelectChain();
  const db = {
    select: vi.fn(() => chainFor()),
    insert: vi.fn(() => chainFor()),
    update: vi.fn(() => chainFor()),
    delete: vi.fn(() => chainFor()),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { table, selectQueues, whereCalls, db };
});

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  desc: (...args: unknown[]) => args,
  notInArray: (...args: unknown[]) => args,
  sql: (...args: unknown[]) => args,
}));

vi.mock("@workspace/db", () => ({
  db: store.db,
  intakeSessionsTable: store.table("intake_sessions"),
  marcoMessagesTable: store.table("marco_messages"),
  tripParticipantsTable: store.table("trip_participants"),
  tripRosterEntriesTable: store.table("trip_roster_entries"),
  tripsTable: store.table("trips"),
  usersTable: store.table("users"),
  savedGroupsTable: store.table("saved_groups"),
  travelerCompanionsTable: store.table("traveler_companions"),
}));

import { listResumableIntakeSessions } from "./intake.js";

function sessionRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5,
    userId: 42,
    state: "OPENING",
    slots: { intentCaptured: false },
    openItems: [],
    draftTripId: null,
    channel: "text",
    questionsAsked: 0,
    createdAt: new Date("2026-11-20T10:00:00Z"),
    updatedAt: new Date("2026-11-20T10:00:00Z"),
    ...overrides,
  };
}

const startedSlots = {
  intentCaptured: true,
  destination: { value: { kind: "place", text: "Munich" }, provenance: "stated" },
};

beforeEach(() => {
  store.whereCalls.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
});

describe("listResumableIntakeSessions", () => {
  it("returns only started, un-materialized sessions, newest first as queried", async () => {
    store.selectQueues["intake_sessions"] = [
      [
        sessionRow({
          id: 9,
          slots: startedSlots,
          updatedAt: new Date("2026-11-22T09:30:00Z"),
        }),
        // Untouched (page mount created it, nobody spoke): not a draft.
        sessionRow({ id: 8 }),
        // Already became a trip: lives on the dashboard as a trip now.
        sessionRow({ id: 7, slots: startedSlots, draftTripId: 123 }),
        sessionRow({
          id: 6,
          slots: {
            intentCaptured: true,
            destination: { value: { kind: "region", text: "the Alps" }, provenance: "stated" },
            party: { value: { solo: true, travelers: [] }, provenance: "asked" },
          },
          updatedAt: new Date("2026-11-21T18:00:00Z"),
        }),
      ],
    ];

    const items = await listResumableIntakeSessions(42);

    expect(items.map((i) => i.id)).toEqual([9, 6]);
    // Card data rides along: destination-so-far, machine state, next ask.
    expect(items[0].slots.destination?.value.text).toBe("Munich");
    expect(items[0].state).toBe("PARTY");
    expect(items[0].nextAsk?.question).toContain("Who's going?");
    expect(items[0].updatedAt).toBe("2026-11-22T09:30:00.000Z");
    expect(items[1].state).toBe("DATES");
  });

  it("scopes the query to the caller's own sessions (owner isolation)", async () => {
    store.selectQueues["intake_sessions"] = [[]];

    await listResumableIntakeSessions(42);

    // Exactly one where clause, built as eq(owner column, caller id).
    expect(store.whereCalls).toEqual([["intake_sessions.user_id", 42]]);
  });

  it("returns an empty list when the caller has no sessions", async () => {
    store.selectQueues["intake_sessions"] = [[]];
    await expect(listResumableIntakeSessions(42)).resolves.toEqual([]);
  });
});
