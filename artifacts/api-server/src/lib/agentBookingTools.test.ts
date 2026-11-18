/**
 * Marco booking tools (`booking_*`) — tool-level tests over a real
 * BookingGate + real OptionsService wired to a recording @workspace/db
 * mock and injected provider fakes.
 *
 * Tool-level invariants (the service-level ones live in
 * bookingGate.test.ts):
 *  - the tool inventory is exactly present / review / confirm / execute;
 *  - NO tool accepts passenger details — the parameter schemas carry
 *    ids and enums only, because passenger data comes from the vault;
 *  - execute from an unconfirmed state fails at the TOOL level too,
 *    with the state named and nothing booked;
 *  - the full conversational flow works: present (re-verified review
 *    surface) → confirm → execute → booked with a confirmation code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import type { Booking, BookingAttempt, BookingAttemptTraveler } from "@workspace/db";
import type { ToolContext } from "./agentTools";
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
  fxRateSnapshotsTable: store.table("fx_rate_snapshots"),
}));

vi.mock("./email.js", () => ({
  sendEmail: vi.fn(async () => ({ sent: true })),
}));

import { BOOKING_TOOLS } from "./agentBookingTools";
import { BookingGate, setDefaultBookingGateForTests, type RequoteInfo } from "./bookingGate";
import { OptionCache, type OptionsAdapter } from "./options";
import { OptionsService, setDefaultOptionsServiceForTests } from "./optionsService";
import type { DuffelOrder } from "./duffel";

const CTX: ToolContext = { userId: 7, role: "user" };

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
  };
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
    state: "presented",
    visibility: "shared",
    category: null,
    presentedAmountMinor: 61200,
    presentedCurrency: "USD",
    reviewedAmountMinor: null,
    reviewedCurrency: null,
    reviewVersion: 0,
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

function bookingRow(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 99,
    attemptId: 42,
    tripId: 3,
    kind: "flight",
    supplier: "United",
    confirmationCode: null,
    status: "pending",
    source: "api_rail",
    chargeAmountMinor: 61200,
    chargeCurrency: "USD",
    amountActuallyChargedMinor: null,
    homeEquivalentMinor: null,
    homeCurrency: null,
    fxSnapshotId: null,
    merchantOfRecord: "duffel",
    changeTerms: null,
    cancelTerms: null,
    whyThisOption: "best_price",
    whyThisOptionText: null,
    rankingInputsHash: "hash",
    visibility: "shared",
    railProvider: null,
    railOrderFeeMinor: null,
    railPctFeeMinor: null,
    railFeeCurrency: null,
    processingFeeMinor: null,
    costAttribution: {},
    providerOrderId: null,
    flightId: null,
    accommodationId: null,
    reservationId: null,
    carRentalId: null,
    projection: {},
    flightawareIdent: null,
    alertRegistrationId: null,
    createdAt: new Date("2026-11-18T09:00:00Z"),
    updatedAt: new Date("2026-11-18T09:00:00Z"),
    ...overrides,
  } as Booking;
}

const ORDER: DuffelOrder = {
  id: "ord_1",
  booking_reference: "XYZ123",
  total_amount: "612.00",
  total_currency: "USD",
  owner: { name: "United Airlines", iata_code: "UA" },
  slices: [
    {
      origin: { iata_code: "EWR" },
      destination: { iata_code: "MUC" },
      segments: [
        {
          origin: { iata_code: "EWR", time_zone: "America/New_York" },
          destination: { iata_code: "MUC", time_zone: "Europe/Berlin" },
          departing_at: "2026-09-23T17:00:00-04:00",
          arriving_at: "2026-09-24T07:10:00+02:00",
          marketing_carrier: { name: "United Airlines", iata_code: "UA" },
          marketing_carrier_flight_number: "30",
        },
      ],
    },
  ],
};

const createOrder = vi.fn(async () => ({ status: 201, order: ORDER }));

function queueParticipant() {
  store.selectQueues["trip_participants"] = [
    ...(store.selectQueues["trip_participants"] ?? []),
    [{ tripId: 3, userId: 7, isTripAdmin: true }],
  ];
}

async function setupWorld() {
  const adapter: OptionsAdapter = {
    id: "duffel",
    enabled: true,
    disabledReason: "",
    searchFlights: async () => [flightOption()],
  };
  const service = new OptionsService({
    adapters: [adapter],
    cache: new OptionCache(),
    loadRules: async () => [],
    loadHomeCurrency: async () => "USD",
    fxResolver: async () => null,
  });
  await service.searchFlights(7, {
    origin: "EWR",
    destination: "MUC",
    departureDate: "2026-09-23",
    passengerCount: 1,
  });
  setDefaultOptionsServiceForTests(service);

  const gate = new BookingGate({
    ordersClient: {
      getOffer: vi.fn(async (): Promise<never> => {
        throw new Error("requote is injected");
      }),
      createOrder,
    },
    requote: vi.fn(
      async (): Promise<RequoteInfo> => ({
        outcome: "same",
        option: flightOption(),
        offerPassengerIds: ["pas_1"],
      }),
    ),
    readProfile: vi.fn(async () => ({
      legal_first_name: "Philip",
      legal_last_name: "Subhan",
      date_of_birth: "1958-10-01",
      phone: "+16095550100",
    })) as never,
    registerWatch: vi.fn(async () => ({ created: true, watch: { ident: "UAL30", alertId: "alert_1" } })),
    loadRules: async () => [],
  });
  setDefaultBookingGateForTests(gate);
}

function tool(name: string) {
  const def = BOOKING_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`missing tool ${name}`);
  return def;
}

beforeEach(async () => {
  // Clear by MUTATION: the mock's chains close over these exact objects.
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
  createOrder.mockClear();
  await setupWorld();
});

afterEach(() => {
  setDefaultBookingGateForTests(null);
  setDefaultOptionsServiceForTests(null);
});

describe("tool inventory + argument discipline", () => {
  it("exposes exactly present / review / confirm / execute", () => {
    expect(BOOKING_TOOLS.map((t) => t.name).sort()).toEqual([
      "booking_confirm",
      "booking_execute",
      "booking_present_option",
      "booking_review",
    ]);
  });

  it("no tool accepts passenger details — schemas carry ids and enums only", () => {
    for (const t of BOOKING_TOOLS) {
      const zodKeys = t.input instanceof z.ZodObject ? Object.keys(t.input.shape) : [];
      const surface = JSON.stringify(t.parameters) + JSON.stringify(zodKeys);
      expect(surface).not.toMatch(/passport|given_name|family_name|born_on|date_of_birth|legal_|first_name|last_name/i);
    }
  });
});

describe("the conversational flow", () => {
  it("present → confirm → execute books exactly once, with the review surface shown first", async () => {
    // PRESENT: createAttempt (participant + attempt insert), beginReview
    // (load + participant), getAttemptView (load + participant + coverage).
    queueParticipant();
    store.insertReturns["booking_attempts"] = [attemptRow()];
    store.selectQueues["booking_attempts"] = [
      [attemptRow()],
      [attemptRow({ state: "review", reviewedAmountMinor: 61200, reviewedCurrency: "USD" })],
    ];
    queueParticipant();
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow()]];

    const presented = await tool("booking_present_option").run(CTX, { tripId: 3, optionId: "off_123" } as never);
    expect(presented.ok).toBe(true);
    expect(presented.text).toContain("Total to be charged: $612.00");
    expect(presented.text).toContain("Nothing is booked yet");
    expect(presented.text).toContain("cheapest option that fit your rules");

    // CONFIRM: load + participant + coverage.
    store.selectQueues["booking_attempts"] = [
      [attemptRow({ state: "review", reviewedAmountMinor: 61200, reviewedCurrency: "USD" })],
    ];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow()]];
    const confirmed = await tool("booking_confirm").run(CTX, { attemptId: 42 } as never);
    expect(confirmed.ok).toBe(true);
    expect(confirmed.text).toContain("Confirmed");

    // EXECUTE: load + participant + coverage; booking + flight inserts.
    store.selectQueues["booking_attempts"] = [
      [attemptRow({ state: "confirmed", reviewedAmountMinor: 61200, reviewedCurrency: "USD", confirmedByUserId: 7, confirmedAt: new Date() })],
    ];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow({ confirmedAt: new Date() })]];
    store.insertReturns["bookings"] = [bookingRow()];
    store.insertReturns["flights"] = [{ id: 55, tripId: 3, flightNumber: "UA30" }];
    store.updateReturns["bookings"] = [
      bookingRow({ status: "confirmed", confirmationCode: "XYZ123", providerOrderId: "ord_1", flightId: 55 }),
    ];
    const executed = await tool("booking_execute").run(CTX, { attemptId: 42 } as never);
    expect(executed.ok).toBe(true);
    expect(executed.text).toContain("Booked!");
    expect(executed.text).toContain("XYZ123");
    expect(createOrder).toHaveBeenCalledTimes(1);
  });

  it("execute on an attempt still in REVIEW fails at the tool level — state named, nothing booked", async () => {
    store.selectQueues["booking_attempts"] = [
      [attemptRow({ state: "review", reviewedAmountMinor: 61200, reviewedCurrency: "USD" })],
    ];
    queueParticipant();
    const result = await tool("booking_execute").run(CTX, { attemptId: 42 } as never);
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/current state \(review\)/);
    expect(result.text).toMatch(/Nothing was booked/);
    expect(createOrder).not.toHaveBeenCalled();
    expect(store.ops.filter((o) => o.table === "bookings")).toHaveLength(0);
  });

  it("presenting an option that fell out of the search results asks for a fresh search", async () => {
    const result = await tool("booking_present_option").run(CTX, { tripId: 3, optionId: "off_gone" } as never);
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/search again/);
    expect(store.ops.filter((o) => o.table === "booking_attempts")).toHaveLength(0);
  });
});
