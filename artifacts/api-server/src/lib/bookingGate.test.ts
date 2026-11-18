/**
 * Booking Gate Service — DB-level tests with a recording @workspace/db
 * mock (same pattern as watching.test.ts / travelerProfile.test.ts).
 * The Duffel orders client, the re-verification provider, the vault
 * read, the rules loader, and watch registration are all injected
 * fakes — no live provider call exists or is possible (no API key).
 *
 * The invariants under test are the product's confirmation discipline:
 *  - no execution from any state but CONFIRMED (tool AND service level);
 *  - re-verification deltas return the attempt to REVIEW with the new
 *    total stated — zero provider creates;
 *  - the conservative policy: self-only confirms; shared items refuse
 *    with the reason stated while per-traveler confirmations are still
 *    tracked;
 *  - passenger details come from the vault read (purpose
 *    booking_execution, booking-id-logged), never from arguments;
 *  - a create call is sent exactly once (202 included), and re-entering
 *    a BOOKED attempt never re-sends;
 *  - provider failure marks the ledger row failed and writes NO
 *    itinerary rows — no phantoms.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Booking, BookingAttempt, BookingAttemptTraveler } from "@workspace/db";
import type { FlightOption } from "./options";
import type { DuffelOrder, DuffelPassengerInput } from "./duffel";

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
}));

vi.mock("./email.js", () => ({
  sendEmail: vi.fn(async () => ({ sent: true })),
}));

import { BookingGate, BookingAccessDenied, type BookingGateDeps, type RequoteInfo } from "./bookingGate";
import { GateTransitionError } from "./bookingGateLogic";
import { DuffelError } from "./duffel";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACTOR = { userId: 7, role: "user" };

function flightOption(overrides: Partial<FlightOption> = {}): FlightOption {
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
    ...overrides,
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

// ─── Injected fakes ──────────────────────────────────────────────────────────

const profileValues: Record<string, string> = {
  legal_first_name: "Philip",
  legal_last_name: "Subhan",
  date_of_birth: "1958-10-01",
  phone: "+16095550100",
};

type CreateOrderInput = { offerId: string; passengers: DuffelPassengerInput[] };
type CreateOrderFn = (input: CreateOrderInput) => Promise<{ status: number; order: DuffelOrder | null }>;

function makeGate(overrides: {
  requoteInfo?: RequoteInfo;
  createOrderImpl?: CreateOrderFn;
  profile?: Record<string, string | null>;
  rules?: unknown[];
  gateDeps?: Partial<BookingGateDeps>;
} = {}) {
  const readProfileCalls: Array<Record<string, unknown>> = [];
  const watchCalls: number[] = [];
  const ordersClient = {
    getOffer: vi.fn(async (): Promise<never> => {
      throw new Error("getOffer must not be called — requote is injected");
    }),
    createOrder: vi.fn<CreateOrderFn>(
      overrides.createOrderImpl ?? (async () => ({ status: 201, order: ORDER })),
    ),
    // Servicing methods (E-3.4) are not exercised by this suite.
    getOrder: vi.fn(async (): Promise<never> => { throw new Error("not used in this suite"); }),
    createOrderCancellation: vi.fn(async (): Promise<never> => { throw new Error("not used in this suite"); }),
    confirmOrderCancellation: vi.fn(async (): Promise<never> => { throw new Error("not used in this suite"); }),
    createOrderChangeRequest: vi.fn(async (): Promise<never> => { throw new Error("not used in this suite"); }),
    getOrderChangeRequest: vi.fn(async (): Promise<never> => { throw new Error("not used in this suite"); }),
    createOrderChange: vi.fn(async (): Promise<never> => { throw new Error("not used in this suite"); }),
    confirmOrderChange: vi.fn(async (): Promise<never> => { throw new Error("not used in this suite"); }),
  };
  const gate = new BookingGate({
    ordersClient,
    requote: vi.fn(
      async (): Promise<RequoteInfo> =>
        overrides.requoteInfo ?? {
          outcome: "same",
          option: flightOption(),
          offerPassengerIds: ["pas_1"],
        },
    ),
    readProfile: vi.fn(async (userId: number, fields: readonly string[], accessor: unknown, purpose: unknown, bookingId?: number) => {
      readProfileCalls.push({ userId, fields: [...fields], accessor, purpose, bookingId });
      const values = overrides.profile ?? profileValues;
      const out: Record<string, string | null> = {};
      for (const f of fields) out[f] = values[f] ?? null;
      return out;
    }) as never,
    registerWatch: vi.fn(async (flightId: number) => {
      watchCalls.push(flightId);
      return { created: true, watch: { ident: "UAL30", alertId: "alert_1" } };
    }),
    loadRules: vi.fn(async () => (overrides.rules ?? []) as never),
    ...(overrides.gateDeps ?? {}),
  });
  return { gate, ordersClient, readProfileCalls, watchCalls };
}

function queueParticipant() {
  store.selectQueues["trip_participants"] = [
    ...(store.selectQueues["trip_participants"] ?? []),
    [{ tripId: 3, userId: 7, isTripAdmin: true }],
  ];
}

function opsOn(table: string, op?: string) {
  return store.ops.filter((o) => o.table === table && (!op || o.op === op));
}

beforeEach(() => {
  // Clear by MUTATION: the mock's chains close over these exact objects,
  // so reassigning them would disconnect the queues the mock reads.
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
});

// ─── createAttempt ───────────────────────────────────────────────────────────

describe("createAttempt", () => {
  it("inserts a PRESENTED attempt with the option snapshot, why, terms — and coverage rows", async () => {
    const { gate } = makeGate();
    queueParticipant();
    store.insertReturns["booking_attempts"] = [attemptRow()];
    const attempt = await gate.createAttempt({
      ...ACTOR,
      tripId: 3,
      option: flightOption(),
      coveredTravelers: [{ userId: 7, isPayer: true }],
      fitReasons: ["Cheapest option that fits your rules"],
      setSize: 4,
    });
    expect(attempt.state).toBe("presented");
    const insert = opsOn("booking_attempts", "insert")[0].values as Record<string, unknown>;
    expect(insert.presentedAmountMinor).toBe(61200);
    expect(insert.whyThisOption).toBe("best_price");
    expect(insert.executionChannel).toBe("duffel");
    expect(opsOn("booking_attempt_travelers", "insert")).toHaveLength(1);
  });

  it("defaults concierge-category items to private visibility", async () => {
    const { gate } = makeGate();
    queueParticipant();
    store.insertReturns["booking_attempts"] = [attemptRow({ visibility: "private", category: "spa" })];
    await gate.createAttempt({
      ...ACTOR,
      tripId: 3,
      option: flightOption(),
      coveredTravelers: [{ userId: 7 }],
      category: "spa",
    });
    const insert = opsOn("booking_attempts", "insert")[0].values as Record<string, unknown>;
    expect(insert.visibility).toBe("private");
    expect(insert.category).toBe("spa");
  });

  it("denies a non-participant before any write", async () => {
    const { gate } = makeGate();
    store.selectQueues["trip_participants"] = [[]];
    await expect(
      gate.createAttempt({ ...ACTOR, tripId: 3, option: flightOption(), coveredTravelers: [{ userId: 7 }] }),
    ).rejects.toThrow(BookingAccessDenied);
    expect(store.ops).toHaveLength(0);
  });
});

// ─── beginReview / re-verification ───────────────────────────────────────────

describe("beginReview — re-verification at selection", () => {
  it("same price: PRESENTED → REVERIFYING → REVIEW with the reviewed total set", async () => {
    const { gate } = makeGate();
    store.selectQueues["booking_attempts"] = [[attemptRow()]];
    queueParticipant();
    const result = await gate.beginReview(42, ACTOR);
    expect(result.outcome).toBe("same");
    expect(result.attempt.state).toBe("review");
    expect(result.attempt.reviewedAmountMinor).toBe(61200);
    const states = opsOn("booking_attempts", "update").map((o) => (o.set as { state: string }).state);
    expect(states).toEqual(["reverifying", "review"]);
  });

  it("price up: returns to REVIEW with the delta stated and reviewVersion bumped — the old total is never silently kept", async () => {
    const changed = flightOption({ money: { amountMinor: 64000, currency: "USD" } });
    const { gate } = makeGate({
      requoteInfo: {
        outcome: "changed",
        option: changed,
        deltaText: "UA30 Main Cabin: the price went UP from $612.00 to $640.00 (+$28.00) since it was shown. Nothing was booked — review the new total before confirming.",
        offerPassengerIds: ["pas_1"],
      },
    });
    store.selectQueues["booking_attempts"] = [[attemptRow()]];
    queueParticipant();
    const result = await gate.beginReview(42, ACTOR);
    expect(result.outcome).toBe("changed");
    expect(result.deltaText).toContain("+$28.00");
    expect(result.attempt.state).toBe("review");
    expect(result.attempt.reviewedAmountMinor).toBe(64000);
    expect(result.attempt.reviewVersion).toBe(1);
  });

  it("sold out: the attempt FAILS with the reason, openly", async () => {
    const { gate } = makeGate({
      requoteInfo: { outcome: "unavailable", reason: "That flight is no longer available — it sold out." },
    });
    store.selectQueues["booking_attempts"] = [[attemptRow()]];
    queueParticipant();
    const result = await gate.beginReview(42, ACTOR);
    expect(result.outcome).toBe("unavailable");
    expect(result.attempt.state).toBe("failed");
    expect(result.attempt.failureReason).toMatch(/sold out/);
  });

  it("unverifiable: back to PRESENTED, nothing failed, nothing booked", async () => {
    const { gate } = makeGate({
      requoteInfo: { outcome: "unverifiable", reason: "Duffel isn't configured." },
    });
    store.selectQueues["booking_attempts"] = [[attemptRow()]];
    queueParticipant();
    const result = await gate.beginReview(42, ACTOR);
    expect(result.outcome).toBe("unverifiable");
    expect(result.attempt.state).toBe("presented");
  });
});

// ─── confirmAttempt / policy ─────────────────────────────────────────────────

describe("confirmAttempt — the ConfirmationPolicy seam", () => {
  it("self-only coverage confirms: state CONFIRMED with who/when recorded", async () => {
    const { gate } = makeGate();
    store.selectQueues["booking_attempts"] = [[attemptRow({ state: "review", reviewedAmountMinor: 61200, reviewedCurrency: "USD" })]];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow()]];
    const result = await gate.confirmAttempt(42, ACTOR);
    expect(result.confirmed).toBe(true);
    expect(result.attempt.state).toBe("confirmed");
    expect(result.attempt.confirmedByUserId).toBe(7);
    expect(result.attempt.confirmedAt).toBeInstanceOf(Date);
  });

  it("shared item: refused with the reason stated, attempt stays in REVIEW, but the traveler's own confirmation IS tracked", async () => {
    const { gate } = makeGate();
    store.selectQueues["booking_attempts"] = [[attemptRow({ state: "review", reviewedAmountMinor: 61200, reviewedCurrency: "USD" })]];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [
      [coverageRow(), coverageRow({ id: 2, userId: 8, isPayer: false }), coverageRow({ id: 3, userId: 9, isPayer: false })],
    ];
    const result = await gate.confirmAttempt(42, ACTOR);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/Group confirmation is disabled/);
    expect(result.attempt.state).toBe("review");
    // Per-traveler tracking: Phil's own row got its confirmation stamp.
    const ownUpdate = opsOn("booking_attempt_travelers", "update");
    expect(ownUpdate).toHaveLength(1);
    expect((ownUpdate[0].set as { confirmedAt: Date }).confirmedAt).toBeInstanceOf(Date);
    // Partial state is visible in the returned coverage.
    expect(result.coverage.find((c) => c.userId === 7)?.confirmedAt).toBeInstanceOf(Date);
    expect(result.coverage.find((c) => c.userId === 8)?.confirmedAt).toBeNull();
  });

  it("a confirmer the item doesn't cover is refused", async () => {
    const { gate } = makeGate();
    store.selectQueues["booking_attempts"] = [[attemptRow({ state: "review" })]];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow({ userId: 8 })]];
    const result = await gate.confirmAttempt(42, ACTOR);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/covers you/);
  });

  it("confirming from PRESENTED (skipping review) is an illegal transition", async () => {
    const { gate } = makeGate();
    store.selectQueues["booking_attempts"] = [[attemptRow({ state: "presented" })]];
    queueParticipant();
    await expect(gate.confirmAttempt(42, ACTOR)).rejects.toThrow(GateTransitionError);
  });
});

// ─── executeAttempt ──────────────────────────────────────────────────────────

function queueConfirmedExecute(opts: {
  coverage?: BookingAttemptTraveler[];
  booking?: Booking;
} = {}) {
  store.selectQueues["booking_attempts"] = [
    [attemptRow({ state: "confirmed", reviewedAmountMinor: 61200, reviewedCurrency: "USD", confirmedByUserId: 7, confirmedAt: new Date() })],
  ];
  queueParticipant();
  store.selectQueues["booking_attempt_travelers"] = [opts.coverage ?? [coverageRow({ confirmedAt: new Date() })]];
  store.insertReturns["bookings"] = [opts.booking ?? bookingRow()];
  store.insertReturns["flights"] = [
    { id: 55, tripId: 3, flightNumber: "UA30" },
  ];
  store.updateReturns["bookings"] = [
    bookingRow({ status: "confirmed", confirmationCode: "XYZ123", providerOrderId: "ord_1", flightId: 55 }),
  ];
}

describe("executeAttempt — confirm-then-book, exactly once", () => {
  it("happy path: ledger BOOKED, legacy flight projected, splits + no-rail commission written, watch registered", async () => {
    const { gate, ordersClient, readProfileCalls, watchCalls } = makeGate();
    queueConfirmedExecute();
    const result = await gate.executeAttempt(42, ACTOR);

    expect(result.executed).toBe(true);
    expect(result.attempt.state).toBe("booked");
    expect(result.attempt.bookingId).toBe(99);
    expect(result.booking?.status).toBe("confirmed");
    expect(result.booking?.confirmationCode).toBe("XYZ123");

    // The provider create fired exactly once, with VAULT-sourced passengers.
    expect(ordersClient.createOrder).toHaveBeenCalledTimes(1);
    const createArg = ordersClient.createOrder.mock.calls[0][0];
    expect(createArg.offerId).toBe("off_123");
    expect(createArg.passengers).toEqual([
      { id: "pas_1", givenName: "Philip", familyName: "Subhan", bornOn: "1958-10-01", phoneNumber: "+16095550100" },
    ]);

    // The vault read: purpose booking_execution, logged against the ledger booking.
    expect(readProfileCalls).toHaveLength(1);
    expect(readProfileCalls[0].purpose).toBe("booking_execution");
    expect(readProfileCalls[0].bookingId).toBe(99);
    expect(readProfileCalls[0].userId).toBe(7);
    expect(readProfileCalls[0].fields).toEqual([
      "legal_first_name",
      "legal_middle_name",
      "legal_last_name",
      "date_of_birth",
      "phone",
    ]);

    // Projection: exactly one legacy flight row, carrying the confirmation code.
    const flightInserts = opsOn("flights", "insert");
    expect(flightInserts).toHaveLength(1);
    expect((flightInserts[0].values as Record<string, unknown>).confirmationCode).toBe("XYZ123");
    expect((flightInserts[0].values as Record<string, unknown>).totalPrice).toBe("612.00");

    // Splits: the single covered traveler carries the whole total.
    const splits = opsOn("booking_splits", "insert");
    expect(splits).toHaveLength(1);
    expect((splits[0].values as Record<string, unknown>).shareAmountMinor).toBe(61200);

    // Commission: explicitly no_rail with the machine-readable reason.
    const commission = opsOn("commission_records", "insert");
    expect(commission).toHaveLength(1);
    expect((commission[0].values as Record<string, unknown>).status).toBe("no_rail");
    expect((commission[0].values as Record<string, unknown>).noRailReason).toBe("no_commission_on_duffel_flights");

    // Rail fees written on the ledger (ROI attribution): $3.00 + 1% of $612.00.
    const bookingUpdate = opsOn("bookings", "update").map((o) => o.set as Record<string, unknown>);
    const finalize = bookingUpdate.find((s) => s.status === "confirmed");
    expect(finalize?.railOrderFeeMinor).toBe(300);
    expect(finalize?.railPctFeeMinor).toBe(612);
    expect(finalize?.merchantOfRecord).toBeUndefined(); // set at insert, not update
    const bookingInsert = opsOn("bookings", "insert")[0].values as Record<string, unknown>;
    expect(bookingInsert.merchantOfRecord).toBe("duffel");

    // Watching registered for the projected leg.
    expect(watchCalls).toEqual([55]);
  });

  it("calendar write-back: the booked leg syncs to each covered traveler's Wander calendar (§6)", async () => {
    const calendarCalls: Array<{ userId: number; ref: { type: string; item: { id: number } } }> = [];
    const { gate } = makeGate({
      gateDeps: {
        syncCalendarItem: vi.fn(async (userId: number, ref: never) => {
          calendarCalls.push({ userId, ref });
        }),
      },
    });
    queueConfirmedExecute();
    // Post-finalization reads the calendar tail performs: the
    // projected flight row, then coverage again for the sync.
    store.selectQueues["flights"] = [
      [{
        id: 55, tripId: 3, flightNumber: "UA30", airline: "United Airlines",
        departureAirport: "EWR", arrivalAirport: "MUC",
        departureDatetime: "2026-09-23T17:00", arrivalDatetime: "2026-09-24T07:10",
        departureTimezone: "America/New_York", arrivalTimezone: "Europe/Berlin",
      }],
    ];
    store.selectQueues["booking_attempt_travelers"] = [
      [coverageRow({ confirmedAt: new Date() })],
      [coverageRow({ confirmedAt: new Date() })],
    ];
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(true);
    expect(calendarCalls).toHaveLength(1);
    expect(calendarCalls[0].userId).toBe(7);
    expect(calendarCalls[0].ref.type).toBe("flight");
    expect(calendarCalls[0].ref.item.id).toBe(55);
  });

  it("execute without CONFIRMED is impossible at the service level — no provider call, no writes", async () => {
    const { gate, ordersClient } = makeGate();
    store.selectQueues["booking_attempts"] = [[attemptRow({ state: "review", reviewedAmountMinor: 61200 })]];
    queueParticipant();
    await expect(gate.executeAttempt(42, ACTOR)).rejects.toThrow(GateTransitionError);
    expect(ordersClient.createOrder).not.toHaveBeenCalled();
    expect(opsOn("bookings", "insert")).toHaveLength(0);
    expect(opsOn("flights", "insert")).toHaveLength(0);
  });

  it("execute from PRESENTED is equally impossible", async () => {
    const { gate, ordersClient } = makeGate();
    store.selectQueues["booking_attempts"] = [[attemptRow({ state: "presented" })]];
    queueParticipant();
    await expect(gate.executeAttempt(42, ACTOR)).rejects.toThrow(GateTransitionError);
    expect(ordersClient.createOrder).not.toHaveBeenCalled();
  });

  it("re-entering a BOOKED attempt returns the booking — the provider is never called twice", async () => {
    const { gate, ordersClient } = makeGate();
    store.selectQueues["booking_attempts"] = [[attemptRow({ state: "booked", bookingId: 99 })]];
    queueParticipant();
    store.selectQueues["bookings"] = [[bookingRow({ status: "confirmed", confirmationCode: "XYZ123" })]];
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(true);
    expect(result.alreadyBooked).toBe(true);
    expect(ordersClient.createOrder).not.toHaveBeenCalled();
  });

  it("an EXECUTING attempt refuses re-entry — reconcile, never re-send", async () => {
    const { gate, ordersClient } = makeGate();
    store.selectQueues["booking_attempts"] = [[attemptRow({ state: "executing" })]];
    queueParticipant();
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/never re-sent/);
    expect(ordersClient.createOrder).not.toHaveBeenCalled();
  });

  it("202 accepted: booking lands as pending, attempt BOOKED, and the create still fired exactly once", async () => {
    const { gate, ordersClient } = makeGate({
      createOrderImpl: async () => ({ status: 202, order: { ...ORDER, booking_reference: undefined } }),
    });
    queueConfirmedExecute();
    store.updateReturns["bookings"] = [bookingRow({ status: "pending", providerOrderId: "ord_1" })];
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(true);
    expect(result.pendingConfirmation).toBe(true);
    expect(result.booking?.status).toBe("pending");
    expect(ordersClient.createOrder).toHaveBeenCalledTimes(1);
  });

  it("price changed at the execution boundary: back to REVIEW, confirmation cleared, ZERO provider creates", async () => {
    const changed = flightOption({ money: { amountMinor: 65500, currency: "USD" } });
    const { gate, ordersClient } = makeGate({
      requoteInfo: {
        outcome: "changed",
        option: changed,
        deltaText: "UA30 Main Cabin: the price went UP from $612.00 to $655.00 (+$43.00) since it was shown.",
        offerPassengerIds: ["pas_1"],
      },
    });
    store.selectQueues["booking_attempts"] = [
      [attemptRow({ state: "confirmed", reviewedAmountMinor: 61200, reviewedCurrency: "USD", confirmedByUserId: 7, confirmedAt: new Date() })],
    ];
    queueParticipant();
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.attempt.state).toBe("review");
    expect(result.attempt.reviewedAmountMinor).toBe(65500);
    expect(result.attempt.confirmedByUserId).toBeNull();
    expect(result.deltaText).toContain("+$43.00");
    expect(ordersClient.createOrder).not.toHaveBeenCalled();
    expect(opsOn("bookings", "insert")).toHaveLength(0);
  });

  it("sold out at the execution boundary: FAILED openly, no create, no booking row", async () => {
    const { gate, ordersClient } = makeGate({
      requoteInfo: { outcome: "unavailable", reason: "That flight is no longer available." },
    });
    store.selectQueues["booking_attempts"] = [
      [attemptRow({ state: "confirmed", reviewedAmountMinor: 61200, reviewedCurrency: "USD", confirmedByUserId: 7 })],
    ];
    queueParticipant();
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.attempt.state).toBe("failed");
    expect(ordersClient.createOrder).not.toHaveBeenCalled();
    expect(opsOn("bookings", "insert")).toHaveLength(0);
    expect(opsOn("flights", "insert")).toHaveLength(0);
  });

  it("provider failure: attempt FAILED with the reason, ledger marked failed, NO phantom itinerary rows", async () => {
    const { gate } = makeGate({
      createOrderImpl: async () => {
        throw new DuffelError("Duffel error (HTTP 422): Offer has expired", 422);
      },
    });
    queueConfirmedExecute();
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.attempt.state).toBe("failed");
    expect(result.reason).toMatch(/didn't go through/);
    expect(result.booking?.status).toBe("failed");
    // The ledger row exists and is MARKED failed — never a silent partial.
    const bookingUpdates = opsOn("bookings", "update").map((o) => o.set as Record<string, unknown>);
    expect(bookingUpdates.some((s) => s.status === "failed")).toBe(true);
    // And no itinerary projection was written.
    expect(opsOn("flights", "insert")).toHaveLength(0);
    expect(opsOn("booking_splits", "insert")).toHaveLength(0);
    expect(opsOn("commission_records", "insert")).toHaveLength(0);
  });

  it("a booking_channel_required rule refuses off-channel execution (TC-5) — stays CONFIRMED, no create", async () => {
    const { gate, ordersClient } = makeGate({
      rules: [
        {
          id: 1,
          ruleClass: "hard",
          ruleType: "booking_channel_required",
          params: { channel: "egencia" },
          scope: "all",
          source: "explicit",
          active: true,
        },
      ],
    });
    store.selectQueues["booking_attempts"] = [
      [attemptRow({ state: "confirmed", reviewedAmountMinor: 61200, reviewedCurrency: "USD", confirmedByUserId: 7 })],
    ];
    queueParticipant();
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/egencia/);
    expect(result.attempt.state).toBe("confirmed");
    expect(ordersClient.createOrder).not.toHaveBeenCalled();
    expect(opsOn("bookings", "insert")).toHaveLength(0);
  });

  it("passenger-count mismatch fails before any create", async () => {
    const { gate, ordersClient } = makeGate({
      requoteInfo: { outcome: "same", option: flightOption(), offerPassengerIds: ["pas_1", "pas_2"] },
    });
    queueConfirmedExecute();
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.attempt.state).toBe("failed");
    expect(result.reason).toMatch(/must match/);
    expect(ordersClient.createOrder).not.toHaveBeenCalled();
    expect(opsOn("flights", "insert")).toHaveLength(0);
  });

  it("a profile missing its date of birth fails openly, naming what's missing — no create", async () => {
    const { gate, ordersClient } = makeGate({
      profile: { legal_first_name: "Philip", legal_last_name: "Subhan", date_of_birth: null, phone: null },
    });
    queueConfirmedExecute();
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/date of birth/);
    expect(ordersClient.createOrder).not.toHaveBeenCalled();
  });

  it("a covered traveler who hasn't claimed a profile fails openly — no create", async () => {
    const { gate, ordersClient } = makeGate();
    queueConfirmedExecute({ coverage: [coverageRow({ userId: null, rosterEntryId: 5, confirmedAt: new Date() })] });
    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/hasn't set up their travel profile/);
    expect(ordersClient.createOrder).not.toHaveBeenCalled();
  });
});
