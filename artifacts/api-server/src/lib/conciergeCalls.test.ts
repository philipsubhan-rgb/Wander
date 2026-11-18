/**
 * ConciergeCallService — the call discipline end to end, against a
 * recording DB mock with fake telephony / card / vault / calendar
 * dependencies:
 *
 *   no brief, no call · unconfirmed brief cannot dial · voice cannot
 *   confirm a spend brief (zero writes) · spend-cap enforcement
 *   (over-cap never books) · confirmation code verbatim / absent ·
 *   virtual-card sentinel scan (details in NO stored op or log) ·
 *   concierge visibility defaults · info-only outcome claiming a
 *   booking rejected · change/cancel write-back · retry/escalation ·
 *   cost estimate on the task record.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Recording DB mock (the bookingGate.test.ts pattern) ────────────────────

const hoisted = vi.hoisted(() => {
  const ops: Array<{ kind: string; table: string; values?: unknown; set?: unknown }> = [];
  const selectQueues: Record<string, unknown[][]> = {};
  const insertReturns: Record<string, unknown[]> = {};
  const updateReturns: Record<string, unknown[]> = {};

  function makeChain(ctx: { table: string; kind: string }) {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = self;
    chain.where = self;
    chain.orderBy = self;
    chain.limit = self;
    chain.offset = self;
    chain.innerJoin = self;
    chain.leftJoin = self;
    chain.groupBy = self;
    chain.set = (set: unknown) => {
      ops.push({ kind: ctx.kind, table: ctx.table, set });
      return chain;
    };
    chain.values = (values: unknown) => {
      ops.push({ kind: ctx.kind, table: ctx.table, values });
      return chain;
    };
    chain.returning = self;
    chain.onConflictDoNothing = self;
    chain.onConflictDoUpdate = self;
    chain.then = (
      resolve: (v: unknown) => void,
      reject?: (e: unknown) => void,
    ) => {
      const result =
        ctx.kind === "select"
          ? (selectQueues[ctx.table] ?? []).shift() ?? []
          : ctx.kind === "insert"
            ? (insertReturns[ctx.table] ?? [])
            : ctx.kind === "update"
              ? (updateReturns[ctx.table] ?? [])
              : [];
      return Promise.resolve(result).then(resolve, reject);
    };
    return chain;
  }

  const mockDb = {
    select: () => ({ from: (t: { __table: string }) => makeChain({ table: t.__table, kind: "select" }) }),
    insert: (t: { __table: string }) => makeChain({ table: t.__table, kind: "insert" }),
    update: (t: { __table: string }) => makeChain({ table: t.__table, kind: "update" }),
    delete: (t: { __table: string }) => makeChain({ table: t.__table, kind: "delete" }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(mockDb),
  };

  return { ops, selectQueues, insertReturns, updateReturns, mockDb };
});

const store = hoisted;
const mockDb = hoisted.mockDb;

function table(name: string) {
  return { __table: name };
}

vi.mock("drizzle-orm", () => {
  const op =
    (name: string) =>
    (...args: unknown[]) => ({ __op: name, args });
  return {
    and: op("and"), or: op("or"), eq: op("eq"), ne: op("ne"), gt: op("gt"),
    gte: op("gte"), lt: op("lt"), lte: op("lte"), inArray: op("inArray"),
    notInArray: op("notInArray"), isNull: op("isNull"), isNotNull: op("isNotNull"),
    asc: op("asc"), desc: op("desc"), sql: op("sql"),
  };
});

vi.mock("@workspace/db", () => ({
  db: hoisted.mockDb,
  callBriefsTable: table("call_briefs"),
  callTasksTable: table("call_tasks"),
  bookingsTable: table("bookings"),
  bookingTravelersTable: table("booking_travelers"),
  bookingSplitsTable: table("booking_splits"),
  commissionRecordsTable: table("commission_records"),
  reservationsTable: table("reservations"),
  tripsTable: table("trips"),
  tripParticipantsTable: table("trip_participants"),
  extrasSuggestionsTable: table("extras_suggestions"),
  bookingAttemptsTable: table("booking_attempts"),
  bookingAttemptTravelersTable: table("booking_attempt_travelers"),
  usersTable: table("users"),
  travelerProfilesTable: table("traveler_profiles"),
  profileAccessLogTable: table("profile_access_log"),
  tripRosterEntriesTable: table("trip_roster_entries"),
  connectedAccountsTable: table("connected_accounts"),
  calendarEventLinksTable: table("calendar_event_links"),
}));

import {
  CallRefused,
  ConciergeCallService,
  type ConciergeCallDeps,
} from "./conciergeCalls";
import { logger } from "./logger";
import type { TelephonyProvider } from "./telephony";
import type { PaymentInstrumentProvider } from "./virtualCards";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const ACTOR = { userId: 7, role: "user" };

function briefRow(over: Record<string, unknown> = {}) {
  return {
    id: 11, tripId: 3, bookingAttemptId: null, bookingId: null, extrasSuggestionId: null,
    kind: "book", state: "confirmed", category: null, visibility: "shared",
    calleeName: "Le Comptoir", calleePhone: "+33142000000",
    travelerUserId: 7, travelerNameOnReservation: "Philip Subhan", coveredUserIds: [7],
    ask: "Book a table for 4", reservationRefs: [] as string[], partySize: 4,
    serviceDate: "2026-12-10", serviceTimeWindow: "19:00",
    fallbacks: [] as string[], mayNotAgree: [] as string[], authorityKind: "spend",
    authorityLimitAmountMinor: 20_000, authorityLimitCurrency: "USD",
    toleranceAmountMinor: 0, paymentMayBeRequired: false,
    durationCapSeconds: 600, callbackNumber: "+15550100",
    version: 1, supersedesBriefId: null, createdByUserId: 7,
    presentedAt: null, confirmedByUserId: 7, confirmedAt: new Date(),
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

function taskRow(over: Record<string, unknown> = {}) {
  return {
    id: 21, briefId: 11, tripId: 3, state: "calling", attemptNumber: 1,
    provider: "twilio", providerCallId: "CA1", providerStatus: "in-progress",
    paymentInstrumentRef: null, startedAt: new Date(), endedAt: null,
    durationSeconds: null, telephonyCostMinor: null, telephonyCostCurrency: null,
    recordingRef: null, transcript: null, outcome: null, outcomeText: null,
    bookingId: null, failureReason: null,
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

function bookingRow(over: Record<string, unknown> = {}) {
  return {
    id: 77, tripId: 3, attemptId: null, kind: "restaurant", supplier: "Le Comptoir",
    confirmationCode: "OLD1", status: "confirmed", source: "phone",
    chargeAmountMinor: 10_000, chargeCurrency: "USD",
    homeAmountMinor: null, homeCurrency: null, fxSnapshotId: null,
    amountActuallyChargedMinor: null, merchantOfRecord: "Le Comptoir",
    changeTerms: null, cancelTerms: null,
    whyThisOption: "traveler_chose", whyThisOptionText: null, rankingInputsHash: null,
    visibility: "shared", flightId: null, accommodationId: null, reservationId: 55,
    carRentalId: null, projection: null, providerOrderId: null,
    flightawareIdent: null, flightawareAlertId: null, costAttribution: {},
    createdAt: new Date(), updatedAt: new Date(),
    ...over,
  };
}

// ─── Fake dependencies ───────────────────────────────────────────────────────

const SENTINEL_PAN = "SENTINELPAN4111111111";
const SENTINEL_CVC = "SENTINELCVC";

function makeDeps(over: Partial<ConciergeCallDeps> = {}): {
  deps: ConciergeCallDeps;
  createCall: ReturnType<typeof vi.fn>;
  issueCard: ReturnType<typeof vi.fn>;
  readProfile: ReturnType<typeof vi.fn>;
  syncReservation: ReturnType<typeof vi.fn>;
  deleteReservationCalendar: ReturnType<typeof vi.fn>;
  updateReservationCalendar: ReturnType<typeof vi.fn>;
} {
  const createCall = vi.fn(async () => ({ providerCallId: "CA1", status: "queued" }));
  const provider: TelephonyProvider = { id: "twilio", createCall };
  const issueCard = vi.fn(async () => ({
    instrumentRef: "vi_test_ref_1",
    pan: SENTINEL_PAN,
    expiryMonth: 12,
    expiryYear: 2027,
    cvc: SENTINEL_CVC,
    brand: "visa",
    limit: { amountMinor: 21_000, currency: "USD" },
  }));
  const cardProvider: PaymentInstrumentProvider = { id: "stripe_issuing", issueSingleUseCard: issueCard };
  const readProfile = vi.fn(async () => ({
    legal_first_name: "Philip",
    legal_middle_name: null,
    legal_last_name: "Subhan",
    phone: "+16095550100",
  }));
  const syncReservation = vi.fn(async () => undefined);
  const deleteReservationCalendar = vi.fn(async () => undefined);
  const updateReservationCalendar = vi.fn(async () => undefined);
  const deps: ConciergeCallDeps = {
    telephony: {
      provider,
      fromNumber: "+15550100",
      callUrl: "https://example.test/voice",
      statusCallbackUrl: null,
    },
    cardProvider,
    readProfile: readProfile as unknown as ConciergeCallDeps["readProfile"],
    syncReservation,
    deleteReservationCalendar,
    updateReservationCalendar,
    ...over,
  };
  return { deps, createCall, issueCard, readProfile, syncReservation, deleteReservationCalendar, updateReservationCalendar };
}

function enqueueParticipant() {
  store.selectQueues["trip_participants"] = [[{ id: 1 }]];
}

function insertsInto(tableName: string) {
  return store.ops.filter((o) => o.kind === "insert" && o.table === tableName);
}

function updatesTo(tableName: string) {
  return store.ops.filter((o) => o.kind === "update" && o.table === tableName);
}

beforeEach(() => {
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
});

// ─── prepareBrief ────────────────────────────────────────────────────────────

describe("prepareBrief", () => {
  it("stores a draft brief with the traveler's name read from the vault (call_execution purpose)", async () => {
    const { deps, readProfile } = makeDeps();
    const service = new ConciergeCallService(deps);
    enqueueParticipant();
    const stored = briefRow({ id: 11, state: "draft", confirmedByUserId: null, confirmedAt: null });
    store.insertReturns["call_briefs"] = [stored];

    const brief = await service.prepareBrief(
      {
        tripId: 3, kind: "book", calleeName: "Le Comptoir", calleePhone: "+33142000000",
        ask: "Book a table for 4", partySize: 4, serviceDate: "2026-12-10",
        authorityLimit: { amountMinor: 20_000, currency: "USD" },
      },
      ACTOR,
    );

    expect(brief.id).toBe(11);
    expect(readProfile).toHaveBeenCalledWith(
      7,
      ["legal_first_name", "legal_middle_name", "legal_last_name", "phone"],
      { kind: "agent" },
      "call_execution",
    );
    const insert = insertsInto("call_briefs")[0]!;
    const values = insert.values as Record<string, unknown>;
    expect(values.state).toBe("draft");
    expect(values.travelerNameOnReservation).toBe("Philip Subhan");
    expect(values.authorityKind).toBe("spend");
    expect(values.authorityLimitAmountMinor).toBe(20_000);
    expect(values.callbackNumber).toBe("+15550100"); // telephony from-number default
  });

  it("a nightlife brief defaults to private visibility; a restaurant brief to shared", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    enqueueParticipant();
    store.insertReturns["call_briefs"] = [briefRow({ state: "draft" })];
    await service.prepareBrief(
      {
        tripId: 3, kind: "book", category: "nightlife", calleeName: "Club Nuit",
        calleePhone: "+15550200", ask: "Reserve a table", partySize: 2,
        serviceDate: "2026-12-10", authorityLimit: { amountMinor: 30_000, currency: "USD" },
      },
      ACTOR,
    );
    const values = insertsInto("call_briefs")[0]!.values as Record<string, unknown>;
    expect(values.visibility).toBe("private");
  });

  it("an info brief stores NO cap even when one is offered", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    enqueueParticipant();
    store.insertReturns["call_briefs"] = [briefRow({ state: "draft" })];
    await service.prepareBrief(
      {
        tripId: 3, kind: "info", calleeName: "Le Comptoir", calleePhone: "+33142000000",
        ask: "Ask about opening hours", authorityKind: "info_only",
        authorityLimit: { amountMinor: 5_000, currency: "USD" },
      },
      ACTOR,
    );
    const values = insertsInto("call_briefs")[0]!.values as Record<string, unknown>;
    expect(values.authorityKind).toBe("info_only");
    expect(values.authorityLimitAmountMinor).toBeNull();
    expect(values.authorityLimitCurrency).toBeNull();
  });

  it("seeds the cap from a gate attempt's reviewed total when none is given", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    enqueueParticipant();
    store.selectQueues["booking_attempts"] = [
      [{ id: 31, tripId: 3, state: "review", category: null, reviewedAmountMinor: 45_000, reviewedCurrency: "EUR", presentedAmountMinor: 44_000, presentedCurrency: "EUR" }],
    ];
    store.selectQueues["booking_attempt_travelers"] = [[{ userId: 7 }, { userId: 9 }]];
    store.insertReturns["call_briefs"] = [briefRow({ state: "draft" })];
    await service.prepareBrief(
      {
        tripId: 3, kind: "book", calleeName: "Hotel Sacher", calleePhone: "+4315121555",
        ask: "Book the suite by phone", partySize: 2, serviceDate: "2026-12-10",
        bookingAttemptId: 31,
      },
      ACTOR,
    );
    const values = insertsInto("call_briefs")[0]!.values as Record<string, unknown>;
    expect(values.authorityLimitAmountMinor).toBe(45_000);
    expect(values.authorityLimitCurrency).toBe("EUR");
    expect(values.coveredUserIds).toEqual([7, 9]);
  });

  it("refuses to seed from an extras suggestion that was never accepted", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    enqueueParticipant();
    store.selectQueues["extras_suggestions"] = [
      [{ id: 41, tripId: 3, state: "suggested", title: "Tee times", detail: null }],
    ];
    await expect(
      service.prepareBrief(
        {
          tripId: 3, kind: "book", calleeName: "Golf Club", calleePhone: "+15550300",
          ask: "", extrasSuggestionId: 41,
          authorityLimit: { amountMinor: 10_000, currency: "USD" },
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(CallRefused);
    expect(insertsInto("call_briefs")).toHaveLength(0);
  });
});

// ─── confirmBrief — the voice rule ───────────────────────────────────────────

describe("confirmBrief", () => {
  it("confirms a spend brief on the text channel", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow({ state: "draft", confirmedByUserId: null })]];
    enqueueParticipant();
    store.updateReturns["call_briefs"] = [briefRow({ state: "confirmed" })];
    const result = await service.confirmBrief(11, { ...ACTOR, channel: "text" });
    expect(result.confirmed).toBe(true);
    expect(updatesTo("call_briefs")).toHaveLength(1);
  });

  it("a SPEND brief cannot be confirmed by voice — refused BEFORE any write", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow({ state: "draft", confirmedByUserId: null })]];
    enqueueParticipant();
    const result = await service.confirmBrief(11, { ...ACTOR, channel: "voice" });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/Voice can't confirm a brief that authorizes spending/);
    // Zero writes of any kind.
    expect(store.ops.filter((o) => o.kind !== "select")).toHaveLength(0);
  });

  it("an info-only brief CAN be confirmed by voice (it authorizes no spend)", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [
      [briefRow({ state: "draft", confirmedByUserId: null, kind: "info", authorityKind: "info_only", authorityLimitAmountMinor: null, authorityLimitCurrency: null })],
    ];
    enqueueParticipant();
    store.updateReturns["call_briefs"] = [briefRow({ state: "confirmed" })];
    const result = await service.confirmBrief(11, { ...ACTOR, channel: "voice" });
    expect(result.confirmed).toBe(true);
  });

  it("a superseded brief cannot be confirmed", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow({ state: "superseded" })]];
    enqueueParticipant();
    const result = await service.confirmBrief(11, ACTOR);
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/superseded/);
  });
});

// ─── placeCall — no brief, no call ───────────────────────────────────────────

describe("placeCall", () => {
  it("refuses to dial an UNCONFIRMED (draft) brief — provider never invoked", async () => {
    const { deps, createCall } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow({ state: "draft", confirmedByUserId: null, confirmedAt: null })]];
    enqueueParticipant();
    const result = await service.placeCall(11, ACTOR);
    expect(result.placed).toBe(false);
    expect(result.reason).toMatch(/hasn't been confirmed/);
    expect(createCall).not.toHaveBeenCalled();
    expect(insertsInto("call_tasks")).toHaveLength(0);
  });

  it("refuses to dial an INCOMPLETE confirmed brief (no callback number) — no brief, no call", async () => {
    const { deps, createCall } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow({ callbackNumber: null })]];
    enqueueParticipant();
    const result = await service.placeCall(11, ACTOR);
    expect(result.placed).toBe(false);
    expect(result.reason).toMatch(/callback number/);
    expect(createCall).not.toHaveBeenCalled();
  });

  it("says plainly when telephony is not configured — nothing is called", async () => {
    const { deps } = makeDeps({
      telephony: { provider: null, fromNumber: null, callUrl: null, statusCallbackUrl: null },
    });
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow()]];
    enqueueParticipant();
    const result = await service.placeCall(11, ACTOR);
    expect(result.placed).toBe(false);
    expect(result.reason).toMatch(/Telephony isn't configured/);
    expect(insertsInto("call_tasks")).toHaveLength(0);
  });

  it("dials a confirmed complete brief with the duration cap as the provider limit", async () => {
    const { deps, createCall } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow()]];
    enqueueParticipant();
    store.selectQueues["call_tasks"] = [[]];
    store.insertReturns["call_tasks"] = [taskRow({ state: "queued", providerCallId: null, providerStatus: null })];
    store.updateReturns["call_tasks"] = [taskRow()];
    const result = await service.placeCall(11, ACTOR);
    expect(result.placed).toBe(true);
    expect(createCall).toHaveBeenCalledTimes(1);
    const input = (createCall.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(input.to).toBe("+33142000000");
    expect(input.timeLimitSeconds).toBe(600);
    expect(input.record).toBe(true);
    expect(input.machineDetection).toBe(true);
  });

  it("refuses past the retry policy's attempt cap with escalation copy", async () => {
    const { deps, createCall } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow()]];
    enqueueParticipant();
    store.selectQueues["call_tasks"] = [
      [taskRow({ id: 21 }), taskRow({ id: 22 }), taskRow({ id: 23 })],
    ];
    const result = await service.placeCall(11, ACTOR);
    expect(result.placed).toBe(false);
    expect(result.reason).toMatch(/3 call attempts/);
    expect(createCall).not.toHaveBeenCalled();
  });
});

// ─── Payment on calls — the sentinel scan ────────────────────────────────────

describe("payment on calls (single-use virtual card)", () => {
  it("issues a capped card whose details NEVER reach the task row, any stored op, or any log line", async () => {
    const logCalls: unknown[][] = [];
    const spies = (["info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logCalls.push(args);
      }) as never),
    );
    try {
      const { deps, issueCard } = makeDeps();
      const service = new ConciergeCallService(deps);
      store.selectQueues["call_briefs"] = [
        [briefRow({ paymentMayBeRequired: true, toleranceAmountMinor: 1_000 })],
      ];
      enqueueParticipant();
      store.selectQueues["call_tasks"] = [[]];
      store.insertReturns["call_tasks"] = [taskRow({ state: "queued", providerCallId: null, providerStatus: null, paymentInstrumentRef: "vi_test_ref_1" })];
      store.updateReturns["call_tasks"] = [taskRow({ paymentInstrumentRef: "vi_test_ref_1" })];

      const result = await service.placeCall(11, ACTOR);
      expect(result.placed).toBe(true);
      // The live session receives the details exactly once…
      expect(result.cardDetails?.pan).toBe(SENTINEL_PAN);
      // …issued at cap + the stated tolerance, never more.
      const cardInput = (issueCard.mock.calls[0] as unknown[])[0] as {
        limit: { amountMinor: number; currency: string };
      };
      expect(cardInput.limit).toEqual({ amountMinor: 21_000, currency: "USD" });
      // The stored task carries ONLY the reference.
      const taskInsert = insertsInto("call_tasks")[0]!;
      expect((taskInsert.values as Record<string, unknown>).paymentInstrumentRef).toBe("vi_test_ref_1");
      // The sentinel scan: every recorded DB op and every log call.
      const opsJson = JSON.stringify(store.ops);
      const logsJson = JSON.stringify(logCalls);
      expect(opsJson).not.toContain("SENTINELPAN");
      expect(opsJson).not.toContain("SENTINELCVC");
      expect(logsJson).not.toContain("SENTINELPAN");
      expect(logsJson).not.toContain("SENTINELCVC");
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("refuses to dial a card-requiring brief with no card provider — never falls back to a real card", async () => {
    const { deps, createCall } = makeDeps({ cardProvider: null });
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow({ paymentMayBeRequired: true })]];
    enqueueParticipant();
    store.selectQueues["call_tasks"] = [[]];
    const result = await service.placeCall(11, ACTOR);
    expect(result.placed).toBe(false);
    expect(result.reason).toMatch(/never reads out a traveler's real card/);
    expect(createCall).not.toHaveBeenCalled();
  });
});

// ─── recordOutcome — write-back discipline ───────────────────────────────────

function setupOutcomeRun(briefOver: Record<string, unknown> = {}, taskOver: Record<string, unknown> = {}) {
  store.selectQueues["call_tasks"] = [[taskRow(taskOver)]];
  store.selectQueues["call_briefs"] = [[briefRow(briefOver)], [briefRow(briefOver)]];
  store.updateReturns["call_tasks"] = [taskRow({ state: "completed" })];
}

describe("recordOutcome", () => {
  it("a booking within the cap writes the ledger booking (channel: phone) with the confirmation code VERBATIM", async () => {
    const { deps, syncReservation } = makeDeps();
    const service = new ConciergeCallService(deps);
    setupOutcomeRun();
    store.updateReturns["call_tasks"] = [taskRow({ state: "completed", bookingId: 91 })];
    store.insertReturns["bookings"] = [bookingRow({ id: 91, confirmationCode: "LCT-8842-X" })];
    store.insertReturns["reservations"] = [{ id: 55, tripId: 3 }];
    store.updateReturns["bookings"] = [bookingRow({ id: 91, confirmationCode: "LCT-8842-X" })];
    store.selectQueues["bookings"] = [[bookingRow({ id: 91, confirmationCode: "LCT-8842-X" })]];

    const result = await service.recordOutcome(21, {
      outcome: {
        disposition: "booked",
        personSpokenTo: "Marie",
        confirmationCode: "LCT-8842-X",
        agreedAmountMinor: 18_000,
        agreedCurrency: "USD",
        agreedTerms: "Free cancellation until 18:00 on the day",
        serviceTime: "19:30",
      },
      transcript: [
        { speaker: "agent", text: "Bonjour, I'd like to book a table for four." },
        { speaker: "callee", text: "Confirmed — your reference is LCT-8842-X." },
      ],
      durationSeconds: 480,
    });

    expect(result.alreadyRecorded).toBeFalsy();
    expect(result.booking?.id).toBe(91);
    const bookingInsert = insertsInto("bookings")[0]!;
    const bv = bookingInsert.values as Record<string, unknown>;
    expect(bv.source).toBe("phone");
    expect(bv.confirmationCode).toBe("LCT-8842-X");
    expect(bv.chargeAmountMinor).toBe(18_000);
    expect(bv.status).toBe("confirmed");
    // Splits + coverage + the honest commission record.
    expect(insertsInto("booking_travelers")).toHaveLength(1);
    expect(insertsInto("booking_splits")).toHaveLength(1);
    const commission = insertsInto("commission_records")[0]!.values as Record<string, unknown>;
    expect(commission.status).toBe("no_rail");
    expect(commission.noRailReason).toBe("phone_booking_no_commission_rail");
    // Itinerary projection + calendar write-back through the reservation hook.
    const resInsert = insertsInto("reservations")[0]!;
    const rv = resInsert.values as Record<string, unknown>;
    expect(rv.confirmationCode).toBe("LCT-8842-X");
    expect(rv.date).toBe("2026-12-10");
    expect(rv.time).toBe("19:30");
    expect(syncReservation).toHaveBeenCalledTimes(1);
    // The task records the outcome, the transcript, and the cost estimate.
    const taskUpdate = updatesTo("call_tasks")[0]!;
    const tv = taskUpdate.set as Record<string, unknown>;
    expect(tv.bookingId).toBe(91);
    expect(tv.telephonyCostMinor).toBe(80); // 8 min at published rates = the ROI $0.80
    expect(tv.telephonyCostCurrency).toBe("USD");
    expect(JSON.stringify(tv.transcript)).toContain("LCT-8842-X");
    expect(result.evaluation.action).toBe("book");
  });

  it("an ABSENT confirmation code is recorded as absent — never invented", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    setupOutcomeRun();
    store.insertReturns["bookings"] = [bookingRow({ id: 92, confirmationCode: null })];
    store.insertReturns["reservations"] = [{ id: 56, tripId: 3 }];
    store.updateReturns["bookings"] = [bookingRow({ id: 92, confirmationCode: null })];
    store.selectQueues["bookings"] = [[bookingRow({ id: 92, confirmationCode: null })]];

    const result = await service.recordOutcome(21, {
      outcome: { disposition: "booked", personSpokenTo: "Marie", agreedAmountMinor: 12_000, agreedCurrency: "USD" },
    });

    const bv = insertsInto("bookings")[0]!.values as Record<string, unknown>;
    expect(bv.confirmationCode).toBeNull();
    const rv = insertsInto("reservations")[0]!.values as Record<string, unknown>;
    expect(rv.confirmationCode).toBeNull();
    expect(String(rv.notes)).toMatch(/No confirmation code was given/);
    const taskSet = updatesTo("call_tasks")[0]!.set as Record<string, unknown>;
    expect(taskSet.outcomeText).toMatch(/gave no confirmation code/);
  });

  it("an over-cap outcome NEVER books — the attempt escalates with the offered price surfaced", async () => {
    const { deps, syncReservation } = makeDeps();
    const service = new ConciergeCallService(deps);
    setupOutcomeRun();
    store.updateReturns["call_tasks"] = [taskRow({ state: "escalated" })];

    const result = await service.recordOutcome(21, {
      outcome: {
        disposition: "booked",
        personSpokenTo: "Marie",
        confirmationCode: "SHOULD-NOT-BE-USED",
        agreedAmountMinor: 25_000,
        agreedCurrency: "USD",
      },
    });

    expect(result.evaluation.action).toBe("over_cap");
    expect(result.booking).toBeUndefined();
    expect(insertsInto("bookings")).toHaveLength(0);
    expect(insertsInto("reservations")).toHaveLength(0);
    expect(syncReservation).not.toHaveBeenCalled();
    expect(result.task.state).toBe("escalated");
    const taskSet = updatesTo("call_tasks")[0]!.set as Record<string, unknown>;
    expect(taskSet.outcomeText).toContain("$250.00");
    expect(taskSet.outcomeText).toMatch(/new brief and a fresh confirmation/);
    // The venue's code never reaches a booking, the ledger, or the
    // itinerary (it survives only inside the raw outcome report on
    // the attempt record itself, as evidence of what was offered).
    const bookingSideOps = store.ops.filter(
      (o) => o.table === "bookings" || o.table === "reservations",
    );
    expect(JSON.stringify(bookingSideOps)).not.toContain("SHOULD-NOT-BE-USED");
  });

  it("a cross-currency outcome against the cap also never books", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    setupOutcomeRun();
    store.updateReturns["call_tasks"] = [taskRow({ state: "escalated" })];
    const result = await service.recordOutcome(21, {
      outcome: { disposition: "booked", agreedAmountMinor: 100, agreedCurrency: "EUR" },
    });
    expect(result.evaluation.action).toBe("over_cap");
    expect(insertsInto("bookings")).toHaveLength(0);
  });

  it("an info-only call claiming a booking is REJECTED — nothing books, the claim is on the record", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    setupOutcomeRun({
      kind: "info", authorityKind: "info_only",
      authorityLimitAmountMinor: null, authorityLimitCurrency: null,
      partySize: null, serviceDate: null,
    });
    const result = await service.recordOutcome(21, {
      outcome: { disposition: "booked", agreedAmountMinor: 5_000, agreedCurrency: "USD", confirmationCode: "FAKE1" },
    });
    expect(result.evaluation.action).toBe("rejected_claim");
    expect(insertsInto("bookings")).toHaveLength(0);
    expect(result.task.state).toBe("completed");
    const taskSet = updatesTo("call_tasks")[0]!.set as Record<string, unknown>;
    expect(taskSet.outcomeText).toMatch(/information-only/);
  });

  it("a no-answer fails retryable at attempt 1 with the stated spacing; at attempt 3 it escalates", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    setupOutcomeRun();
    store.updateReturns["call_tasks"] = [taskRow({ state: "failed" })];
    const first = await service.recordOutcome(21, { outcome: { disposition: "no_answer" } });
    expect(first.task.state).toBe("failed");
    const firstSet = updatesTo("call_tasks")[0]!.set as Record<string, unknown>;
    expect(firstSet.outcomeText).toMatch(/Attempt 1 of 3/);
    expect(firstSet.outcomeText).toMatch(/30 minutes/);

    store.ops.length = 0;
    setupOutcomeRun({}, { attemptNumber: 3 });
    store.updateReturns["call_tasks"] = [taskRow({ state: "escalated", attemptNumber: 3 })];
    const third = await service.recordOutcome(21, { outcome: { disposition: "voicemail" } });
    expect(third.task.state).toBe("escalated");
    const thirdSet = updatesTo("call_tasks")[0]!.set as Record<string, unknown>;
    expect(thirdSet.outcomeText).toMatch(/escalates to you/);
  });

  it("a special request noted-not-guaranteed is recorded as NOTED — never as guaranteed", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    setupOutcomeRun({ kind: "special_request", bookingId: 77 });
    const result = await service.recordOutcome(21, {
      outcome: {
        disposition: "request_noted",
        requestOutcome: "noted_not_guaranteed",
        personSpokenTo: "the concierge desk",
      },
    });
    expect(result.task.state).toBe("completed");
    const taskSet = updatesTo("call_tasks")[0]!.set as Record<string, unknown>;
    expect(taskSet.outcomeText).toMatch(/NOT guaranteed/);
    expect(insertsInto("bookings")).toHaveLength(0);
    expect(updatesTo("bookings")).toHaveLength(0);
  });

  it("a change outcome updates the existing booking in place — no new booking row", async () => {
    const { deps, updateReservationCalendar } = makeDeps();
    const service = new ConciergeCallService(deps);
    setupOutcomeRun({ kind: "change", bookingId: 77 });
    store.updateReturns["call_tasks"] = [taskRow({ state: "completed", bookingId: 77 })];
    store.selectQueues["bookings"] = [
      [bookingRow({ id: 77 })],
      [bookingRow({ id: 77, status: "changed", confirmationCode: "NEW9" })],
    ];
    store.updateReturns["bookings"] = [bookingRow({ id: 77, status: "changed", confirmationCode: "NEW9" })];
    store.selectQueues["reservations"] = [
      [{ id: 55, tripId: 3, date: "2026-12-10", time: "19:00", confirmationCode: "OLD1" }],
    ];
    store.updateReturns["reservations"] = [
      { id: 55, tripId: 3, date: "2026-12-11", time: "20:00", confirmationCode: "NEW9" },
    ];

    const result = await service.recordOutcome(21, {
      outcome: {
        disposition: "changed",
        personSpokenTo: "Marie",
        confirmationCode: "NEW9",
        agreedAmountMinor: 5_000,
        agreedCurrency: "USD",
        agreedTerms: "Change fee $50, fare difference waived",
        serviceDate: "2026-12-11",
        serviceTime: "20:00",
      },
    });

    expect(result.booking?.status).toBe("changed");
    expect(insertsInto("bookings")).toHaveLength(0);
    const set = updatesTo("bookings")[0]!.set as Record<string, unknown>;
    expect(set.status).toBe("changed");
    expect(set.confirmationCode).toBe("NEW9");
    const attribution = set.costAttribution as { phoneChanges: Array<Record<string, unknown>> };
    expect(attribution.phoneChanges[0]!.additionalChargeMinor).toBe(5_000);
    // The projected reservation follows the change.
    expect(updatesTo("reservations")).toHaveLength(1);
    expect(updateReservationCalendar).toHaveBeenCalledTimes(1);
  });

  it("a cancel outcome cancels the booking, records the refund as stated, and deletes the calendar events", async () => {
    const { deps, deleteReservationCalendar } = makeDeps();
    const service = new ConciergeCallService(deps);
    setupOutcomeRun({ kind: "cancel", bookingId: 77 });
    store.updateReturns["call_tasks"] = [taskRow({ state: "completed", bookingId: 77 })];
    store.updateReturns["bookings"] = [bookingRow({ id: 77, status: "cancelled" })];
    store.selectQueues["bookings"] = [
      [bookingRow({ id: 77 })],
      [bookingRow({ id: 77, status: "cancelled" })],
    ];

    const result = await service.recordOutcome(21, {
      outcome: {
        disposition: "cancelled",
        personSpokenTo: "Marie",
        refundAmountMinor: 10_000,
        refundCurrency: "USD",
        refundTimeline: "5–7 business days",
      },
    });

    expect(result.booking?.status).toBe("cancelled");
    const set = updatesTo("bookings")[0]!.set as Record<string, unknown>;
    const cancellation = (set.costAttribution as { cancellation: Record<string, unknown> }).cancellation;
    expect(cancellation.refundAmountMinor).toBe(10_000);
    expect(cancellation.refundTimeline).toBe("5–7 business days");
    expect(cancellation.channel).toBe("phone");
    expect(deleteReservationCalendar).toHaveBeenCalledWith(55);
    const taskSet = updatesTo("call_tasks")[0]!.set as Record<string, unknown>;
    expect(taskSet.outcomeText).toMatch(/Refund of \$100\.00 stated by the venue/);
    expect(taskSet.outcomeText).toMatch(/5–7 business days/);
  });

  it("a duplicate outcome report on a settled task changes nothing", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_tasks"] = [[taskRow({ state: "completed", outcome: { disposition: "booked" }, bookingId: 91 })]];
    store.selectQueues["call_briefs"] = [[briefRow()]];
    store.selectQueues["bookings"] = [[bookingRow({ id: 91 })]];
    const result = await service.recordOutcome(21, {
      outcome: { disposition: "booked", agreedAmountMinor: 1, agreedCurrency: "USD" },
    });
    expect(result.alreadyRecorded).toBe(true);
    expect(insertsInto("bookings")).toHaveLength(0);
    expect(store.ops.filter((o) => o.kind !== "select")).toHaveLength(0);
  });

  it("an outcome for a never-dialed task is refused", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_tasks"] = [[taskRow({ state: "queued" })]];
    await expect(
      service.recordOutcome(21, { outcome: { disposition: "booked" } }),
    ).rejects.toBeInstanceOf(CallRefused);
  });
});

// ─── Status callbacks ────────────────────────────────────────────────────────

describe("handleStatusCallback", () => {
  it("an unknown call id is a no-op", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_tasks"] = [[]];
    await expect(service.handleStatusCallback("CA-unknown", "completed", {})).resolves.toBeNull();
  });

  it("a provider no-answer finalizes the task as a failed attempt with cost recorded", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_tasks"] = [[taskRow()]];
    store.selectQueues["call_briefs"] = [[briefRow()]];
    store.updateReturns["call_tasks"] = [taskRow({ state: "failed", durationSeconds: 300 })];
    const task = await service.handleStatusCallback("CA1", "no-answer", { durationSeconds: 300 });
    expect(task?.state).toBe("failed");
    const finalSet = updatesTo("call_tasks").at(-1)!.set as Record<string, unknown>;
    expect(finalSet.telephonyCostMinor).toBe(55); // 5 min: 5×8.4¢ + 12¢ branded + 0.75¢ AMD = 54.75¢ → 55¢
    expect(finalSet.outcomeText).toMatch(/No answer/);
  });
});

// ─── amendBrief — a new version, never a silent edit ─────────────────────────

describe("amendBrief", () => {
  it("creates version+1 as a fresh DRAFT (confirmation does not carry) and supersedes the old brief", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow({ state: "confirmed" })]];
    enqueueParticipant();
    store.selectQueues["call_tasks"] = [[]];
    store.insertReturns["call_briefs"] = [briefRow({ id: 12, version: 2, state: "draft" })];
    store.updateReturns["call_briefs"] = [briefRow({ state: "superseded" })];

    const next = await service.amendBrief(11, { ask: "Book a table for 6 instead" }, ACTOR);
    expect(next.version).toBe(2);
    const values = insertsInto("call_briefs")[0]!.values as Record<string, unknown>;
    expect(values.ask).toBe("Book a table for 6 instead");
    expect(values.state).toBe("draft");
    expect(values.supersedesBriefId).toBe(11);
    expect(values.confirmedByUserId).toBeUndefined();
    const supersede = updatesTo("call_briefs")[0]!.set as Record<string, unknown>;
    expect(supersede.state).toBe("superseded");
  });

  it("refuses to amend while a call is live against the brief", async () => {
    const { deps } = makeDeps();
    const service = new ConciergeCallService(deps);
    store.selectQueues["call_briefs"] = [[briefRow()]];
    enqueueParticipant();
    store.selectQueues["call_tasks"] = [[taskRow({ state: "calling" })]];
    await expect(service.amendBrief(11, { ask: "Changed ask" }, ACTOR)).rejects.toBeInstanceOf(
      CallRefused,
    );
    expect(insertsInto("call_briefs")).toHaveLength(0);
  });
});
