/**
 * Booking Gate — STAYS execution (E-3.2 remainder).
 *
 * Same state machine as flights, no parallel path: the stay's
 * re-verification IS the Duffel Stays quote. The invariants under
 * test:
 *  - estimate → quote delta → back to REVIEW with honest
 *    estimate-to-quote copy → confirm → execute books against the
 *    quote, with the ledger row canonical and the accommodation
 *    projected EXACTLY once;
 *  - a quote with NO delta books after ONE confirmation;
 *  - guests come from the vault (purpose booking_execution, real
 *    booking id) — a profile gap fails the execution BEFORE any
 *    provider booking call, with no itinerary rows written;
 *  - the commission record is "expected" with NO amount (Duffel Stays
 *    pays an unstated profit share — never an invented rate);
 *  - no rate reference / no client → plain refusals, nothing booked.
 *
 * DB is a recording @workspace/db mock (bookingGate.test.ts pattern);
 * the stays client, vault read, and rules loader are injected fakes.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { money } from "@workspace/money";
import type { Booking, BookingAttempt, BookingAttemptTraveler } from "@workspace/db";
import type { StayOption } from "./options";
import type { DuffelStayQuote } from "./duffelStays";

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

import { BookingGate, stayQuoteToRequoteInfo } from "./bookingGate";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACTOR = { userId: 7, role: "user" };
const NOW = () => new Date("2026-11-18T10:00:00Z");

function stayOption(
  overrides: Partial<Omit<StayOption, "summary">> & { summary?: Partial<StayOption["summary"]> } = {},
): StayOption {
  const base: StayOption = {
    id: "sta_1",
    kind: "stay",
    adapter: "duffel",
    supplier: "Hotel Beispiel",
    money: money(80000, "EUR"),
    homeEquivalent: null,
    pricedAt: "2026-11-18T09:00:00Z",
    priceNature: "estimate",
    fulfillment: "api_rail",
    ruleViolations: [],
    partner: null,
    summary: {
      propertyName: "Hotel Beispiel",
      propertyType: "hotel",
      stayStyle: "boutique",
      isWholeHome: false,
      chainName: null,
      cityName: "Munich",
      areaLabel: "Munich, Bavaria",
      starRating: 4,
      reviewScore: 8.7,
      reviewCount: 100,
      roomName: "Double Room",
      beds: "1 king bed",
      checkInDate: "2026-12-03",
      checkOutDate: "2026-12-08",
      nights: 5,
      guestCount: 1,
      rooms: 1,
      breakdown: {
        base: money(70000, "EUR"),
        tax: money(6000, "EUR"),
        fee: money(4000, "EUR"),
        taxesAndFees: null,
        dueAtAccommodation: null,
      },
      nightlyRate: money(16000, "EUR"),
      perPersonPerNight: null,
      cancellationTerms: "Free cancellation until 2026-12-01",
      freeCancellation: true,
      boardType: "Breakfast included",
      rateId: "rat_1",
      quoteId: null,
      addressLine: "Leopoldstrasse 10",
      label: "Hotel Beispiel, Munich",
    },
  };
  return { ...base, ...overrides, summary: { ...base.summary, ...(overrides.summary ?? {}) } };
}

function attemptRow(overrides: Partial<BookingAttempt> = {}): BookingAttempt {
  return {
    id: 42,
    tripId: 3,
    kind: "stay",
    adapter: "duffel",
    supplier: "Hotel Beispiel",
    optionId: "sta_1",
    optionSnapshot: { option: stayOption() as unknown as Record<string, unknown> },
    state: "presented",
    visibility: "shared",
    category: null,
    presentedAmountMinor: 80000,
    presentedCurrency: "EUR",
    reviewedAmountMinor: null,
    reviewedCurrency: null,
    reviewVersion: 0,
    homeEquivalentMinor: null,
    homeCurrency: null,
    fxSnapshotId: null,
    changeTerms: "Change rules are confirmed when the stay quote is issued.",
    cancelTerms: "Free cancellation until 2026-12-01",
    whyThisOption: "best_price",
    whyThisOptionText: "Hotel Beispiel, Munich was the cheapest option that fit your rules.",
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
    ...overrides,
  } as BookingAttemptTraveler;
}

function bookingRow(overrides: Partial<Booking> = {}): Booking {
  return {
    id: 99,
    attemptId: 42,
    tripId: 3,
    kind: "stay",
    supplier: "Hotel Beispiel",
    status: "pending",
    source: "api_rail",
    confirmationCode: null,
    providerOrderId: null,
    chargeAmountMinor: 84000,
    chargeCurrency: "EUR",
    amountActuallyChargedMinor: null,
    homeEquivalentMinor: null,
    homeCurrency: null,
    fxSnapshotId: null,
    merchantOfRecord: "duffel",
    railProvider: null,
    railOrderFeeMinor: null,
    railPctFeeMinor: null,
    railFeeCurrency: null,
    processingFeeMinor: null,
    costAttribution: {},
    changeTerms: null,
    cancelTerms: null,
    whyThisOption: "best_price",
    whyThisOptionText: "x",
    rankingInputsHash: "hash",
    visibility: "shared",
    flightId: null,
    accommodationId: null,
    reservationId: null,
    carRentalId: null,
    flightawareIdent: null,
    alertRegistrationId: null,
    projection: {},
    createdAt: new Date("2026-11-18T10:00:00Z"),
    updatedAt: new Date("2026-11-18T10:00:00Z"),
    ...overrides,
  } as Booking;
}

const PROFILE = {
  legal_first_name: "Philip",
  legal_middle_name: null,
  legal_last_name: "Subhan",
  date_of_birth: "1958-10-01",
  phone: "+16095550100",
};

/** A stays client whose quotes come from a script of totals. */
function fakeStaysClient(quoteTotals: string[]) {
  let quoteCount = 0;
  const createQuote = vi.fn(async (rateId: string): Promise<DuffelStayQuote> => {
    const total = quoteTotals[Math.min(quoteCount, quoteTotals.length - 1)];
    quoteCount++;
    return {
      id: `quo_${quoteCount}`,
      rate_id: rateId,
      total_amount: total,
      total_currency: "EUR",
      base_amount: "700.00",
      base_currency: "EUR",
      tax_amount: "60.00",
      tax_currency: "EUR",
      fee_amount: "40.00",
      fee_currency: "EUR",
      cancellation_timeline: [
        { refund_amount: total, currency: "EUR", before: "2026-12-01T00:00:00Z" },
      ],
    };
  });
  const createBooking = vi.fn(
    async (input: {
      quoteId: string;
      guests: Array<{ givenName: string; familyName: string; bornOn: string }>;
      email: string;
      phoneNumber: string;
    }) => {
      void input;
      return {
        status: 201,
        booking: { id: "bok_1", reference: "HTLREF1", quote_id: "quo_x", total_amount: "840.00", total_currency: "EUR" },
      };
    },
  );
  return {
    client: {
      searchStays: vi.fn(async () => ({ results: [] })),
      createQuote,
      createBooking,
    },
    createQuote,
    createBooking,
  };
}

function makeGate(opts: {
  staysClient: unknown;
  profile?: Record<string, unknown>;
  readProfileCalls?: Array<Record<string, unknown>>;
}) {
  const readProfile = vi.fn(
    async (userId: number, fields: readonly string[], accessor: unknown, purpose: unknown, bookingId?: number) => {
      opts.readProfileCalls?.push({ userId, fields: [...fields], accessor, purpose, bookingId });
      return (opts.profile ?? PROFILE) as never;
    },
  );
  return new BookingGate({
    ordersClient: null,
    staysClient: opts.staysClient as never,
    readProfile: readProfile as never,
    registerWatch: vi.fn(async () => null),
    deregisterWatch: vi.fn(async () => ({ deregistered: true })),
    loadRules: async () => [],
    now: NOW,
  });
}

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

// ─── The flows ───────────────────────────────────────────────────────────────

describe("stays through the gate", () => {
  it("estimate → quote delta → re-review → confirm → execute: ledger + projection exactly once", async () => {
    // Quote script: €840 at review AND at the execution boundary
    // (the presented estimate was €800 — the normal stays delta).
    const stays = fakeStaysClient(["840.00", "840.00"]);
    const readProfileCalls: Array<Record<string, unknown>> = [];
    const gate = makeGate({ staysClient: stays.client, readProfileCalls });

    // PRESENT
    queueParticipant();
    store.insertReturns["booking_attempts"] = [attemptRow()];
    const attempt = await gate.createAttempt({
      userId: 7,
      role: "user",
      tripId: 3,
      option: stayOption(),
      coveredTravelers: [{ userId: 7, isPayer: true }],
    });
    expect(attempt.state).toBe("presented");

    // REVIEW — the quote moves the price; the delta is stated honestly.
    store.selectQueues["booking_attempts"] = [[attemptRow()]];
    queueParticipant();
    const review = await gate.beginReview(42, ACTOR);
    expect(review.outcome).toBe("changed");
    expect(review.deltaText).toMatch(/estimate/i);
    expect(review.deltaText).toContain("840");
    expect(review.attempt.reviewedAmountMinor).toBe(84000);
    expect(review.attempt.state).toBe("review");
    // The fresh option on the snapshot is FIRM and carries the quote id.
    const freshOption = review.attempt.optionSnapshot.option as unknown as StayOption;
    expect(freshOption.priceNature).toBe("firm");
    expect(freshOption.summary.quoteId).toBe("quo_1");

    // CONFIRM at the quoted total.
    store.selectQueues["booking_attempts"] = [
      [attemptRow({ state: "review", reviewedAmountMinor: 84000, reviewedCurrency: "EUR" })],
    ];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow()]];
    const confirm = await gate.confirmAttempt(42, ACTOR);
    expect(confirm.confirmed).toBe(true);

    // EXECUTE — boundary requote (quo_2), then book against the quote.
    // (The confirmed attempt's snapshot carries the REVIEWED option —
    // the firm €840 quote beginReview stored — not the €800 estimate.)
    store.selectQueues["booking_attempts"] = [
      [
        attemptRow({
          state: "confirmed",
          reviewedAmountMinor: 84000,
          reviewedCurrency: "EUR",
          confirmedByUserId: 7,
          confirmedAt: new Date("2026-11-18T10:01:00Z"),
          optionSnapshot: {
            option: stayOption({
              money: money(84000, "EUR"),
              priceNature: "firm",
              summary: { quoteId: "quo_1" },
            }) as unknown as Record<string, unknown>,
          },
        }),
      ],
    ];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow({ confirmedAt: new Date() })]];
    store.insertReturns["bookings"] = [bookingRow()];
    store.selectQueues["users"] = [[{ id: 7, email: "philipsubhan@gmail.com" }]];
    store.insertReturns["accommodations"] = [{ id: 55 }];
    store.updateReturns["bookings"] = [bookingRow({ status: "confirmed" })];

    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(true);
    expect(result.booking?.status).toBe("confirmed");

    // The booking create went out exactly once, against the BOUNDARY
    // quote, with vault-built guests and the account email/phone.
    expect(stays.createBooking).toHaveBeenCalledTimes(1);
    const bookingCall = stays.createBooking.mock.calls[0][0] as {
      quoteId: string;
      guests: unknown[];
      email: string;
      phoneNumber: string;
    };
    expect(bookingCall.quoteId).toBe("quo_2");
    expect(bookingCall.guests).toEqual([
      { givenName: "Philip", familyName: "Subhan", bornOn: "1958-10-01" },
    ]);
    expect(bookingCall.email).toBe("philipsubhan@gmail.com");
    expect(bookingCall.phoneNumber).toBe("+16095550100");

    // Vault discipline: one read, purpose booking_execution, real
    // ledger booking id, exactly the passenger field set.
    expect(readProfileCalls).toHaveLength(1);
    expect(readProfileCalls[0]).toMatchObject({
      userId: 7,
      purpose: "booking_execution",
      bookingId: 99,
    });

    // Ledger + projection exactly once each.
    expect(opsOn("bookings")).toHaveLength(1);
    const accInserts = opsOn("accommodations");
    expect(accInserts).toHaveLength(1);
    expect(accInserts[0].values).toMatchObject({
      name: "Hotel Beispiel",
      address: "Leopoldstrasse 10",
      checkIn: "2026-12-03",
      checkOut: "2026-12-08",
      type: "hotel",
      totalPrice: "840.00",
      currency: "EUR",
      confirmationCode: "HTLREF1",
    });
    const bookingUpdate = opsOn("bookings", "update")[0];
    expect(bookingUpdate.set).toMatchObject({
      status: "confirmed",
      accommodationId: 55,
      providerOrderId: "bok_1",
      projection: { accommodationIds: [55] },
    });

    // Commission: expected, NO amount — the profit share is never invented.
    const commission = opsOn("commission_records")[0];
    expect(commission.values).toMatchObject({
      partnerProgram: "duffel_stays",
      status: "expected",
      expectedAmountMinor: null,
      rateBps: null,
    });
    // Splits: one traveler → one full share in the charge currency.
    const splits = opsOn("booking_splits");
    expect(splits).toHaveLength(1);
    expect(splits[0].values).toMatchObject({ shareAmountMinor: 84000, shareCurrency: "EUR" });
  });

  it("a quote with NO delta books after one confirmation", async () => {
    const stays = fakeStaysClient(["800.00", "800.00"]);
    const gate = makeGate({ staysClient: stays.client });

    queueParticipant();
    store.insertReturns["booking_attempts"] = [attemptRow()];
    await gate.createAttempt({
      userId: 7,
      role: "user",
      tripId: 3,
      option: stayOption(),
      coveredTravelers: [{ userId: 7, isPayer: true }],
    });

    store.selectQueues["booking_attempts"] = [[attemptRow()]];
    queueParticipant();
    const review = await gate.beginReview(42, ACTOR);
    expect(review.outcome).toBe("same");
    expect(review.deltaText).toBeUndefined();

    store.selectQueues["booking_attempts"] = [
      [attemptRow({ state: "review", reviewedAmountMinor: 80000, reviewedCurrency: "EUR" })],
    ];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow()]];
    const confirm = await gate.confirmAttempt(42, ACTOR);
    expect(confirm.confirmed).toBe(true);

    store.selectQueues["booking_attempts"] = [
      [
        attemptRow({
          state: "confirmed",
          reviewedAmountMinor: 80000,
          reviewedCurrency: "EUR",
          confirmedByUserId: 7,
          confirmedAt: new Date(),
        }),
      ],
    ];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow({ confirmedAt: new Date() })]];
    store.insertReturns["bookings"] = [bookingRow({ chargeAmountMinor: 80000 })];
    store.selectQueues["users"] = [[{ id: 7, email: "philipsubhan@gmail.com" }]];
    store.insertReturns["accommodations"] = [{ id: 56 }];
    store.updateReturns["bookings"] = [bookingRow({ status: "confirmed", chargeAmountMinor: 80000 })];

    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(true);
    expect(stays.createBooking).toHaveBeenCalledTimes(1);
    expect(opsOn("accommodations")[0].values).toMatchObject({ totalPrice: "800.00" });
  });

  it("an option without a rate reference is unverifiable at review — nothing is quoted or booked", async () => {
    const stays = fakeStaysClient(["800.00"]);
    const gate = makeGate({ staysClient: stays.client });

    queueParticipant();
    store.insertReturns["booking_attempts"] = [attemptRow()];
    await gate.createAttempt({
      userId: 7,
      role: "user",
      tripId: 3,
      option: stayOption({ summary: { rateId: null } }),
      coveredTravelers: [{ userId: 7, isPayer: true }],
    });

    store.selectQueues["booking_attempts"] = [
      [attemptRow({ optionSnapshot: { option: stayOption({ summary: { rateId: null } }) as unknown as Record<string, unknown> } })],
    ];
    queueParticipant();
    const review = await gate.beginReview(42, ACTOR);
    expect(review.outcome).toBe("unverifiable");
    expect(review.attempt.state).toBe("presented");
    expect(stays.createQuote).not.toHaveBeenCalled();
    expect(stays.createBooking).not.toHaveBeenCalled();
  });

  it("a profile gap fails execution BEFORE any provider booking call — no itinerary rows", async () => {
    const stays = fakeStaysClient(["800.00"]);
    const gate = makeGate({
      staysClient: stays.client,
      profile: { ...PROFILE, date_of_birth: null },
    });

    store.selectQueues["booking_attempts"] = [
      [
        attemptRow({
          state: "confirmed",
          reviewedAmountMinor: 80000,
          reviewedCurrency: "EUR",
          confirmedByUserId: 7,
          confirmedAt: new Date(),
        }),
      ],
    ];
    queueParticipant();
    store.selectQueues["booking_attempt_travelers"] = [[coverageRow({ confirmedAt: new Date() })]];
    store.insertReturns["bookings"] = [bookingRow({ chargeAmountMinor: 80000 })];

    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.attempt.state).toBe("failed");
    expect(result.reason).toMatch(/date of birth/);
    expect(stays.createBooking).not.toHaveBeenCalled();
    expect(opsOn("accommodations")).toHaveLength(0);
    // The ledger row exists and is marked failed — written, not phantom.
    const bookingUpdate = opsOn("bookings", "update")[0];
    expect(bookingUpdate.set).toMatchObject({ status: "failed" });
  });

  it("with no stays client configured, execution refuses plainly and the attempt stays confirmed", async () => {
    const gate = makeGate({ staysClient: null });
    store.selectQueues["booking_attempts"] = [
      [
        attemptRow({
          state: "confirmed",
          reviewedAmountMinor: 80000,
          reviewedCurrency: "EUR",
          confirmedByUserId: 7,
          confirmedAt: new Date(),
        }),
      ],
    ];
    queueParticipant();

    const result = await gate.executeAttempt(42, ACTOR);
    expect(result.executed).toBe(false);
    expect(result.reason).toMatch(/DUFFEL_API_TOKEN/);
    expect(result.attempt.state).toBe("confirmed");
    expect(opsOn("bookings")).toHaveLength(0);
  });
});

describe("stayQuoteToRequoteInfo — quote honesty", () => {
  it("drops a broken fee split to base + combined remainder, refreshes terms from the quote timeline", () => {
    const info = stayQuoteToRequoteInfo(
      {
        id: "quo_9",
        total_amount: "840.00",
        total_currency: "EUR",
        base_amount: "700.00",
        base_currency: "EUR",
        tax_amount: "60.00",
        tax_currency: "EUR",
        fee_amount: "99.00", // 700+60+99 ≠ 840 — the split is not trusted
        fee_currency: "EUR",
        cancellation_timeline: [
          { refund_amount: "840.00", currency: "EUR", before: "2026-12-01T00:00:00Z" },
        ],
      },
      stayOption(),
      "2026-11-18T10:00:00Z",
    );
    expect(info.outcome).toBe("changed");
    const fresh = info.option as StayOption;
    expect(fresh.priceNature).toBe("firm");
    expect(fresh.summary.quoteId).toBe("quo_9");
    expect(fresh.summary.breakdown.tax).toBeNull();
    expect(fresh.summary.breakdown.fee).toBeNull();
    expect(fresh.summary.breakdown.taxesAndFees).toEqual(money(14000, "EUR"));
    expect(fresh.summary.cancellationTerms).toBe("Free cancellation until 2026-12-01");
    expect(fresh.summary.freeCancellation).toBe(true);
  });

  it("an unquotable payload (no id / unparseable total) is unavailable, never repaired", () => {
    expect(
      stayQuoteToRequoteInfo({ total_amount: "840.00", total_currency: "EUR" }, stayOption(), "2026-11-18T10:00:00Z").outcome,
    ).toBe("unavailable");
    expect(
      stayQuoteToRequoteInfo({ id: "quo_1", total_amount: "abc", total_currency: "EUR" }, stayOption(), "2026-11-18T10:00:00Z").outcome,
    ).toBe("unavailable");
  });
});
