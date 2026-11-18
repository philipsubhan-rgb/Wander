/**
 * Voice proposes, screen confirms — the gate-level guard (§2.4, §5.2).
 *
 * These tests drive the REAL BookingGate (recording @workspace/db
 * mock, same pattern as bookingGate.test.ts) and the REAL
 * booking_confirm / booking_execute tool definitions, with the tool
 * context carrying channel: "voice" — exactly what a voice turn puts
 * there. The invariant: a spoken "yes, book it" changes NO gate
 * state — no confirmation recorded (not even the traveler's own
 * per-traveler stamp), no transition, no provider call — and the
 * refusal copy points at the screen. The same attempt then confirms
 * through the screen (text channel), proving the block is the
 * channel, not the booking.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BookingAttempt, BookingAttemptTraveler } from "@workspace/db";
import type { FlightOption } from "./options";

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
  or: (...args: unknown[]) => args,
  desc: (...args: unknown[]) => args,
  asc: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  isNotNull: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  notInArray: (...args: unknown[]) => args,
  gt: (...args: unknown[]) => args,
  gte: (...args: unknown[]) => args,
  lt: (...args: unknown[]) => args,
  lte: (...args: unknown[]) => args,
  ne: (...args: unknown[]) => args,
  sql: (...args: unknown[]) => args,
  count: (...args: unknown[]) => args,
}));

vi.mock("@workspace/db", () => ({
  db: store.db,
  bookingAttemptsTable: store.table("booking_attempts"),
  bookingAttemptTravelersTable: store.table("booking_attempt_travelers"),
  bookingsTable: store.table("bookings"),
  bookingTravelersTable: store.table("booking_travelers"),
  bookingSplitsTable: store.table("booking_splits"),
  commissionRecordsTable: store.table("commission_records"),
  flightsTable: store.table("flights"),
  tripsTable: store.table("trips"),
  tripParticipantsTable: store.table("trip_participants"),
  usersTable: store.table("users"),
  accommodationsTable: store.table("accommodations"),
  activitiesTable: store.table("activities"),
  itineraryDaysTable: store.table("itinerary_days"),
  carRentalsTable: store.table("car_rentals"),
  reservationsTable: store.table("reservations"),
  advisoriesTable: store.table("advisories"),
  flightWatchesTable: store.table("flight_watches"),
  travelerProfilesTable: store.table("traveler_profiles"),
  profileAccessLogTable: store.table("profile_access_log"),
  tripRosterEntriesTable: store.table("trip_roster_entries"),
  travelerRulesTable: store.table("traveler_rules"),
  travelerContextTable: store.table("traveler_context"),
  travelerCompanionsTable: store.table("traveler_companions"),
  savedGroupsTable: store.table("saved_groups"),
  marcoMessagesTable: store.table("marco_messages"),
  intakeSessionsTable: store.table("intake_sessions"),
  fxRateSnapshotsTable: store.table("fx_rate_snapshots"),
}));

vi.mock("./email.js", () => ({
  sendEmail: vi.fn(async () => ({ sent: true })),
}));

import {
  BookingGate,
  setDefaultBookingGateForTests,
  type RequoteInfo,
} from "./bookingGate";
import { GateTransitionError } from "./bookingGateLogic";
import { getBookingToolDefinition } from "./agentBookingTools";
import type { ToolContext } from "./agentTools";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function flightOption(): FlightOption {
  return {
    id: "off_123",
    kind: "flight",
    adapter: "duffel",
    supplier: "United",
    money: { amountMinor: 61200, currency: "USD" },
    homeEquivalent: null,
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
  } as FlightOption;
}

function attemptRow(overrides: Partial<BookingAttempt> = {}): BookingAttempt {
  return {
    id: 42,
    tripId: 3,
    kind: "flight",
    adapter: "duffel",
    supplier: "United",
    optionId: "off_123",
    optionSnapshot: { option: flightOption() as unknown as Record<string, unknown> },
    state: "review",
    visibility: "shared",
    category: null,
    presentedAmountMinor: 61200,
    presentedCurrency: "USD",
    reviewedAmountMinor: 61200,
    reviewedCurrency: "USD",
    reviewVersion: 1,
    homeEquivalentMinor: null,
    homeCurrency: null,
    fxSnapshotId: null,
    changeTerms: "Changes are allowed by the fare rules (any fare difference still applies).",
    cancelTerms: "Non-refundable — cancelling forfeits the fare.",
    whyThisOption: "best_price",
    whyThisOptionText: "UA30 Main Cabin was the cheapest option that fit your rules.",
    rankingInputsHash: "hash",
    executionChannel: "duffel",
    confirmedByUserId: null,
    confirmedAt: null,
    failureReason: null,
    bookingId: null,
    createdAt: new Date("2026-11-18T09:00:00Z"),
    updatedAt: new Date("2026-11-18T09:00:00Z"),
    ...overrides,
  } as BookingAttempt;
}

function coverageRow(overrides: Partial<BookingAttemptTraveler> = {}): BookingAttemptTraveler {
  return {
    id: 1,
    attemptId: 42,
    userId: 7,
    rosterEntryId: null,
    isPayer: true,
    confirmedAt: null,
    createdAt: new Date("2026-11-18T09:00:00Z"),
    ...overrides,
  } as BookingAttemptTraveler;
}

const createOrder = vi.fn(async () => ({ status: 201, order: null }));

function makeGate() {
  const gate = new BookingGate({
    ordersClient: {
      getOffer: vi.fn(async (): Promise<never> => {
        throw new Error("getOffer must not be called — requote is injected");
      }),
      createOrder,
    } as never,
    requote: vi.fn(
      async (): Promise<RequoteInfo> => ({
        outcome: "same",
        option: flightOption(),
        offerPassengerIds: ["pas_1"],
      }),
    ),
    readProfile: vi.fn(async () => ({})) as never,
    registerWatch: vi.fn(async () => ({ created: true })),
    loadRules: vi.fn(async () => [] as never),
  });
  return gate;
}

function queueReviewAttempt() {
  store.selectQueues["booking_attempts"] = [[attemptRow()]];
  store.selectQueues["trip_participants"] = [[{ tripId: 3, userId: 7, isTripAdmin: true }]];
  store.selectQueues["booking_attempt_travelers"] = [[coverageRow()]];
}

beforeEach(() => {
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
  createOrder.mockClear();
  setDefaultBookingGateForTests(null);
});

// ─── The guard ───────────────────────────────────────────────────────────────

describe("voice-channel confirmation guard (real BookingGate)", () => {
  it("a voice confirmation is refused with screen-pointing copy and writes NOTHING", async () => {
    const gate = makeGate();
    queueReviewAttempt();
    const result = await gate.confirmAttempt(42, {
      userId: 7,
      role: "user",
      channel: "voice",
    });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toContain("Voice can't confirm a booking");
    expect(result.reason).toContain("on screen");
    expect(result.attempt.state).toBe("review");
    // No gate state change of any kind: zero inserts, zero updates —
    // not even the per-traveler confirmation stamp the text path records.
    expect(store.ops).toEqual([]);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("the SAME attempt confirms on the screen (text channel) — the block is the channel", async () => {
    const gate = makeGate();
    queueReviewAttempt();
    const result = await gate.confirmAttempt(42, {
      userId: 7,
      role: "user",
      channel: "text",
    });
    expect(result.confirmed).toBe(true);
    expect(result.attempt.state).toBe("confirmed");
    expect(result.attempt.confirmedByUserId).toBe(7);
  });

  it("a voice 'execute it' from REVIEW cannot leapfrog the missing confirmation", async () => {
    const gate = makeGate();
    queueReviewAttempt();
    await expect(gate.executeAttempt(42, { userId: 7, role: "user" })).rejects.toThrow(
      GateTransitionError,
    );
    expect(createOrder).not.toHaveBeenCalled();
  });
});

describe("the booking tools on a voice ToolContext", () => {
  it("booking_confirm refuses with the screen copy and books nothing", async () => {
    setDefaultBookingGateForTests(makeGate());
    queueReviewAttempt();
    const def = getBookingToolDefinition("booking_confirm")!;
    const ctx: ToolContext = { userId: 7, role: "user", channel: "voice" };
    const result = await def.run(ctx, { attemptId: 42 } as never);
    expect(result.text).toContain("Not confirmed:");
    expect(result.text).toContain("Voice can't confirm a booking");
    expect(result.text).toContain("nothing was booked or charged");
    expect(store.ops).toEqual([]);
    expect(createOrder).not.toHaveBeenCalled();
  });

  it("booking_execute from REVIEW (voice said 'yes, book it' twice) still books nothing", async () => {
    setDefaultBookingGateForTests(makeGate());
    queueReviewAttempt();
    const def = getBookingToolDefinition("booking_execute")!;
    const ctx: ToolContext = { userId: 7, role: "user", channel: "voice" };
    const result = await def.run(ctx, { attemptId: 42 } as never);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Nothing was booked");
    expect(createOrder).not.toHaveBeenCalled();
  });
});
