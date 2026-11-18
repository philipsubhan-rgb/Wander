/**
 * Intake Service — DB-level tests with a recording @workspace/db mock.
 *
 * The mock uses distinct sentinel objects per table and records every
 * insert/update (table, values/set), so materialization can be asserted
 * precisely: trip row, organizer participant, roster entries, the ADR-3
 * message re-key, and the session's MATERIALIZED transition — all in one
 * transaction, and nothing else.
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
  // Context-layer tables: applyIntakePartyFromGroup resolves saved
  // groups through the Context/Profile service.
  savedGroupsTable: store.table("saved_groups"),
  travelerCompanionsTable: store.table("traveler_companions"),
}));

import {
  createIntakeSession,
  applyIntakeSlotWrite,
  applyIntakePartyFromGroup,
  materializeIntake,
  recordIntakeTurnAsk,
  IntakeAccessDenied,
  IntakeGroupNotFound,
  IntakeMaterializationError,
} from "./intake.js";

const CTX = { userId: 42, role: "traveler" };

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
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fullSessionRow(): Record<string, unknown> {
  return sessionRow({
    state: "REVIEW",
    slots: {
      intentCaptured: true,
      destination: { value: { kind: "place", text: "Munich" }, provenance: "stated" },
      party: {
        value: {
          solo: false,
          travelers: [
            { name: "Kurt", email: "kurt@example.com" },
            { name: "Pradip", email: "pradip@example.com" },
          ],
        },
        provenance: "asked",
      },
      dates: { value: { startDate: "2026-09-24", endDate: "2026-09-28" }, provenance: "asked" },
      style: { value: { text: "guys' trip" }, provenance: "asked" },
    },
  });
}

beforeEach(() => {
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
});

describe("createIntakeSession", () => {
  it("inserts an OPENING session and returns the opening ask", async () => {
    store.insertReturns["intake_sessions"] = [sessionRow()];
    const view = await createIntakeSession(42);
    expect(view.state).toBe("OPENING");
    expect(view.nextAsk?.question).toBe("Ok, where are we going?");
    const insert = store.ops.find((o) => o.op === "insert" && o.table === "intake_sessions");
    expect(insert?.values).toMatchObject({ userId: 42, state: "OPENING", channel: "text" });
  });
});

describe("applyIntakeSlotWrite", () => {
  it("persists the write and the recomputed state", async () => {
    store.selectQueues["intake_sessions"] = [[sessionRow({ slots: { intentCaptured: true }, state: "DESTINATION" })]];
    const view = await applyIntakeSlotWrite(5, CTX.userId, CTX.role, {
      slot: "destination",
      value: { kind: "place", text: "Munich" },
      provenance: "stated",
    });
    expect(view.state).toBe("PARTY");
    expect(view.slots.destination?.provenance).toBe("stated");
    const update = store.ops.find((o) => o.op === "update" && o.table === "intake_sessions");
    expect(update?.set).toMatchObject({ state: "PARTY" });
  });

  it("denies a non-owner", async () => {
    store.selectQueues["intake_sessions"] = [[sessionRow({ userId: 99 })]];
    await expect(
      applyIntakeSlotWrite(5, CTX.userId, CTX.role, {
        slot: "destination",
        value: { kind: "place", text: "Munich" },
        provenance: "asked",
      }),
    ).rejects.toBeInstanceOf(IntakeAccessDenied);
    expect(store.ops.filter((o) => o.op === "update")).toHaveLength(0);
  });
});

describe("materializeIntake", () => {
  it("creates trip + organizer participant + roster, re-keys messages, marks MATERIALIZED", async () => {
    store.selectQueues["intake_sessions"] = [[fullSessionRow()]];
    store.insertReturns["trips"] = [{ id: 77 }];
    const { tripId } = await materializeIntake(5, CTX.userId, CTX.role);
    expect(tripId).toBe(77);

    const tripInsert = store.ops.find((o) => o.op === "insert" && o.table === "trips");
    expect(tripInsert?.values).toMatchObject({
      title: "Munich — guys' trip",
      destination: "Munich",
      startDate: "2026-09-24",
      endDate: "2026-09-28",
      status: "planning",
    });
    const participantInsert = store.ops.find((o) => o.op === "insert" && o.table === "trip_participants");
    expect(participantInsert?.values).toMatchObject({ tripId: 77, userId: 42, isTripAdmin: true });
    const rosterInsert = store.ops.find((o) => o.op === "insert" && o.table === "trip_roster_entries");
    expect(rosterInsert?.values).toEqual([
      { tripId: 77, invitedName: "Kurt", invitedEmail: "kurt@example.com", status: "invited" },
      { tripId: 77, invitedName: "Pradip", invitedEmail: "pradip@example.com", status: "invited" },
    ]);
    const rekey = store.ops.find((o) => o.op === "update" && o.table === "marco_messages");
    expect(rekey?.set).toMatchObject({ tripId: 77, intakeSessionId: null });
    const sessionUpdate = store.ops.find((o) => o.op === "update" && o.table === "intake_sessions");
    expect(sessionUpdate?.set).toMatchObject({ draftTripId: 77, state: "MATERIALIZED" });
  });

  it("is idempotent — a second confirm returns the same trip with no new writes", async () => {
    store.selectQueues["intake_sessions"] = [[fullSessionRow()]];
    store.selectQueues["intake_sessions"].push([sessionRow({ draftTripId: 77, state: "MATERIALIZED" })]);
    // First call's post-transaction loadIntakeSession consumes one select;
    // emulate by queuing the materialized row for it as well.
    store.selectQueues["intake_sessions"].push([sessionRow({ draftTripId: 77, state: "MATERIALIZED" })]);
    store.insertReturns["trips"] = [{ id: 77 }];
    const first = await materializeIntake(5, CTX.userId, CTX.role);
    expect(first.tripId).toBe(77);
    const opsAfterFirst = store.ops.length;
    const second = await materializeIntake(5, CTX.userId, CTX.role);
    expect(second.tripId).toBe(77);
    expect(store.ops.length).toBe(opsAfterFirst);
  });

  it("refuses to materialize without exact dates and writes nothing", async () => {
    const row = fullSessionRow();
    (row.slots as Record<string, unknown>).dates = {
      value: { windowText: "late September" },
      provenance: "asked",
    };
    store.selectQueues["intake_sessions"] = [[row]];
    await expect(materializeIntake(5, CTX.userId, CTX.role)).rejects.toBeInstanceOf(
      IntakeMaterializationError,
    );
    expect(store.ops.filter((o) => o.op === "insert")).toHaveLength(0);
  });
});

describe("recordIntakeTurnAsk (§4.4 asks-less accounting)", () => {
  it("counts a question when the machine is left in a question state", async () => {
    store.selectQueues["intake_sessions"] = [
      [sessionRow({ state: "PARTY", slots: { intentCaptured: true }, questionsAsked: 2 })],
    ];
    await recordIntakeTurnAsk(5);
    const update = store.ops.find((o) => o.op === "update" && o.table === "intake_sessions");
    expect(update?.set).toMatchObject({ questionsAsked: 3 });
  });

  it("counts nothing at REVIEW", async () => {
    store.selectQueues["intake_sessions"] = [[fullSessionRow()]];
    await recordIntakeTurnAsk(5);
    expect(store.ops.filter((o) => o.op === "update")).toHaveLength(0);
  });
});

describe("applyIntakePartyFromGroup — saved-group prefill (§3.4)", () => {
  const kurt = { id: 1, userId: 42, name: "Kurt", email: "kurt@example.com", linkedUserId: null, createdAt: new Date(), updatedAt: new Date() };
  const pradip = { id: 2, userId: 42, name: "Pradip", email: "pradip@example.com", linkedUserId: null, createdAt: new Date(), updatedAt: new Date() };
  const groupRow = {
    id: 7, userId: 42, name: "Munich guys", memberCompanionIds: [1, 2],
    createdAt: new Date(), updatedAt: new Date(),
  };
  const sessionAtParty = sessionRow({
    state: "PARTY",
    slots: {
      intentCaptured: true,
      destination: { value: { kind: "place", text: "Munich" }, provenance: "stated" },
    },
  });

  it("fills the party slot from the group with provenance from_context — no ask needed", async () => {
    store.selectQueues["intake_sessions"] = [[sessionAtParty]];
    store.selectQueues["saved_groups"] = [[groupRow]];
    store.selectQueues["traveler_companions"] = [[kurt, pradip]];
    const view = await applyIntakePartyFromGroup(5, CTX.userId, CTX.role, 7);
    expect(view.state).toBe("DATES"); // party settled without a question
    const update = store.ops.find((o) => o.op === "update" && o.table === "intake_sessions");
    const slots = (update?.set as { slots: Record<string, unknown> }).slots;
    expect(slots.party).toMatchObject({
      provenance: "from_context",
      value: {
        solo: false,
        travelers: [
          { name: "Kurt", email: "kurt@example.com" },
          { name: "Pradip", email: "pradip@example.com" },
        ],
      },
    });
    // And the ask accounting never moved: the slot was never asked.
    expect(view.questionsAsked).toBe(0);
  });

  it("a group that isn't the traveler's surfaces as not-found, not someone else's party", async () => {
    store.selectQueues["intake_sessions"] = [[sessionAtParty]];
    store.selectQueues["saved_groups"] = [[]]; // owner-scoped lookup misses
    await expect(applyIntakePartyFromGroup(5, CTX.userId, CTX.role, 999)).rejects.toBeInstanceOf(
      IntakeGroupNotFound,
    );
    expect(store.ops.filter((o) => o.op === "update")).toHaveLength(0);
  });

  it("a non-owner is denied before any group is loaded", async () => {
    store.selectQueues["intake_sessions"] = [[sessionRow({ userId: 99 })]];
    await expect(applyIntakePartyFromGroup(5, CTX.userId, CTX.role, 7)).rejects.toBeInstanceOf(
      IntakeAccessDenied,
    );
    expect(store.selectQueues["saved_groups"] ?? []).toHaveLength(0);
  });

  it("a materialized session refuses the fill", async () => {
    store.selectQueues["intake_sessions"] = [[sessionRow({ draftTripId: 12 })]];
    await expect(applyIntakePartyFromGroup(5, CTX.userId, CTX.role, 7)).rejects.toThrow(
      "already produced a trip",
    );
  });
});
