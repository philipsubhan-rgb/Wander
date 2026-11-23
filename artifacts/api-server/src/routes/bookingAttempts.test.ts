/**
 * Booking Attempts — the on-screen REVIEW surface endpoints
 * (design decision 6).
 *
 * Harness follows routes/voice.test.ts: chainable @workspace/db queue
 * mock, the real bookingAttempts router + the real Booking Gate on a
 * minimal Express app, session identity injected by middleware.
 *
 * What this suite proves:
 *  - the review projection carries the charge-currency total, the
 *    snapshot-backed home equivalent WITH its FX stamp, covered
 *    travelers by name, terms, why-this-option, reviewVersion, and a
 *    per-viewer confirmable verdict from the gate's own policy;
 *  - a missing FX snapshot means NO home equivalent — never a guess;
 *  - non-participants are refused on read and confirm with the trip
 *    routes' own 403 shape; an attempt from another trip reads 404;
 *  - confirm from REVIEW succeeds for a self-only item through the
 *    gate's real confirm path (text channel);
 *  - a shared item's confirm is refused 422 with the policy's reason
 *    and the attempt stays at REVIEW (the traveler's own confirmation
 *    is still recorded by the gate);
 *  - a stale reviewVersion fails closed (409 + current projection)
 *    with ZERO writes;
 *  - the gate's voice-channel guard still refuses a voice confirm
 *    through the service path, before any write.
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Chainable DB mock with write recording ───────────────────────────────────

const dbMock = vi.hoisted(() => {
  const resultQueue: unknown[] = [];
  const updateOps: Array<{ table: string; set: unknown }> = [];
  const insertOps: Array<{ table: string; values: unknown }> = [];
  const table = (name: string) => ({ __table: name });

  function enqueue(...items: unknown[]) {
    resultQueue.push(...items);
  }

  function makeChain(kind: string, tableName = ""): Record<string, unknown> {
    const ctx = { table: tableName };
    let p: Promise<unknown> | null = null;
    function promise() {
      if (!p) p = Promise.resolve(resultQueue.shift() ?? []);
      return p;
    }
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => promise().then(res, rej),
      catch: (rej: (e: unknown) => unknown) => promise().catch(rej),
      finally: (fin: () => void) => promise().finally(fin),
    };
    chain.from = (t: { __table?: string }) => {
      ctx.table = t?.__table ?? ctx.table;
      return chain;
    };
    for (const m of ["where", "orderBy", "limit", "groupBy", "innerJoin", "leftJoin", "returning"]) {
      chain[m] = () => chain;
    }
    chain.set = (v: unknown) => {
      updateOps.push({ table: ctx.table, set: v });
      return chain;
    };
    chain.values = (v: unknown) => {
      insertOps.push({ table: ctx.table, values: v });
      return chain;
    };
    return chain;
  }

  const db = {
    select: vi.fn(() => makeChain("select")),
    insert: vi.fn((t: { __table: string }) => makeChain("insert", t?.__table ?? "")),
    update: vi.fn((t: { __table: string }) => makeChain("update", t?.__table ?? "")),
    delete: vi.fn((t: { __table: string }) => makeChain("delete", t?.__table ?? "")),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { resultQueue, enqueue, updateOps, insertOps, table, db };
});

const { enqueue } = dbMock;

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
  db: dbMock.db,
  pool: { query: vi.fn(), end: vi.fn() },
  tripsTable: dbMock.table("trips"),
  tripParticipantsTable: dbMock.table("trip_participants"),
  itineraryDaysTable: dbMock.table("itinerary_days"),
  reservationsTable: dbMock.table("reservations"),
  flightsTable: dbMock.table("flights"),
  accommodationsTable: dbMock.table("accommodations"),
  activitiesTable: dbMock.table("activities"),
  carRentalsTable: dbMock.table("car_rentals"),
  usersTable: dbMock.table("users"),
  marcoMessagesTable: dbMock.table("marco_messages"),
  intakeSessionsTable: dbMock.table("intake_sessions"),
  bookingAttemptsTable: dbMock.table("booking_attempts"),
  bookingAttemptTravelersTable: dbMock.table("booking_attempt_travelers"),
  bookingOperationsTable: dbMock.table("booking_operations"),
  bookingsTable: dbMock.table("bookings"),
  bookingTravelersTable: dbMock.table("booking_travelers"),
  bookingSplitsTable: dbMock.table("booking_splits"),
  commissionRecordsTable: dbMock.table("commission_records"),
  advisoriesTable: dbMock.table("advisories"),
  flightWatchesTable: dbMock.table("flight_watches"),
  travelerProfilesTable: dbMock.table("traveler_profiles"),
  profileAccessLogTable: dbMock.table("profile_access_log"),
  tripRosterEntriesTable: dbMock.table("trip_roster_entries"),
  travelerRulesTable: dbMock.table("traveler_rules"),
  travelerContextTable: dbMock.table("traveler_context"),
  travelerCompanionsTable: dbMock.table("traveler_companions"),
  savedGroupsTable: dbMock.table("saved_groups"),
  fxRateSnapshotsTable: dbMock.table("fx_rate_snapshots"),
  connectedAccountsTable: dbMock.table("connected_accounts"),
  reservationProposalsTable: dbMock.table("reservation_proposals"),
  calendarEventLinksTable: dbMock.table("calendar_event_links"),
  travelerInviteTokensTable: dbMock.table("traveler_invite_tokens"),
  extrasSuggestionsTable: dbMock.table("extras_suggestions"),
}));

// Avoid loading the real auth router (it pulls in nodemailer via lib/email).
vi.mock("./auth", () => ({
  verifyAuthToken: vi.fn(() => null),
  signAuthToken: vi.fn(() => "test-token"),
}));

import bookingAttemptsRouter from "./bookingAttempts";
import { getDefaultBookingGate } from "../lib/bookingGate";
import type { BookingReviewProjection } from "../lib/bookingReview";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const participantRow = { tripId: 7, userId: 42, isTripAdmin: false };

function attemptRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    tripId: 7,
    kind: "flight",
    adapter: "duffel",
    supplier: "United",
    optionId: "off_123",
    optionSnapshot: {
      option: {
        id: "off_123",
        kind: "flight",
        adapter: "duffel",
        supplier: "United",
        money: { amountMinor: 61200, currency: "USD" },
        summary: {
          carrier: "United",
          carrierCode: "UA",
          label: "UA30 Basic Economy",
          fareClass: "Basic Economy",
          cabinClass: "economy",
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
          connectionAirports: [],
        },
      },
    },
    state: "review",
    visibility: "shared",
    category: null,
    presentedAmountMinor: 61200,
    presentedCurrency: "USD",
    reviewedAmountMinor: 61200,
    reviewedCurrency: "USD",
    reviewVersion: 1,
    homeEquivalentMinor: 52000,
    homeCurrency: "EUR",
    fxSnapshotId: 5,
    changeTerms: "Changes are allowed by the fare rules (any fare difference still applies).",
    cancelTerms: "Non-refundable — cancelling forfeits the fare.",
    whyThisOption: "best_price",
    whyThisOptionText: "United (UA30 Basic Economy) was the cheapest option that fit your rules.",
    rankingInputsHash: "hash",
    executionChannel: "duffel",
    confirmedByUserId: null,
    confirmedAt: null,
    failureReason: null,
    bookingId: null,
    createdAt: new Date("2026-11-18T09:00:00Z"),
    updatedAt: new Date("2026-11-18T09:05:00Z"),
    ...overrides,
  };
}

// Coverage fixtures are factories: the gate mutates the row it records
// a confirmation on (confirmedAt), exactly like a real DB row — shared
// objects would leak that mutation (and a queue position) across tests.
function coverageSelf() {
  return {
    id: 1,
    attemptId: 42,
    userId: 42,
    rosterEntryId: null,
    isPayer: true,
    confirmedAt: null as Date | null,
    createdAt: new Date("2026-11-18T09:00:00Z"),
  };
}

function coverageOther() {
  return {
    id: 2,
    attemptId: 42,
    userId: 43,
    rosterEntryId: null,
    isPayer: false,
    confirmedAt: null as Date | null,
    createdAt: new Date("2026-11-18T09:00:00Z"),
  };
}

const fxSnapshotRow = {
  id: 5,
  baseCurrency: "USD",
  quoteCurrency: "EUR",
  rate: "0.8496730000",
  source: "ECB/Frankfurter",
  asOf: new Date("2026-11-18T05:30:00Z"),
  createdAt: new Date("2026-11-18T05:30:00Z"),
};

/** The projection builder's reads after a view: names, then FX. */
function enqueueProjectionReads(withFx = true) {
  enqueue([{ id: 42, name: "Phil" }]); // users (coverage + confirmer names)
  if (withFx) enqueue([fxSnapshotRow]); // fx_rate_snapshots
}

/** gate.getAttemptView: attempt, access, coverage. */
function enqueueAttemptView(attempt: unknown, coverage: unknown[]) {
  enqueue([attempt]);
  enqueue([participantRow]);
  enqueue(coverage);
}

// ── Test app & session control ────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let currentSession: { userId: number; role: string } | null = { userId: 42, role: "traveler" };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    (req as unknown as { session: unknown }).session = currentSession;
    next();
  });
  app.use(bookingAttemptsRouter);
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  dbMock.resultQueue.length = 0;
  dbMock.updateOps.length = 0;
  dbMock.insertOps.length = 0;
  currentSession = { userId: 42, role: "traveler" };
});

// ─── GET review ──────────────────────────────────────────────────────────────

describe("GET /trips/:tripId/booking-attempts/:attemptId/review", () => {
  it("serves the full projection: charge total, FX-stamped home equivalent, names, policy verdict", async () => {
    enqueue([participantRow]); // requireTripParticipant
    enqueueAttemptView(attemptRow(), [coverageSelf()]);
    enqueueProjectionReads();

    const res = await fetch(`${baseUrl}/trips/7/booking-attempts/42/review`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { review: BookingReviewProjection };
    const review = body.review;

    expect(review.attemptId).toBe(42);
    expect(review.state).toBe("review");
    expect(review.label).toBe("UA30 Basic Economy");
    expect(review.detailLines.some((l) => l.includes("EWR → MUC"))).toBe(true);
    // Charge currency, untouched — the total a confirmation binds to.
    expect(review.total).toEqual({ amountMinor: 61200, currency: "USD" });
    expect(review.totalIsReviewed).toBe(true);
    // Home equivalent WITH its FX provenance stamp.
    expect(review.homeEquivalent?.amountMinor).toBe(52000);
    expect(review.homeEquivalent?.currency).toBe("EUR");
    expect(review.homeEquivalent?.fx?.snapshotId).toBe(5);
    expect(review.homeEquivalent?.fx?.rate).toBe("0.8496730000");
    expect(review.homeEquivalent?.fx?.source).toBe("ECB/Frankfurter");
    expect(review.homeEquivalent?.fx?.asOf).toBe("2026-11-18T05:30:00.000Z");
    // Terms, travelers (names only), why, version, confirmability.
    expect(review.terms.some((t) => t.startsWith("Cancellation:"))).toBe(true);
    expect(review.coveredTravelers).toEqual([{ name: "Phil", isPayer: true, confirmed: false }]);
    expect(review.whyThisOption?.value).toBe("best_price");
    expect(review.reviewVersion).toBe(1);
    expect(review.confirmable).toBe(true);
    expect(review.confirmBlockedReason).toBeNull();
  });

  it("shows NO home equivalent when no FX snapshot backs one — never a guess", async () => {
    enqueue([participantRow]);
    enqueueAttemptView(attemptRow({ homeEquivalentMinor: null, homeCurrency: null, fxSnapshotId: null }), [
      coverageSelf(),
    ]);
    enqueueProjectionReads(false);

    const res = await fetch(`${baseUrl}/trips/7/booking-attempts/42/review`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { review: BookingReviewProjection };
    expect(body.review.homeEquivalent).toBeNull();
  });

  it("suppresses the equivalent when its FX snapshot row is missing (dangling fxSnapshotId)", async () => {
    enqueue([participantRow]);
    enqueueAttemptView(attemptRow(), [coverageSelf()]); // fxSnapshotId: 5, equivalent present
    enqueue([{ id: 42, name: "Phil" }]); // users (names)
    enqueue([]); // fx_rate_snapshots: the referenced row is gone

    const res = await fetch(`${baseUrl}/trips/7/booking-attempts/42/review`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { review: BookingReviewProjection };
    // An unstamped figure is never projected — the equivalent goes away whole.
    expect(body.review.homeEquivalent).toBeNull();
    // The charge-currency total is unaffected.
    expect(body.review.total).toEqual({ amountMinor: 61200, currency: "USD" });
  });

  it("suppresses an equivalent stored with NO snapshot id — no legitimate no-conversion path exists", async () => {
    enqueue([participantRow]);
    enqueueAttemptView(attemptRow({ fxSnapshotId: null }), [coverageSelf()]);
    enqueueProjectionReads(false); // names only — no FX read is even attempted

    const res = await fetch(`${baseUrl}/trips/7/booking-attempts/42/review`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { review: BookingReviewProjection };
    expect(body.review.homeEquivalent).toBeNull();
  });

  it("refuses a non-participant with the trip routes' 403 shape", async () => {
    currentSession = { userId: 99, role: "traveler" };
    enqueue([]); // requireTripParticipant: no participant row
    const res = await fetch(`${baseUrl}/trips/7/booking-attempts/42/review`);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Trip access required" });
  });

  it("reads an attempt from another trip as not found", async () => {
    enqueue([participantRow]); // participant of trip 7
    enqueueAttemptView(attemptRow({ tripId: 999 }), [coverageSelf()]);
    const res = await fetch(`${baseUrl}/trips/7/booking-attempts/42/review`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Booking attempt not found" });
  });
});

// ─── GET list ────────────────────────────────────────────────────────────────

describe("GET /trips/:tripId/booking-attempts?state=review", () => {
  it("lists the trip's REVIEW attempts as projections", async () => {
    enqueue([participantRow]); // requireTripParticipant
    enqueue([attemptRow()]); // attempts in state=review on trip 7
    enqueueAttemptView(attemptRow(), [coverageSelf()]);
    enqueueProjectionReads();

    const res = await fetch(`${baseUrl}/trips/7/booking-attempts?state=review`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { attempts: BookingReviewProjection[] };
    expect(body.attempts).toHaveLength(1);
    expect(body.attempts[0].attemptId).toBe(42);
    expect(body.attempts[0].state).toBe("review");
  });

  it("refuses a non-participant", async () => {
    currentSession = { userId: 99, role: "traveler" };
    enqueue([]);
    const res = await fetch(`${baseUrl}/trips/7/booking-attempts?state=review`);
    expect(res.status).toBe(403);
  });
});

// ─── POST confirm ────────────────────────────────────────────────────────────

describe("POST /trips/:tripId/booking-attempts/:attemptId/confirm", () => {
  it("confirms a self-only REVIEW attempt through the gate's real path (text channel)", async () => {
    enqueue([participantRow]); // requireTripParticipant
    enqueueAttemptView(attemptRow(), [coverageSelf()]); // route's pre-check view
    // gate.confirmAttempt: load, access, coverage, own-confirmation
    // update, transition update (empty returning → gate's merge fallback)
    enqueue([attemptRow()]);
    enqueue([participantRow]);
    enqueue([coverageSelf()]);
    enqueue([]); // coverage confirmedAt update
    enqueue([]); // attempt transition returning
    enqueueProjectionReads(); // projection from the ConfirmResult

    const res = await fetch(`${baseUrl}/trips/7/booking-attempts/42/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewVersion: 1 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { confirmed: boolean; review: BookingReviewProjection };
    expect(body.confirmed).toBe(true);
    expect(body.review.state).toBe("confirmed");
    expect(body.review.confirmedBy?.name).toBe("Phil");
    expect(body.review.confirmable).toBe(false);
  });

  it("refuses a shared item 422 with the policy's reason; the attempt stays at REVIEW", async () => {
    enqueue([participantRow]);
    enqueueAttemptView(attemptRow(), [coverageSelf(), coverageOther()]);
    enqueue([attemptRow()]);
    enqueue([participantRow]);
    enqueue([coverageSelf(), coverageOther()]);
    enqueue([]); // the confirmer's OWN confirmation is still recorded
    // projection reads: both travelers' names, then FX
    enqueue([
      { id: 42, name: "Phil" },
      { id: 43, name: "Katie" },
    ]);
    enqueue([fxSnapshotRow]);

    const res = await fetch(`${baseUrl}/trips/7/booking-attempts/42/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewVersion: 1 }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; review: BookingReviewProjection };
    expect(body.error).toMatch(/more than one traveler/);
    expect(body.review.state).toBe("review");
    expect(body.review.confirmable).toBe(false);
    expect(body.review.confirmBlockedReason).toMatch(/more than one traveler/);
    // Per-traveler tracking is real: Phil's own confirmation was recorded
    // even though the policy refused the whole.
    expect(body.review.coveredTravelers.find((t) => t.name === "Phil")?.confirmed).toBe(true);
    expect(body.review.coveredTravelers.find((t) => t.name === "Katie")?.confirmed).toBe(false);
  });

  it("fails closed on a stale reviewVersion: 409 + current projection, zero writes", async () => {
    enqueue([participantRow]);
    enqueueAttemptView(attemptRow(), [coverageSelf()]); // current version is 1
    enqueueProjectionReads();

    const res = await fetch(`${baseUrl}/trips/7/booking-attempts/42/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewVersion: 0 }), // the card showed version 0
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; review: BookingReviewProjection };
    expect(body.error).toMatch(/price changed/i);
    expect(body.review.reviewVersion).toBe(1);
    expect(body.review.state).toBe("review");
    expect(dbMock.updateOps).toHaveLength(0);
    expect(dbMock.insertOps).toHaveLength(0);
  });

  it("refuses a non-participant before the gate is touched", async () => {
    currentSession = { userId: 99, role: "traveler" };
    enqueue([]);
    const res = await fetch(`${baseUrl}/trips/7/booking-attempts/42/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewVersion: 1 }),
    });
    expect(res.status).toBe(403);
    expect(dbMock.updateOps).toHaveLength(0);
  });
});

// ─── The voice guard, through the service path ───────────────────────────────

describe("Booking Gate voice-channel guard (service path)", () => {
  it("a voice-channel confirm is refused by the gate before any write", async () => {
    enqueue([attemptRow()]); // loadAttempt
    enqueue([participantRow]); // assertTripAccess
    enqueue([coverageSelf()]); // coverage carried on the refusal result

    const gate = getDefaultBookingGate();
    const result = await gate.confirmAttempt(42, {
      userId: 42,
      role: "traveler",
      channel: "voice",
    });
    expect(result.confirmed).toBe(false);
    expect(result.reason).toMatch(/on screen/);
    expect(result.attempt.state).toBe("review");
    expect(dbMock.updateOps).toHaveLength(0);
    expect(dbMock.insertOps).toHaveLength(0);
  });
});
