/**
 * Booking Lifecycle Service — change & cancel for BOOKED records
 * (E-3.4). The invariants under test:
 *  - cancel terms are fetched and presented BEFORE any cancel call:
 *    the provider call ORDER is getOrder → create quote → (only after
 *    the traveler's own confirm step) confirm — and executing from
 *    the quoted state is impossible;
 *  - the confirmation is policy-checked like the gate's (voice
 *    refused with zero writes; shared coverage refused);
 *  - an executed cancel records the refund expectation on the ledger,
 *    MARKS the legacy rows (never deletes), deregisters the watch;
 *  - a change never mutates a booked record directly: supported
 *    orders produce gate attempts carrying the change context;
 *    unsupported orders produce plain guidance and zero writes.
 *
 * DB is a recording @workspace/db mock (bookingGate.test.ts pattern);
 * the Duffel orders client is a recording fake; the gate is a stub
 * for the prepare tests (the gate's own suites cover its internals).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Booking, BookingOperation, BookingTraveler, Flight } from "@workspace/db";

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
  sql: (...args: unknown[]) => args,
  count: (...args: unknown[]) => args,
}));

vi.mock("@workspace/db", () => ({
  db: store.db,
  bookingAttemptsTable: store.table("booking_attempts"),
  bookingAttemptTravelersTable: store.table("booking_attempt_travelers"),
  bookingOperationsTable: store.table("booking_operations"),
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
  calendarEventLinksTable: store.table("calendar_event_links"),
  connectedAccountsTable: store.table("connected_accounts"),
  advisoriesTable: store.table("advisories"),
  flightWatchesTable: store.table("flight_watches"),
  travelerProfilesTable: store.table("traveler_profiles"),
  profileAccessLogTable: store.table("profile_access_log"),
  tripRosterEntriesTable: store.table("trip_roster_entries"),
  travelerRulesTable: store.table("traveler_rules"),
  travelerContextTable: store.table("traveler_context"),
  travelerCompanionsTable: store.table("traveler_companions"),
  savedGroupsTable: store.table("saved_groups"),
}));

vi.mock("./email.js", () => ({
  sendEmail: vi.fn(async () => ({ sent: true })),
}));

import { BookingLifecycle } from "./bookingLifecycle";
import type { BookingGate } from "./bookingGate";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACTOR = { userId: 7, role: "user" };
const NOW = () => new Date("2026-11-18T10:00:00Z");

function bookingRow(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 99,
    attemptId: 42,
    tripId: 3,
    kind: "flight",
    supplier: "United",
    status: "confirmed",
    source: "api_rail",
    confirmationCode: "JQZZ2H",
    providerOrderId: "ord_1",
    chargeAmountMinor: 61200,
    chargeCurrency: "USD",
    amountActuallyChargedMinor: 61200,
    homeEquivalentMinor: null,
    homeCurrency: null,
    fxSnapshotId: null,
    merchantOfRecord: "duffel",
    railProvider: "duffel",
    railOrderFeeMinor: 300,
    railPctFeeMinor: 612,
    railFeeCurrency: "USD",
    processingFeeMinor: null,
    costAttribution: {},
    changeTerms: "Changes are allowed by the fare rules (any fare difference still applies).",
    cancelTerms: "Refundable before departure under the fare rules.",
    whyThisOption: "best_price",
    whyThisOptionText: "x",
    rankingInputsHash: "hash",
    visibility: "shared",
    flightId: 11,
    accommodationId: null,
    reservationId: null,
    carRentalId: null,
    flightawareIdent: "UAL30",
    alertRegistrationId: "alert_1",
    projection: { flightIds: [11] },
    createdAt: new Date("2026-11-18T09:00:00Z"),
    updatedAt: new Date("2026-11-18T09:00:00Z"),
    ...overrides,
  } as Booking;
}

function operationRow(overrides: Partial<BookingOperation> = {}): BookingOperation {
  return {
    id: 500,
    bookingId: 99,
    tripId: 3,
    attemptId: null,
    kind: "cancel",
    state: "quoted",
    providerOperationId: "ore_1",
    refundAmountMinor: 40000,
    refundCurrency: "USD",
    refundTo: "original_form_of_payment",
    penaltyAmountMinor: 21200,
    penaltyCurrency: "USD",
    deltaAmountMinor: null,
    deltaCurrency: null,
    newTotalAmountMinor: null,
    newTotalCurrency: null,
    termsText: "terms",
    details: { providerOrderId: "ord_1" },
    expiresAt: new Date("2026-11-19T09:00:00Z"),
    confirmedByUserId: null,
    confirmedAt: null,
    executedAt: null,
    failureReason: null,
    createdAt: new Date("2026-11-18T10:00:00Z"),
    updatedAt: new Date("2026-11-18T10:00:00Z"),
    ...overrides,
  } as BookingOperation;
}

function bookingTravelerRow(overrides: Partial<BookingTraveler> = {}): BookingTraveler {
  return {
    id: 1,
    bookingId: 99,
    userId: 7,
    rosterEntryId: null,
    isPayer: true,
    ...overrides,
  } as BookingTraveler;
}

function flightRow(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 11,
    tripId: 3,
    flightNumber: "UA30",
    airline: "United",
    departureAirport: "EWR",
    arrivalAirport: "MUC",
    departureDatetime: "2026-09-23T17:00",
    arrivalDatetime: "2026-09-24T07:10",
    departureTimezone: "America/New_York",
    arrivalTimezone: "Europe/Berlin",
    confirmationCode: "JQZZ2H",
    notes: null,
    direction: "outbound",
    totalPrice: "612.00",
    currency: "USD",
    fareBrand: "Main Cabin",
    refundable: true,
    changeable: true,
    checkedBags: null,
    passengerCount: 1,
    layoverAirport: null,
    layoverDuration: null,
    isRedeye: null,
    ...overrides,
  } as unknown as Flight;
}

/** A recording Duffel orders client; unscripted methods throw. */
function fakeOrdersClient(script: {
  order?: Record<string, unknown>;
  cancellationQuote?: Record<string, unknown>;
  cancellationConfirm?: Record<string, unknown>;
  changeRequest?: Record<string, unknown>;
  changeRequestFull?: Record<string, unknown>;
}) {
  const calls: string[] = [];
  const unexpected = (name: string) => async (): Promise<never> => {
    throw new Error(`${name} must not be called in this test`);
  };
  const client = {
    getOffer: unexpected("getOffer"),
    createOrder: unexpected("createOrder"),
    getOrder: vi.fn(async () => {
      calls.push("getOrder");
      return script.order ?? { id: "ord_1", available_actions: ["cancel", "change"] };
    }),
    createOrderCancellation: vi.fn(async () => {
      calls.push("createOrderCancellation");
      return (
        script.cancellationQuote ?? {
          id: "ore_1",
          refund_amount: "400.00",
          refund_currency: "USD",
          refund_to: "original_form_of_payment",
          expires_at: "2026-11-19T09:00:00Z",
          confirmed_at: null,
        }
      );
    }),
    confirmOrderCancellation: vi.fn(async () => {
      calls.push("confirmOrderCancellation");
      return (
        script.cancellationConfirm ?? {
          id: "ore_1",
          refund_amount: "400.00",
          refund_currency: "USD",
          refund_to: "original_form_of_payment",
          confirmed_at: "2026-11-18T10:05:00Z",
        }
      );
    }),
    createOrderChangeRequest: vi.fn(async (input: unknown) => {
      calls.push("createOrderChangeRequest");
      void input;
      return script.changeRequest ?? { id: "ocr_1", order_id: "ord_1" };
    }),
    getOrderChangeRequest: vi.fn(async () => {
      calls.push("getOrderChangeRequest");
      return script.changeRequestFull ?? { id: "ocr_1", order_change_offers: [] };
    }),
    createOrderChange: unexpected("createOrderChange"),
    confirmOrderChange: unexpected("confirmOrderChange"),
  };
  return { client, calls };
}

function makeLifecycle(opts: {
  ordersClient: unknown;
  gate?: unknown;
  deregisterWatch?: (flightId: number) => Promise<unknown>;
  deleteCalendarEvents?: (reservationId: number) => Promise<unknown>;
  deleteItemCalendarEvents?: (itemType: string, itemId: number) => Promise<unknown>;
}) {
  return new BookingLifecycle({
    ordersClient: opts.ordersClient as never,
    gate: opts.gate as BookingGate | undefined,
    deregisterWatch: opts.deregisterWatch ?? vi.fn(async () => ({ deregistered: true })),
    deleteCalendarEvents: opts.deleteCalendarEvents ?? vi.fn(async () => undefined),
    deleteItemCalendarEvents:
      (opts.deleteItemCalendarEvents as never) ?? vi.fn(async () => undefined),
    now: NOW,
  });
}

function queueParticipant() {
  (store.selectQueues["trip_participants"] ??= []).push([{ id: 1 }]);
}

function queueBooking(booking: Booking = bookingRow()) {
  (store.selectQueues["bookings"] ??= []).push([booking]);
}

function opsOn(table: string, op = "insert") {
  return store.ops.filter((o) => o.table === table && o.op === op);
}

beforeEach(() => {
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
});

// ─── Cancel ──────────────────────────────────────────────────────────────────

describe("quoteCancellation — terms first, nothing cancelled", () => {
  it("fetches the order, then the UNCONFIRMED quote — and presents refund, penalty, deadline", async () => {
    const { client, calls } = fakeOrdersClient({});
    const lifecycle = makeLifecycle({ ordersClient: client });
    queueBooking();
    queueParticipant();
    store.insertReturns["booking_operations"] = [operationRow()];

    const result = await lifecycle.quoteCancellation(99, ACTOR);
    expect(result.supported).toBe(true);
    // Call ORDER: capability check precedes the quote; the confirm
    // call does not exist yet — nothing was cancelled.
    expect(calls).toEqual(["getOrder", "createOrderCancellation"]);
    expect(client.confirmOrderCancellation).not.toHaveBeenCalled();

    const insert = opsOn("booking_operations")[0];
    expect(insert.values).toMatchObject({
      kind: "cancel",
      state: "quoted",
      providerOperationId: "ore_1",
      refundAmountMinor: 40000,
      refundCurrency: "USD",
      penaltyAmountMinor: 21200, // 61200 charged − 40000 refund
      penaltyCurrency: "USD",
    });
    // Terms text: refund + destination + penalty + the quote deadline.
    expect(result.termsText).toContain("$400.00");
    expect(result.termsText).toContain("original form of payment");
    expect(result.termsText).toContain("$212.00");
    expect(result.termsText).toContain("2026-11-19");
    expect(result.termsText).toMatch(/Nothing is cancelled until/);
  });

  it("when the order doesn't support API cancel: plain phone guidance, zero writes, no quote call", async () => {
    const { client, calls } = fakeOrdersClient({
      order: { id: "ord_1", available_actions: ["change"] },
    });
    const lifecycle = makeLifecycle({ ordersClient: client });
    queueBooking();
    queueParticipant();

    const result = await lifecycle.quoteCancellation(99, ACTOR);
    expect(result.supported).toBe(false);
    expect(result.guidance).toMatch(/phone/i);
    expect(calls).toEqual(["getOrder"]);
    expect(opsOn("booking_operations")).toHaveLength(0);
  });
});

describe("confirmCancellation — the binding act", () => {
  it("voice confirmation is refused before any write", async () => {
    const { client } = fakeOrdersClient({});
    const lifecycle = makeLifecycle({ ordersClient: client });
    store.selectQueues["booking_operations"] = [[operationRow()]];
    queueBooking();
    queueParticipant();

    const result = await lifecycle.confirmCancellation(500, { ...ACTOR, channel: "voice" });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/Voice can't confirm/);
    expect(opsOn("booking_operations", "update")).toHaveLength(0);
    expect(client.confirmOrderCancellation).not.toHaveBeenCalled();
  });

  it("shared coverage refuses under the shipped policy — the operation stays quoted", async () => {
    const { client } = fakeOrdersClient({});
    const lifecycle = makeLifecycle({ ordersClient: client });
    store.selectQueues["booking_operations"] = [[operationRow()]];
    queueBooking();
    queueParticipant();
    store.selectQueues["booking_travelers"] = [
      [bookingTravelerRow(), bookingTravelerRow({ id: 2, userId: 8, isPayer: false })],
    ];

    const result = await lifecycle.confirmCancellation(500, ACTOR);
    expect(result.confirmed).toBe(false);
    expect(opsOn("booking_operations", "update")).toHaveLength(0);
  });

  it("an expired quote is marked expired and cannot confirm", async () => {
    const { client } = fakeOrdersClient({});
    const lifecycle = makeLifecycle({ ordersClient: client });
    store.selectQueues["booking_operations"] = [
      [operationRow({ expiresAt: new Date("2026-11-18T09:00:00Z") })],
    ];
    queueBooking();
    queueParticipant();

    const result = await lifecycle.confirmCancellation(500, ACTOR);
    expect(result.confirmed).toBe(false);
    expect(result.operation.state).toBe("expired");
    const update = opsOn("booking_operations", "update")[0];
    expect(update.set).toMatchObject({ state: "expired" });
  });
});

describe("executeCancellation — reachable only from CONFIRMED", () => {
  it("executing from the QUOTED state is impossible — no provider confirm call", async () => {
    const { client } = fakeOrdersClient({});
    const lifecycle = makeLifecycle({ ordersClient: client });
    store.selectQueues["booking_operations"] = [[operationRow({ state: "quoted" })]];
    queueBooking();
    queueParticipant();

    const result = await lifecycle.executeCancellation(500, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/hasn't been confirmed/);
    expect(client.confirmOrderCancellation).not.toHaveBeenCalled();
    expect(opsOn("bookings", "update")).toHaveLength(0);
  });

  it("confirm → execute: provider confirm once, ledger cancelled with refund expectation, rows MARKED, watch off", async () => {
    const { client, calls } = fakeOrdersClient({});
    const deregisterWatch = vi.fn(async () => ({ deregistered: true }));
    const deleteCalendarEvents = vi.fn(async () => undefined);
    const deleteItemCalendarEvents = vi.fn(async () => undefined);
    const lifecycle = makeLifecycle({
      ordersClient: client,
      deregisterWatch,
      deleteCalendarEvents,
      deleteItemCalendarEvents,
    });

    // CONFIRM (self-only coverage).
    store.selectQueues["booking_operations"] = [[operationRow()]];
    queueBooking();
    queueParticipant();
    store.selectQueues["booking_travelers"] = [[bookingTravelerRow()]];
    store.updateReturns["booking_operations"] = [operationRow({ state: "confirmed" })];
    const confirm = await lifecycle.confirmCancellation(500, ACTOR);
    expect(confirm.confirmed).toBe(true);
    // The provider has still NOT been told anything.
    expect(client.confirmOrderCancellation).not.toHaveBeenCalled();

    // EXECUTE.
    store.selectQueues["booking_operations"] = [
      [operationRow({ state: "confirmed", confirmedByUserId: 7, confirmedAt: new Date() })],
    ];
    queueBooking();
    queueParticipant();
    store.selectQueues["flights"] = [[flightRow()]];
    store.updateReturns["bookings"] = [bookingRow({ status: "cancelled" })];

    const result = await lifecycle.executeCancellation(500, ACTOR);
    expect(result.executed).toBe(true);
    expect(calls).toEqual(["confirmOrderCancellation"]);

    const bookingUpdate = opsOn("bookings", "update")[0];
    expect(bookingUpdate.set).toMatchObject({ status: "cancelled" });
    const attribution = (bookingUpdate.set as { costAttribution: { cancellation: Record<string, unknown> } })
      .costAttribution.cancellation;
    expect(attribution).toMatchObject({
      refundAmountMinor: 40000,
      refundCurrency: "USD",
      refundTo: "original_form_of_payment",
      penaltyAmountMinor: 21200,
    });

    // Legacy rows MARKED, never deleted.
    expect(opsOn("flights", "delete")).toHaveLength(0);
    const flightUpdate = opsOn("flights", "update")[0];
    expect((flightUpdate.set as { notes: string }).notes).toContain("Cancelled 2026-11-18");
    expect((flightUpdate.set as { notes: string }).notes).toContain("$400.00");

    // Operation executed; watch deregistered. Calendar: the booking
    // is not reservation-linked (reservationId null) so the
    // reservation hook stays silent — but since the §6 write-back
    // extension, gate flight bookings DO have flight events, and the
    // item hook deletes them for the cancelled leg.
    const opUpdate = opsOn("booking_operations", "update").find(
      (o) => (o.set as { state?: string }).state === "executed",
    );
    expect(opUpdate).toBeTruthy();
    expect(deregisterWatch).toHaveBeenCalledWith(11);
    expect(deleteCalendarEvents).not.toHaveBeenCalled();
    expect(deleteItemCalendarEvents).toHaveBeenCalledTimes(1);
    expect(deleteItemCalendarEvents).toHaveBeenCalledWith("flight", 11);
  });
});

// ─── Change preparation ──────────────────────────────────────────────────────

const CHANGE_OFFER = {
  id: "oco_1",
  change_total_amount: "62.00",
  change_total_currency: "USD",
  new_total_amount: "674.00",
  new_total_currency: "USD",
  penalty_total_amount: "50.00",
  penalty_total_currency: "USD",
  created_at: "2026-11-18T10:00:00Z",
  slices: {
    add: [
      {
        origin: { iata_code: "MUC" },
        destination: { iata_code: "EWR" },
        segments: [
          {
            origin: { iata_code: "MUC", time_zone: "Europe/Berlin" },
            destination: { iata_code: "EWR", time_zone: "America/New_York" },
            departing_at: "2026-09-29T09:50:00+02:00",
            arriving_at: "2026-09-29T13:00:00-04:00",
            marketing_carrier: { name: "United Airlines", iata_code: "UA" },
            marketing_carrier_flight_number: "33",
            passengers: [{ cabin_class: "economy", cabin_class_marketing_name: "Main Cabin" }],
          },
        ],
      },
    ],
    remove: [],
  },
};

describe("prepareFlightChange — a change is a gate attempt, never a mutation", () => {
  it("supported order: one gate attempt per offer, carrying the change context", async () => {
    const { client, calls } = fakeOrdersClient({
      order: { id: "ord_1", available_actions: ["change"], slices: [{ id: "sli_1" }] },
      changeRequestFull: { id: "ocr_1", order_change_offers: [CHANGE_OFFER] },
    });
    const createAttempt = vi.fn(async (input: Record<string, unknown>) => ({
      id: 55,
      state: "presented",
      ...input,
    }));
    const beginReview = vi.fn(async (attemptId: number) => ({
      attempt: { id: attemptId, state: "review" },
      outcome: "same" as const,
    }));
    const gate = { createAttempt, beginReview } as unknown as BookingGate;
    const lifecycle = makeLifecycle({ ordersClient: client, gate });
    queueBooking();
    queueParticipant();
    store.selectQueues["booking_travelers"] = [[bookingTravelerRow()]];

    const result = await lifecycle.prepareFlightChange(99, ACTOR, {
      removeSliceIds: ["sli_1"],
      addSlices: [{ origin: "MUC", destination: "EWR", departureDate: "2026-09-29" }],
    });
    expect(result.supported).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(calls).toEqual(["getOrder", "createOrderChangeRequest", "getOrderChangeRequest"]);

    const input = createAttempt.mock.calls[0][0] as {
      change: Record<string, unknown>;
      option: { money: { amountMinor: number; currency: string } };
      coveredTravelers: unknown[];
    };
    expect(input.change).toEqual({
      bookingId: 99,
      orderChangeRequestId: "ocr_1",
      newTotalAmountMinor: 67400,
      newTotalCurrency: "USD",
      penaltyAmountMinor: 5000,
      penaltyCurrency: "USD",
    });
    // The attempt's price is the CHANGE total, not the new total.
    expect(input.option.money).toEqual({ amountMinor: 6200, currency: "USD" });
    expect(input.coveredTravelers).toEqual([{ userId: 7, rosterEntryId: null, isPayer: true }]);
    expect(beginReview).toHaveBeenCalledWith(55, ACTOR);
    // The booked record itself was never written.
    expect(opsOn("bookings", "update")).toHaveLength(0);
    expect(opsOn("bookings")).toHaveLength(0);
  });

  it("unsupported order: cancel-and-rebook guidance, zero writes, no attempt", async () => {
    const { client, calls } = fakeOrdersClient({
      order: { id: "ord_1", available_actions: ["cancel"], slices: [{ id: "sli_1" }] },
    });
    const createAttempt = vi.fn(async () => ({ id: 55 }));
    const gate = { createAttempt } as unknown as BookingGate;
    const lifecycle = makeLifecycle({ ordersClient: client, gate });
    queueBooking();
    queueParticipant();

    const result = await lifecycle.prepareFlightChange(99, ACTOR, {
      removeSliceIds: ["sli_1"],
      addSlices: [{ origin: "MUC", destination: "EWR", departureDate: "2026-09-29" }],
    });
    expect(result.supported).toBe(false);
    expect(result.guidance).toMatch(/cancel-and-rebook/);
    expect(calls).toEqual(["getOrder"]);
    expect(createAttempt).not.toHaveBeenCalled();
    expect(store.ops).toHaveLength(0);
  });
});
