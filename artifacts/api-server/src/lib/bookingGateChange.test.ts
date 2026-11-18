/**
 * Booking Gate — flight CHANGE execution (E-3.4).
 *
 * The invariants under test:
 *  - a change NEVER executes without its own gate attempt: fresh
 *    presentation (the change offer, priced at the signed delta),
 *    fresh confirmation — and confirming it moves the target booking
 *    to change_pending (the ledger's own lifecycle);
 *  - execution runs the provider's documented change flow (create
 *    pending change → confirm with the balance payment), updates the
 *    booking IN PLACE to "changed" with the new total, re-projects
 *    the legacy rows, writes the operation audit record, and re-keys
 *    the watches (old legs deregistered, new legs registered);
 *  - if the pending change restates a different price than reviewed,
 *    it is NOT confirmed — the booking returns to plain confirmed and
 *    the original flights stand.
 *
 * DB is a recording @workspace/db mock (bookingGate.test.ts pattern);
 * the orders client, change re-verification, and watch functions are
 * injected fakes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { money } from "@workspace/money";
import type { Booking, BookingAttempt, BookingAttemptTraveler, Flight } from "@workspace/db";
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

import { BookingGate, type ChangeRequoteProvider } from "./bookingGate";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACTOR = { userId: 7, role: "user" };
const NOW = () => new Date("2026-11-18T10:00:00Z");

const CHANGE_CTX = {
  bookingId: 99,
  orderChangeRequestId: "ocr_1",
  newTotalAmountMinor: 67400,
  newTotalCurrency: "USD",
  penaltyAmountMinor: 5000,
  penaltyCurrency: "USD",
};

function changeOption(overrides: Partial<FlightOption> = {}): FlightOption {
  return {
    id: "oco_1",
    kind: "flight",
    adapter: "duffel",
    supplier: "United Airlines",
    money: money(6200, "USD"),
    homeEquivalent: null,
    pricedAt: "2026-11-18T09:30:00Z",
    priceNature: "firm",
    fulfillment: "api_rail",
    ruleViolations: [],
    partner: null,
    summary: {
      carrier: "United Airlines",
      carrierCode: "UA",
      slices: [
        {
          origin: "MUC",
          destination: "EWR",
          departAt: "2026-09-29T09:50:00+02:00",
          arriveAt: "2026-09-29T13:00:00-04:00",
          stops: 0,
          layovers: [],
          durationMinutes: 490,
          flightNumbers: ["UA33"],
        },
      ],
      totalDurationMinutes: 490,
      totalStops: 0,
      fareClass: "Main Cabin",
      cabinClass: "economy",
      changeable: undefined,
      refundable: undefined,
      connectionAirports: [],
      label: "UA33 Main Cabin",
    },
    ...overrides,
  };
}

function attemptRow(overrides: Partial<BookingAttempt> = {}): BookingAttempt {
  return {
    id: 42,
    tripId: 3,
    kind: "flight",
    adapter: "duffel",
    supplier: "United Airlines",
    optionId: "oco_1",
    optionSnapshot: {
      option: changeOption() as unknown as Record<string, unknown>,
      change: CHANGE_CTX,
    },
    state: "review",
    visibility: "shared",
    category: null,
    presentedAmountMinor: 6200,
    presentedCurrency: "USD",
    reviewedAmountMinor: 6200,
    reviewedCurrency: "USD",
    reviewVersion: 0,
    homeEquivalentMinor: null,
    homeCurrency: null,
    fxSnapshotId: null,
    changeTerms: "Change rules weren't stated by the supplier at search time.",
    cancelTerms: "Refund rules weren't stated by the supplier at search time.",
    whyThisOption: "traveler_chose",
    whyThisOptionText: "UA33 Main Cabin: the traveler picked this option.",
    rankingInputsHash: "hash",
    executionChannel: "duffel",
    confirmedByUserId: null,
    confirmedAt: null,
    failureReason: null,
    bookingId: null,
    createdAt: new Date("2026-11-18T09:30:00Z"),
    updatedAt: new Date("2026-11-18T09:30:00Z"),
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
    ...overrides,
  } as BookingAttemptTraveler;
}

function bookingRow(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 99,
    attemptId: 12,
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
    changeTerms: null,
    cancelTerms: null,
    whyThisOption: "best_price",
    whyThisOptionText: "x",
    rankingInputsHash: "hash",
    visibility: "shared",
    flightId: 11,
    accommodationId: null,
    reservationId: null,
    carRentalId: null,
    flightawareIdent: "UAL31",
    alertRegistrationId: "alert_1",
    projection: { flightIds: [11] },
    createdAt: new Date("2026-11-18T09:00:00Z"),
    updatedAt: new Date("2026-11-18T09:00:00Z"),
    ...overrides,
  } as Booking;
}

function flightRow(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 11,
    tripId: 3,
    flightNumber: "UA31",
    airline: "United Airlines",
    departureAirport: "MUC",
    arrivalAirport: "EWR",
    departureDatetime: "2026-09-28T09:50",
    arrivalDatetime: "2026-09-28T13:00",
    departureTimezone: "Europe/Berlin",
    arrivalTimezone: "America/New_York",
    confirmationCode: "JQZZ2H",
    notes: null,
    direction: "return",
    totalPrice: "612.00",
    currency: "USD",
    fareBrand: "Main Cabin",
    refundable: false,
    changeable: true,
    checkedBags: null,
    passengerCount: 1,
    layoverAirport: null,
    layoverDuration: null,
    isRedeye: null,
    ...overrides,
  } as unknown as Flight;
}

const CHANGED_ORDER = {
  id: "ord_1",
  booking_reference: "JQZZ2H",
  total_amount: "674.00",
  total_currency: "USD",
  owner: { name: "United Airlines", iata_code: "UA" },
  slices: [
    {
      id: "sli_2",
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
        },
      ],
    },
  ],
};

function fakeOrdersClient(pendingTotal = "62.00") {
  const calls: string[] = [];
  const client = {
    getOffer: vi.fn(async (): Promise<never> => {
      throw new Error("getOffer unused for changes");
    }),
    createOrder: vi.fn(async (): Promise<never> => {
      throw new Error("createOrder must not be called for a change");
    }),
    getOrder: vi.fn(async () => {
      calls.push("getOrder");
      return CHANGED_ORDER;
    }),
    createOrderCancellation: vi.fn(async (): Promise<never> => {
      throw new Error("unused");
    }),
    confirmOrderCancellation: vi.fn(async (): Promise<never> => {
      throw new Error("unused");
    }),
    createOrderChangeRequest: vi.fn(async (): Promise<never> => {
      throw new Error("unused");
    }),
    getOrderChangeRequest: vi.fn(async (): Promise<never> => {
      throw new Error("unused — change requote is injected");
    }),
    createOrderChange: vi.fn(async (offerId: string) => {
      calls.push("createOrderChange");
      void offerId;
      return {
        id: "oce_1",
        change_total_amount: pendingTotal,
        change_total_currency: "USD",
        new_total_amount: "674.00",
        new_total_currency: "USD",
        confirmed_at: null,
      };
    }),
    confirmOrderChange: vi.fn(async (changeId: string, payment: unknown) => {
      calls.push("confirmOrderChange");
      void changeId;
      void payment;
      return {
        id: "oce_1",
        change_total_amount: pendingTotal,
        change_total_currency: "USD",
        new_total_amount: "674.00",
        new_total_currency: "USD",
        confirmed_at: "2026-11-18T10:05:00Z",
      };
    }),
  };
  return { client, calls };
}

const sameChangeRequote: ChangeRequoteProvider = async (option, change) => ({
  outcome: "same",
  option,
  changeContext: change,
});

function makeGate(opts: {
  ordersClient: unknown;
  registerWatch?: (flightId: number) => Promise<unknown>;
  deregisterWatch?: (flightId: number) => Promise<unknown>;
}) {
  return new BookingGate({
    ordersClient: opts.ordersClient as never,
    staysClient: null,
    changeRequote: sameChangeRequote,
    readProfile: vi.fn(async () => PROFILE as never),
    registerWatch: opts.registerWatch ?? vi.fn(async () => null),
    deregisterWatch: opts.deregisterWatch ?? vi.fn(async () => ({ deregistered: true })),
    loadRules: async () => [],
    now: NOW,
  });
}

const PROFILE = {
  legal_first_name: "Philip",
  legal_middle_name: null,
  legal_last_name: "Subhan",
  date_of_birth: "1958-10-01",
  phone: "+16095550100",
};

function queueParticipant() {
  (store.selectQueues["trip_participants"] ??= []).push([{ id: 1 }]);
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

describe("change attempts through the gate", () => {
  it("confirming a change attempt moves the booking to change_pending", async () => {
    const { client } = fakeOrdersClient();
    const gate = makeGate({ ordersClient: client });
    store.selectQueues["booking_attempts"] = [[attemptRow()]];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow()]];

    const result = await gate.confirmAttempt(42, ACTOR);
    expect(result.confirmed).toBe(true);
    const bookingUpdate = opsOn("bookings", "update")[0];
    expect(bookingUpdate.set).toMatchObject({ status: "change_pending" });
  });

  it("execution: create + confirm the provider change once, booking updated in place to changed, rows re-projected, watches re-keyed", async () => {
    const { client, calls } = fakeOrdersClient();
    const registerWatch = vi.fn(async () => ({ created: true, watch: { ident: "UAL33", alertId: "alert_2" } }));
    const deregisterWatch = vi.fn(async () => ({ deregistered: true }));
    const gate = makeGate({ ordersClient: client, registerWatch, deregisterWatch });

    store.selectQueues["booking_attempts"] = [
      [
        attemptRow({
          state: "confirmed",
          confirmedByUserId: 7,
          confirmedAt: new Date("2026-11-18T09:45:00Z"),
        }),
      ],
    ];
    queueParticipant();
    // executeChangeAttempt loads the original booking, then (in the
    // finalize transaction) the current projected flight rows.
    store.selectQueues["bookings"] = [[bookingRow({ status: "change_pending" })]];
    store.selectQueues["flights"] = [[flightRow()]];
    store.insertReturns["booking_operations"] = [{ id: 501 }];
    store.updateReturns["bookings"] = [bookingRow({ status: "changed", chargeAmountMinor: 67400 })];

    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(true);
    expect(result.booking?.status).toBe("changed");
    expect(result.booking?.id).toBe(99);

    // Provider flow order: create pending change → confirm → re-read.
    expect(calls).toEqual(["createOrderChange", "confirmOrderChange", "getOrder"]);
    // The confirm paid the reviewed change total from balance.
    const confirmCall = client.confirmOrderChange.mock.calls[0];
    expect(confirmCall[0]).toBe("oce_1");
    expect(confirmCall[1]).toEqual(money(6200, "USD"));
    // No new order was ever created for a change.
    expect(client.createOrder).not.toHaveBeenCalled();

    // The legacy row was updated IN PLACE (same id) to the new flight.
    const flightUpdate = opsOn("flights", "update")[0];
    expect(flightUpdate.set).toMatchObject({
      flightNumber: "UA33",
      departureDatetime: "2026-09-29T09:50",
      totalPrice: "674.00",
    });
    expect(opsOn("flights")).toHaveLength(0);
    expect(opsOn("flights", "delete")).toHaveLength(0);

    // The operation audit record carries the delta + new total.
    const operation = opsOn("booking_operations")[0];
    expect(operation.values).toMatchObject({
      kind: "change",
      state: "executed",
      bookingId: 99,
      attemptId: 42,
      providerOperationId: "oce_1",
      deltaAmountMinor: 6200,
      newTotalAmountMinor: 67400,
      penaltyAmountMinor: 5000,
    });

    // The booking update: lifecycle + totals + charge adjustment.
    const bookingUpdate = opsOn("bookings", "update").find(
      (o) => (o.set as { status?: string }).status === "changed",
    );
    expect(bookingUpdate).toBeTruthy();
    expect(bookingUpdate!.set).toMatchObject({
      chargeAmountMinor: 67400,
      amountActuallyChargedMinor: 61200 + 6200,
      flightId: 11,
      projection: { flightIds: [11] },
    });

    // Watches re-keyed: old leg deregistered, new leg registered.
    expect(deregisterWatch).toHaveBeenCalledWith(11);
    expect(registerWatch).toHaveBeenCalledWith(11);
  });

  it("a pending change that restates a different price is NOT confirmed — booking restored, original flights stand", async () => {
    const { client } = fakeOrdersClient("80.00"); // reviewed $62, provider now says $80
    const gate = makeGate({ ordersClient: client });

    store.selectQueues["booking_attempts"] = [
      [
        attemptRow({
          state: "confirmed",
          confirmedByUserId: 7,
          confirmedAt: new Date("2026-11-18T09:45:00Z"),
        }),
      ],
    ];
    queueParticipant();
    store.selectQueues["bookings"] = [[bookingRow({ status: "change_pending" })]];

    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.attempt.state).toBe("failed");
    expect(result.reason).toMatch(/NOT confirmed/);
    expect(client.confirmOrderChange).not.toHaveBeenCalled();
    // Booking restored from change_pending to plain confirmed.
    const restore = opsOn("bookings", "update").find(
      (o) => (o.set as { status?: string }).status === "confirmed",
    );
    expect(restore).toBeTruthy();
    // The failed change is on the record; no flight rows were touched.
    const operation = opsOn("booking_operations")[0];
    expect(operation.values).toMatchObject({ kind: "change", state: "failed" });
    expect(opsOn("flights", "update")).toHaveLength(0);
    expect(opsOn("flights")).toHaveLength(0);
  });
});
