/**
 * Integration tests for GET /trips/:tripId/timeline
 *
 * Focus: same-day check-out / check-in scenario — verifies that both
 * accommodation events are returned and that check-out sorts before check-in.
 *
 * Strategy: mock @workspace/db with the chainable fake used across route
 * tests. Mount only the trips router on a minimal Express app that injects a
 * fake session, then drive requests with the built-in fetch (Node ≥ 18).
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Mock drizzle-orm operators ────────────────────────────────────────────────
// The route calls eq() / and() / sql() to build query conditions; our mock DB
// chain ignores these values entirely, so we just need them not to throw.
vi.mock("drizzle-orm", () => ({
  eq:  (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  sql: (...args: unknown[]) => args,
}));

// ── Chainable DB mock ─────────────────────────────────────────────────────────
//
// Lazy dequeue: the result is not pulled from the queue until the chain is
// first awaited. This matters for Promise.all — all six db.select() chains are
// constructed before any of them resolves, so the dequeue order matches the
// construction order inside the route.

const resultQueue: unknown[] = [];

function enqueue(...items: unknown[]) {
  resultQueue.push(...items);
}

function makeChain(): any {
  let p: Promise<unknown> | null = null;
  function promise() {
    if (!p) p = Promise.resolve(resultQueue.shift() ?? []);
    return p;
  }
  const chain: any = {
    then:    (res: any, rej: any) => promise().then(res, rej),
    catch:   (rej: any)           => promise().catch(rej),
    finally: (fin: any)           => promise().finally(fin),
  };
  for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "set", "values", "returning"]) {
    chain[m] = () => chain;
  }
  return chain;
}

const fakeTable = new Proxy({}, { get: (_t, p) => p });

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  tripsTable:            fakeTable,
  tripParticipantsTable: fakeTable,
  usersTable:            fakeTable,
  flightsTable:          fakeTable,
  accommodationsTable:   fakeTable,
  activitiesTable:       fakeTable,
  itineraryDaysTable:    fakeTable,
  packingItemsTable:     fakeTable,
  carRentalsTable:       fakeTable,
  tripExpensesTable:     fakeTable,
  reservationsTable:     fakeTable,
  pool:                  { query: vi.fn(), end: vi.fn() },
}));

// ── Minimal test Express app ──────────────────────────────────────────────────

async function buildTestApp() {
  const { default: tripsRouter } = await import("./trips.js");

  const app = express();
  app.use(express.json());

  // Inject a fake session so requireAuth passes without touching real storage.
  app.use((req: any, _res, next) => {
    req.session = { userId: 1, role: "admin" };
    next();
  });

  app.use("/api", tripsRouter);
  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = await buildTestApp();
  await new Promise<void>(resolve => {
    server = http.createServer(app).listen(0, resolve);
  });
  const addr = server.address() as { port: number };
  base = `http://localhost:${addr.port}/api`;
});

afterAll(() => server.close());

beforeEach(() => {
  resultQueue.length = 0;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json() as any[] };
}

/**
 * Enqueue the six results that the timeline handler fetches via Promise.all:
 *   1. flights
 *   2. accommodations
 *   3. activities
 *   4. itinerary days
 *   5. car rentals
 *   6. reservations
 */
function enqueueTimeline({
  flights       = [] as any[],
  accommodations = [] as any[],
  activities    = [] as any[],
  itinerary     = [] as any[],
  carRentals    = [] as any[],
  reservations  = [] as any[],
} = {}) {
  enqueue(flights, accommodations, activities, itinerary, carRentals, reservations);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /trips/:tripId/timeline — same-day check-out / check-in", () => {
  /**
   * Core scenario: a traveler checks OUT of Hotel A and checks IN to Hotel B
   * on the same date (2025-07-15). The timeline must include both events and
   * the check-out must precede the check-in so the sequence reads logically.
   */
  it("returns both accommodation events when check-out and check-in share a date", async () => {
    enqueueTimeline({
      accommodations: [
        {
          id: 1,
          tripId: 1,
          name: "Hotel Alpha",
          checkIn: "2025-07-10",
          checkOut: "2025-07-15",
          address: "10 Alpha St",
          notes: null,
          imageUrl: null,
          confirmationCode: "ALPHA01",
        },
        {
          id: 2,
          tripId: 1,
          name: "Hotel Beta",
          checkIn: "2025-07-15",
          checkOut: "2025-07-20",
          address: "20 Beta Ave",
          notes: null,
          imageUrl: null,
          confirmationCode: "BETA02",
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const july15 = body.filter((e: any) => e.date === "2025-07-15");
    expect(july15).toHaveLength(2);
  });

  it("places check-out before check-in when both land on the same date", async () => {
    enqueueTimeline({
      accommodations: [
        {
          id: 1,
          tripId: 1,
          name: "Hotel Alpha",
          checkIn: "2025-07-10",
          checkOut: "2025-07-15",
          address: "10 Alpha St",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
        {
          id: 2,
          tripId: 1,
          name: "Hotel Beta",
          checkIn: "2025-07-15",
          checkOut: "2025-07-20",
          address: "20 Beta Ave",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
      ],
    });

    const { body } = await get("/trips/1/timeline");

    const july15 = body.filter((e: any) => e.date === "2025-07-15");
    expect(july15[0].title).toBe("Check-out: Hotel Alpha");
    expect(july15[1].title).toBe("Check-in: Hotel Beta");
  });

  it("still sorts check-out before check-in even when hotels are listed in reverse DB order", async () => {
    // Reverse the DB order to confirm the sort is not order-dependent.
    enqueueTimeline({
      accommodations: [
        {
          id: 2,
          tripId: 1,
          name: "Hotel Beta",
          checkIn: "2025-07-15",
          checkOut: "2025-07-20",
          address: "20 Beta Ave",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
        {
          id: 1,
          tripId: 1,
          name: "Hotel Alpha",
          checkIn: "2025-07-10",
          checkOut: "2025-07-15",
          address: "10 Alpha St",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
      ],
    });

    const { body } = await get("/trips/1/timeline");

    const july15 = body.filter((e: any) => e.date === "2025-07-15");
    expect(july15).toHaveLength(2);
    expect(july15[0].title).toBe("Check-out: Hotel Alpha");
    expect(july15[1].title).toBe("Check-in: Hotel Beta");
  });

  /**
   * Type-ordering scenario: flight, activity, and reservation all land on the
   * same date with no explicit time (all default to "00:00"). The sort must
   * produce the cross-type priority order:
   *   flight → activity → reservation
   */
  it("orders flight before activity before reservation when all share a date and time", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 10,
          tripId: 1,
          airline: "Sky Air",
          flightNumber: "SK100",
          departureAirport: "JFK",
          arrivalAirport: "CDG",
          departureDatetime: "2025-07-15",
          arrivalDatetime:   "2025-07-16",
          notes: null,
          confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 20,
          tripId: 1,
          title: "Eiffel Tower visit",
          date: "2025-07-15",
          time: null,
          description: null,
          location: "Paris",
          imageUrl: null,
        },
      ],
      reservations: [
        {
          id: 30,
          tripId: 1,
          title: "Dinner at Le Jules Verne",
          date: "2025-07-15",
          time: null,
          notes: null,
          address: null,
          venue: "Le Jules Verne",
          imageUrl: null,
          confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const july15 = body.filter((e: any) => e.date === "2025-07-15");
    expect(july15).toHaveLength(3);
    expect(july15[0].type).toBe("flight");
    expect(july15[1].type).toBe("activity");
    expect(july15[2].type).toBe("reservation");
  });

  /**
   * Full cross-type ordering: flight, car_rental, accommodation (check-out
   * then check-in), activity, reservation — all on the same date, no time.
   */
  it("applies the full cross-type priority order on a single day with no times", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 10,
          tripId: 1,
          airline: "Sky Air",
          flightNumber: "SK100",
          departureAirport: "JFK",
          arrivalAirport: "CDG",
          departureDatetime: "2025-08-01",
          arrivalDatetime:   "2025-08-02",
          notes: null,
          confirmationCode: null,
        },
      ],
      accommodations: [
        {
          id: 1,
          tripId: 1,
          name: "Old Hotel",
          checkIn: "2025-07-28",
          checkOut: "2025-08-01",
          address: "1 Old St",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
        {
          id: 2,
          tripId: 1,
          name: "New Hotel",
          checkIn: "2025-08-01",
          checkOut: "2025-08-05",
          address: "2 New Ave",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 20,
          tripId: 1,
          title: "City tour",
          date: "2025-08-01",
          time: null,
          description: null,
          location: "Paris",
          imageUrl: null,
        },
      ],
      reservations: [
        {
          id: 30,
          tripId: 1,
          title: "Dinner reservation",
          date: "2025-08-01",
          time: null,
          notes: null,
          address: null,
          venue: "Restaurant X",
          imageUrl: null,
          confirmationCode: null,
        },
      ],
      carRentals: [
        {
          id: 40,
          tripId: 1,
          company: "FastCar",
          pickupLocation: "CDG Airport",
          dropoffLocation: "Paris Center",
          pickupDatetime: "2025-08-01",
          dropoffDatetime: "2025-08-05",
          notes: null,
          confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const aug1 = body.filter((e: any) => e.date === "2025-08-01");
    // flight, car_rental, check-out: Old Hotel, check-in: New Hotel, activity, reservation
    expect(aug1).toHaveLength(6);
    expect(aug1[0].type).toBe("flight");
    expect(aug1[1].type).toBe("car_rental");
    expect(aug1[2].type).toBe("accommodation");
    expect(aug1[2].title).toBe("Check-out: Old Hotel");
    expect(aug1[3].type).toBe("accommodation");
    expect(aug1[3].title).toBe("Check-in: New Hotel");
    expect(aug1[4].type).toBe("activity");
    expect(aug1[5].type).toBe("reservation");
  });

  /**
   * Three-accommodation boundary condition:
   *
   * Traveler checks OUT of Hotel A, checks IN to Hotel B for a short stay,
   * checks OUT of Hotel B, then checks IN to Hotel C — all on 2025-07-15.
   *
   * The sort must produce the correct interleaved order so each check-out is
   * immediately followed by the matching check-in, enabling the TripItinerary
   * component to insert a TransitionDivider between every consecutive pair:
   *
   *   Check-out: Hotel Alpha   ← divider ↓
   *   Check-in:  Hotel Beta
   *   Check-out: Hotel Beta    ← divider ↓
   *   Check-in:  Hotel Gamma
   */
  /**
   * Uses deliberately non-chronological IDs (Alpha=5, Beta=2, Gamma=8) to
   * confirm the sort is driven by stay dates, not database insert order or
   * primary-key values.
   */
  it("correctly interleaves three same-day accommodation handoffs regardless of ID order (check-out A → check-in B → check-out B → check-in C)", async () => {
    enqueueTimeline({
      accommodations: [
        // IDs intentionally non-chronological to prove date-based sort
        {
          id: 5,
          tripId: 1,
          name: "Hotel Alpha",
          checkIn: "2025-07-10",
          checkOut: "2025-07-15",
          address: "1 Alpha St",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
        {
          id: 2,
          tripId: 1,
          name: "Hotel Beta",
          checkIn: "2025-07-15",
          checkOut: "2025-07-15",
          address: "2 Beta Ave",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
        {
          id: 8,
          tripId: 1,
          name: "Hotel Gamma",
          checkIn: "2025-07-15",
          checkOut: "2025-07-20",
          address: "3 Gamma Rd",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const july15 = body.filter((e: any) => e.date === "2025-07-15");
    expect(july15).toHaveLength(4);

    // Must be interleaved so each check-out is immediately followed by the
    // next check-in, giving the UI consecutive pairs it can mark as transitions.
    expect(july15[0].title).toBe("Check-out: Hotel Alpha");
    expect(july15[1].title).toBe("Check-in: Hotel Beta");
    expect(july15[2].title).toBe("Check-out: Hotel Beta");
    expect(july15[3].title).toBe("Check-in: Hotel Gamma");

    // Internal sort helpers must not leak into the API response.
    expect(july15[0]).not.toHaveProperty("_stayStart");
    expect(july15[0]).not.toHaveProperty("_stayEnd");
    expect(july15[0]).not.toHaveProperty("_isCheckout");
  });

  it("interleaves correctly when hotels are added in reverse DB row order (non-chronological DB rows)", async () => {

    // Same three stays as above but delivered in reverse row order from the DB.
    enqueueTimeline({
      accommodations: [
        {
          id: 8,
          tripId: 1,
          name: "Hotel Gamma",
          checkIn: "2025-07-15",
          checkOut: "2025-07-20",
          address: "3 Gamma Rd",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
        {
          id: 2,
          tripId: 1,
          name: "Hotel Beta",
          checkIn: "2025-07-15",
          checkOut: "2025-07-15",
          address: "2 Beta Ave",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
        {
          id: 5,
          tripId: 1,
          name: "Hotel Alpha",
          checkIn: "2025-07-10",
          checkOut: "2025-07-15",
          address: "1 Alpha St",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
      ],
    });

    const { body } = await get("/trips/1/timeline");

    const july15 = body.filter((e: any) => e.date === "2025-07-15");
    expect(july15).toHaveLength(4);
    expect(july15[0].title).toBe("Check-out: Hotel Alpha");
    expect(july15[1].title).toBe("Check-in: Hotel Beta");
    expect(july15[2].title).toBe("Check-out: Hotel Beta");
    expect(july15[3].title).toBe("Check-in: Hotel Gamma");
  });

  /**
   * Timed-event cross-type ordering: a flight departure and a dinner reservation
   * both carry the same explicit time (18:00) on the same date. The flight must
   * sort before the reservation because its cross-type priority (0) is lower
   * than the reservation's priority (4).
   */
  it("places a flight before a same-time reservation when both share an explicit time", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 10,
          tripId: 1,
          airline: "Sky Air",
          flightNumber: "SK200",
          departureAirport: "JFK",
          arrivalAirport: "CDG",
          departureDatetime: "2025-09-10T18:00",
          arrivalDatetime:   "2025-09-11T06:00",
          notes: null,
          confirmationCode: null,
        },
      ],
      reservations: [
        {
          id: 30,
          tripId: 1,
          title: "Dinner at Chez Paul",
          date: "2025-09-10",
          time: "18:00",
          notes: null,
          address: null,
          venue: "Chez Paul",
          imageUrl: null,
          confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(2);

    // Both events share time "18:00" — cross-type priority must break the tie.
    expect(sep10[0].type).toBe("flight");
    expect(sep10[0].time).toBe("18:00");
    expect(sep10[1].type).toBe("reservation");
    expect(sep10[1].time).toBe("18:00");
  });

  /**
   * Car-rental vs activity tiebreak:
   *
   * A car rental pickup and an activity both carry the same explicit time
   * (10:00) on the same date (2025-06-20). The cross-type priority places
   * car_rental (1) before activity (3), so the car rental must sort first.
   */
  it("places a car rental before an activity when both share the same explicit date and time", async () => {
    enqueueTimeline({
      activities: [
        {
          id: 20,
          tripId: 1,
          title: "Morning city walk",
          date: "2025-06-20",
          time: "10:00",
          description: null,
          location: "Paris",
          imageUrl: null,
        },
      ],
      carRentals: [
        {
          id: 40,
          tripId: 1,
          company: "SpeedRent",
          pickupLocation: "CDG Airport",
          dropoffLocation: "Paris Center",
          pickupDatetime: "2025-06-20T10:00",
          dropoffDatetime: "2025-06-25T10:00",
          notes: null,
          confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const june20 = body.filter((e: any) => e.date === "2025-06-20");
    expect(june20).toHaveLength(2);

    // Both events share time "10:00" — cross-type priority must break the tie.
    expect(june20[0].type).toBe("car_rental");
    expect(june20[0].time).toBe("10:00");
    expect(june20[1].type).toBe("activity");
    expect(june20[1].time).toBe("10:00");
  });

  /**
   * Flight vs car-rental tiebreak:
   *
   * A flight departure and a car rental pickup both carry the same explicit
   * time (11:00) on the same date (2025-07-04).  The cross-type priority
   * places flight (0) before car_rental (1), so the flight must sort first.
   */
  it("places a flight before a car rental when both share the same explicit date and time", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 50,
          tripId: 1,
          airline: "Delta",
          flightNumber: "DL202",
          departureAirport: "ATL",
          arrivalAirport: "LAX",
          departureDatetime: "2025-07-04T11:00",
          arrivalDatetime:   "2025-07-04T14:00",
          notes: null,
          confirmationCode: null,
        },
      ],
      carRentals: [
        {
          id: 51,
          tripId: 1,
          company: "Hertz",
          pickupLocation: "ATL Airport",
          dropoffLocation: "LAX Airport",
          pickupDatetime: "2025-07-04T11:00",
          dropoffDatetime: "2025-07-11T11:00",
          notes: null,
          confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const jul4 = body.filter((e: any) => e.date === "2025-07-04");
    // flight departure + car_rental pickup — both at 11:00
    expect(jul4).toHaveLength(2);

    // Cross-type priority must break the tie: flight (0) before car_rental (1).
    expect(jul4[0].type).toBe("flight");
    expect(jul4[0].time).toBe("11:00");
    expect(jul4[1].type).toBe("car_rental");
    expect(jul4[1].time).toBe("11:00");
  });

  /**
   * Car-rental vs reservation tiebreak:
   *
   * A car rental pickup and a reservation both carry the same explicit time
   * (14:00) on the same date (2025-09-05). The cross-type priority places
   * car_rental (1) before reservation (4), so the car rental must sort first.
   */
  it("places a car rental before a reservation when both share the same explicit date and time", async () => {
    enqueueTimeline({
      carRentals: [
        {
          id: 60,
          tripId: 1,
          company: "Avis",
          pickupLocation: "Rome Airport",
          dropoffLocation: "Rome Center",
          pickupDatetime: "2025-09-05T14:00",
          dropoffDatetime: "2025-09-12T14:00",
          notes: null,
          confirmationCode: null,
        },
      ],
      reservations: [
        {
          id: 61,
          tripId: 1,
          type: "restaurant",
          name: "Trattoria Roma",
          date: "2025-09-05",
          time: "14:00",
          confirmationCode: null,
          notes: null,
          address: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const sep5 = body.filter((e: any) => e.date === "2025-09-05");
    expect(sep5).toHaveLength(2);

    // Both events share time "14:00" — cross-type priority must break the tie.
    expect(sep5[0].type).toBe("car_rental");
    expect(sep5[0].time).toBe("14:00");
    expect(sep5[1].type).toBe("reservation");
    expect(sep5[1].time).toBe("14:00");
  });

  /**
   * Three-way tie: car_rental + activity + reservation all at 11:00 on 2025-10-20.
   *
   * Cross-type priorities: car_rental (1) → activity (3) → reservation (4).
   * The comparator is applied pairwise by Array.prototype.sort, so a three-way
   * tie exercises transitivity — a bug in the comparator that passes pair-wise
   * checks can still break under three or more participants.
   */
  it("places car_rental before activity before reservation when all three share the same explicit date and time", async () => {
    enqueueTimeline({
      carRentals: [
        {
          id: 70,
          tripId: 1,
          company: "Hertz",
          pickupLocation: "Barcelona Airport",
          dropoffLocation: "Barcelona Center",
          pickupDatetime: "2025-10-20T11:00",
          dropoffDatetime: "2025-10-25T11:00",
          notes: null,
          confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 71,
          tripId: 1,
          title: "City walking tour",
          date: "2025-10-20",
          time: "11:00",
          description: null,
          location: "Barcelona Old Town",
          imageUrl: null,
        },
      ],
      reservations: [
        {
          id: 72,
          tripId: 1,
          type: "restaurant",
          name: "El Xampanyet",
          date: "2025-10-20",
          time: "11:00",
          confirmationCode: null,
          notes: null,
          address: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const oct20 = body.filter((e: any) => e.date === "2025-10-20");
    // car_rental pickup + activity + reservation — all three at 11:00
    expect(oct20).toHaveLength(3);

    // Cross-type priority must produce: car_rental (1) → activity (3) → reservation (4)
    expect(oct20[0].type).toBe("car_rental");
    expect(oct20[0].time).toBe("11:00");
    expect(oct20[1].type).toBe("activity");
    expect(oct20[1].time).toBe("11:00");
    expect(oct20[2].type).toBe("reservation");
    expect(oct20[2].time).toBe("11:00");
  });

  /**
   * Three-way tie: flight + car_rental + activity all at 09:00 on 2025-08-15.
   *
   * Cross-type priorities: flight (0) → car_rental (1) → activity (3).
   * The comparator is applied pairwise by Array.prototype.sort, so a three-way
   * tie exercises transitivity — a bug in the comparator that passes pair-wise
   * checks can still break under three or more participants.
   */
  it("places flight before car_rental before activity when all three share the same explicit date and time", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 11,
          tripId: 1,
          airline: "Arc Air",
          flightNumber: "AR900",
          departureAirport: "LHR",
          arrivalAirport: "JFK",
          departureDatetime: "2025-08-15T09:00",
          arrivalDatetime:   "2025-08-15T14:00",
          notes: null,
          confirmationCode: null,
        },
      ],
      carRentals: [
        {
          id: 41,
          tripId: 1,
          company: "QuickCar",
          pickupLocation: "JFK Airport",
          dropoffLocation: "Manhattan",
          pickupDatetime: "2025-08-15T09:00",
          dropoffDatetime: "2025-08-20T09:00",
          notes: null,
          confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 21,
          tripId: 1,
          title: "Sunrise hike",
          date: "2025-08-15",
          time: "09:00",
          description: null,
          location: "Upstate NY",
          imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const aug15 = body.filter((e: any) => e.date === "2025-08-15");
    // flight departure + car_rental pickup + activity — all three at 09:00
    expect(aug15).toHaveLength(3);

    // Cross-type priority must produce: flight (0) → car_rental (1) → activity (3)
    expect(aug15[0].type).toBe("flight");
    expect(aug15[0].time).toBe("09:00");
    expect(aug15[1].type).toBe("car_rental");
    expect(aug15[1].time).toBe("09:00");
    expect(aug15[2].type).toBe("activity");
    expect(aug15[2].time).toBe("09:00");
  });

  /**
   * Midnight departure time edge case:
   *
   * A flight with departureDatetime "2025-09-10T00:00" sits alongside an
   * activity that also starts at "00:00" on the same date.  The time
   * extraction must treat T00:00 as the literal time "00:00" (not as
   * "no time given" / null).  Because flight (priority 0) ranks above
   * activity (priority 3), the flight must sort first even though both
   * events carry the same "00:00" time string.
   */
  it("assigns time 00:00 (not null) to a midnight flight and sorts it before a same-time activity", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 60,
          tripId: 1,
          airline: "Night Air",
          flightNumber: "NA001",
          departureAirport: "LHR",
          arrivalAirport: "JFK",
          departureDatetime: "2025-09-10T00:00",
          arrivalDatetime:   "2025-09-10T08:00",
          notes: null,
          confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 61,
          tripId: 1,
          title: "Midnight city tour",
          date: "2025-09-10",
          time: "00:00",
          description: null,
          location: "London",
          imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(2);

    // The flight must carry the explicit time "00:00", not null.
    const flight = sep10.find((e: any) => e.type === "flight");
    expect(flight).toBeDefined();
    expect(flight.time).toBe("00:00");

    // Cross-type priority: flight (0) < activity (3) — flight must sort first.
    expect(sep10[0].type).toBe("flight");
    expect(sep10[0].time).toBe("00:00");
    expect(sep10[1].type).toBe("activity");
    expect(sep10[1].time).toBe("00:00");
  });

  /**
   * Date-only flight edge case:
   *
   * A flight stored with departureDatetime="2025-09-10" (no time component,
   * length == 10) sits alongside a timed activity on the same date. The time
   * extraction (length > 10 check) must produce time=null for the flight.
   * Despite having no time, the flight (type priority 0) must still sort
   * before the activity (type priority 3).
   */
  it("sorts a date-only flight (time=null) before a timed activity on the same date", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 70,
          tripId: 1,
          airline: "Date Air",
          flightNumber: "DA100",
          departureAirport: "JFK",
          arrivalAirport: "LAX",
          departureDatetime: "2025-09-10",
          arrivalDatetime:   null,
          notes: null,
          confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 71,
          tripId: 1,
          title: "City tour",
          date: "2025-09-10",
          time: "09:00",
          description: null,
          location: "Los Angeles",
          imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(2);

    // The flight must carry null time (no time component in departureDatetime).
    const flight = sep10.find((e: any) => e.type === "flight");
    expect(flight).toBeDefined();
    expect(flight.time).toBeNull();

    // Cross-type priority: flight (0) < activity (3) — flight must sort first.
    expect(sep10[0].type).toBe("flight");
    expect(sep10[0].time).toBeNull();
    expect(sep10[1].type).toBe("activity");
    expect(sep10[1].time).toBe("09:00");
  });

  /**
   * Midnight pickup time edge case:
   *
   * A car rental with pickupDatetime "2025-10-05T00:00" sits alongside an
   * activity that also starts at "00:00" on the same date.  The time
   * extraction must treat T00:00 as the literal time "00:00" (not as
   * "no time given" / null).  Because car_rental (priority 1) ranks above
   * activity (priority 3), the car rental must sort first even though both
   * events carry the same "00:00" time string.
   */
  it("assigns time 00:00 (not null) to a midnight car rental and sorts it before a same-time activity", async () => {
    enqueueTimeline({
      carRentals: [
        {
          id: 70,
          tripId: 1,
          company: "Midnight Rentals",
          pickupLocation: "CDG Airport",
          dropoffLocation: "Paris Centre",
          pickupDatetime: "2025-10-05T00:00",
          dropoffDatetime: "2025-10-08T10:00",
          notes: null,
          confirmationCode: "MR-MIDNIGHT",
        },
      ],
      activities: [
        {
          id: 71,
          tripId: 1,
          title: "Midnight walking tour",
          date: "2025-10-05",
          time: "00:00",
          description: null,
          location: "Paris",
          imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const oct5 = body.filter((e: any) => e.date === "2025-10-05");
    expect(oct5).toHaveLength(2);

    // The car rental must carry the explicit time "00:00", not null.
    const carRental = oct5.find((e: any) => e.type === "car_rental");
    expect(carRental).toBeDefined();
    expect(carRental.time).toBe("00:00");

    // Cross-type priority: car_rental (1) < activity (3) — car rental must sort first.
    expect(oct5[0].type).toBe("car_rental");
    expect(oct5[0].time).toBe("00:00");
    expect(oct5[1].type).toBe("activity");
    expect(oct5[1].time).toBe("00:00");
  });

  /**
   * Date-only pickup edge case:
   *
   * A car rental whose pickupDatetime is a plain date string ("2025-08-01",
   * length === 10) must produce time === null via the `length > 10` guard.
   * The timeline entry must land on the correct date and, when sharing that
   * date with an activity that also has no time, sort before the activity
   * because cross-type priority places car_rental (1) before activity (3).
   */
  it("assigns time null to a date-only car rental and sorts it before a same-day null-time activity", async () => {
    enqueueTimeline({
      carRentals: [
        {
          id: 80,
          tripId: 1,
          company: "Budget Wheels",
          pickupLocation: "Rome Fiumicino",
          dropoffLocation: "Rome Centro",
          pickupDatetime: "2025-08-01",          // no time component — length === 10
          dropoffDatetime: "2025-08-05T09:00",
          notes: null,
          confirmationCode: "BW-NOTIME",
        },
      ],
      activities: [
        {
          id: 81,
          tripId: 1,
          title: "Colosseum tour",
          date: "2025-08-01",
          time: null,                             // also no time — same sort bucket
          description: null,
          location: "Rome",
          imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");

    expect(status).toBe(200);

    const aug1 = body.filter((e: any) => e.date === "2025-08-01");
    expect(aug1).toHaveLength(2);

    // The `length > 10` guard must produce null, not an empty string or "00:00".
    const carRental = aug1.find((e: any) => e.type === "car_rental");
    expect(carRental).toBeDefined();
    expect(carRental.date).toBe("2025-08-01");
    expect(carRental.time).toBeNull();

    // Cross-type priority: car_rental (1) < activity (3) — car rental must sort first.
    expect(aug1[0].type).toBe("car_rental");
    expect(aug1[0].time).toBeNull();
    expect(aug1[1].type).toBe("activity");
    expect(aug1[1].time).toBeNull();
  });

  it("includes events on other dates alongside the shared-date events", async () => {
    enqueueTimeline({
      accommodations: [
        {
          id: 1,
          tripId: 1,
          name: "Hotel Alpha",
          checkIn: "2025-07-10",
          checkOut: "2025-07-15",
          address: "10 Alpha St",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
        {
          id: 2,
          tripId: 1,
          name: "Hotel Beta",
          checkIn: "2025-07-15",
          checkOut: "2025-07-20",
          address: "20 Beta Ave",
          notes: null,
          imageUrl: null,
          confirmationCode: null,
        },
      ],
    });

    const { body } = await get("/trips/1/timeline");

    // All four accommodation events (2 × check-in + 2 × check-out) must be present.
    const accomEvents = body.filter((e: any) => e.type === "accommodation");
    expect(accomEvents).toHaveLength(4);

    // Global sort: 2025-07-10 check-in → 2025-07-15 check-out → 2025-07-15
    // check-in → 2025-07-20 check-out.
    expect(accomEvents[0].date).toBe("2025-07-10");
    expect(accomEvents[0].title).toBe("Check-in: Hotel Alpha");
    expect(accomEvents[1].date).toBe("2025-07-15");
    expect(accomEvents[1].title).toBe("Check-out: Hotel Alpha");
    expect(accomEvents[2].date).toBe("2025-07-15");
    expect(accomEvents[2].title).toBe("Check-in: Hotel Beta");
    expect(accomEvents[3].date).toBe("2025-07-20");
    expect(accomEvents[3].title).toBe("Check-out: Hotel Beta");
  });
});

// ── Write-then-read round-trip ────────────────────────────────────────────────
//
// Verify that the timeline sort is correct after a PATCH changes an event's
// date so it now shares a date with another event type.  The sort runs in
// memory on every GET, so it must produce the right cross-type order
// regardless of when the underlying row was written.
//
// This describe block mounts BOTH the trips router (for GET …/timeline) and
// the reservations router (for PATCH …/reservations/:reservationId) on a
// dedicated server so the full round-trip can be exercised end-to-end.
//
// The session role is set to "super_admin" so the requireTripParticipant
// middleware in the reservations router short-circuits and does NOT enqueue
// an extra DB call — keeping the mock-queue accounting simple.

describe("PATCH reservation date → GET timeline — sort preserved after write-then-read", () => {
  let server2: http.Server;
  let base2: string;

  beforeAll(async () => {
    const { default: tripsRouter }        = await import("./trips.js");
    const { default: reservationsRouter } = await import("./reservations.js");

    const app2 = express();
    app2.use(express.json());

    // super_admin bypasses the participant-check DB query inside requireTripParticipant.
    app2.use((req: any, _res, next) => {
      req.session = { userId: 1, role: "super_admin" };
      next();
    });

    app2.use("/api", tripsRouter);
    app2.use("/api", reservationsRouter);

    await new Promise<void>(resolve => {
      server2 = http.createServer(app2).listen(0, resolve);
    });
    const addr = server2.address() as { port: number };
    base2 = `http://localhost:${addr.port}/api`;
  });

  afterAll(() => server2.close());

  async function patch2(path: string, body: Record<string, unknown>) {
    const res = await fetch(`${base2}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  async function get2(path: string) {
    const res = await fetch(`${base2}${path}`);
    return { status: res.status, body: await res.json() as any[] };
  }

  /**
   * Round-trip scenario:
   *
   * 1. A flight exists on 2025-08-01.
   * 2. A reservation originally lives on 2025-09-01 (different date).
   * 3. PATCH moves the reservation's date to 2025-08-01.
   * 4. GET /timeline now sees both on the same date — flight must sort first
   *    because its cross-type priority (0) is lower than reservation's (4).
   */
  it("flight precedes reservation after the reservation's date is patched to match the flight's date", async () => {
    // ── Step 1: PATCH the reservation's date ──────────────────────────────
    //
    // With super_admin role, requireTripParticipant makes NO db.select() call.
    // The only DB call is db.update(reservationsTable).set(...).where(...).returning().
    // Enqueue the single array that the route's .returning() will dequeue.
    const updatedReservationRow = {
      id: 30, tripId: 1, type: "restaurant",
      title: "Dinner at Maison", venue: "Maison", address: null,
      date: "2025-08-01", time: null, endTime: null,
      confirmationCode: null, numberOfPeople: null, phone: null,
      notes: null, url: null, imageUrl: null, lat: null, lon: null,
    };
    enqueue([updatedReservationRow]);  // consumed by db.update().returning()

    const patchRes = await patch2("/trips/1/reservations/30", {
      title: "Dinner at Maison",
      date:  "2025-08-01",
    });
    expect(patchRes.status).toBe(200);

    // ── Step 2: GET the timeline ──────────────────────────────────────────
    //
    // Enqueue the six arrays consumed by the Promise.all in the timeline handler
    // (flights, accommodations, activities, itinerary, carRentals, reservations).
    // The reservation now appears with the updated date 2025-08-01.
    enqueueTimeline({
      flights: [
        {
          id: 10, tripId: 1,
          airline: "Sky Air", flightNumber: "SK100",
          departureAirport: "JFK", arrivalAirport: "CDG",
          departureDatetime: "2025-08-01",
          arrivalDatetime:   "2025-08-02",
          notes: null, confirmationCode: null,
        },
      ],
      reservations: [
        {
          id: 30, tripId: 1,
          title: "Dinner at Maison",
          date:  "2025-08-01",   // ← updated date (was 2025-09-01 before the PATCH)
          time: null, notes: null, address: null, venue: "Maison",
          imageUrl: null, confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get2("/trips/1/timeline");
    expect(status).toBe(200);

    const aug1 = body.filter((e: any) => e.date === "2025-08-01");
    expect(aug1).toHaveLength(2);

    // Cross-type priority: flight (0) < reservation (4) — flight must be first.
    expect(aug1[0].type).toBe("flight");
    expect(aug1[1].type).toBe("reservation");
    expect(aug1[1].title).toBe("Dinner at Maison");
  });
});

// ── PATCH car rental pickupDatetime → three-way tie ──────────────────────────
//
// Verify that editing a car rental's pickupDatetime so it collides with an
// existing activity and reservation produces the correct cross-type priority
// order: car_rental (1) → activity (3) → reservation (4).
//
// A dedicated server (server3) mounts both the trips router (GET …/timeline)
// and the carRentals router (PATCH …/car-rentals/:carRentalId).  The session
// role is "super_admin" so requireTripParticipant short-circuits without
// making an extra DB select call.

describe("PATCH car rental pickupDatetime → GET timeline — priority order preserved after three-way tie", () => {
  let server3: http.Server;
  let base3: string;

  beforeAll(async () => {
    const { default: tripsRouter }      = await import("./trips.js");
    const { default: carRentalsRouter } = await import("./carRentals.js");

    const app3 = express();
    app3.use(express.json());

    // super_admin bypasses the participant-check DB query inside requireTripParticipant.
    app3.use((req: any, _res, next) => {
      req.session = { userId: 1, role: "super_admin" };
      next();
    });

    app3.use("/api", tripsRouter);
    app3.use("/api", carRentalsRouter);

    await new Promise<void>(resolve => {
      server3 = http.createServer(app3).listen(0, resolve);
    });
    const addr = server3.address() as { port: number };
    base3 = `http://localhost:${addr.port}/api`;
  });

  afterAll(() => server3.close());

  async function patch3(path: string, body: Record<string, unknown>) {
    const res = await fetch(`${base3}${path}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: await res.json() as any };
  }

  async function get3(path: string) {
    const res = await fetch(`${base3}${path}`);
    return { status: res.status, body: await res.json() as any[] };
  }

  /**
   * Round-trip scenario:
   *
   * 1. An activity and a reservation already exist on 2025-10-15 at 09:00.
   * 2. A car rental originally has pickupDatetime "2025-10-20T09:00:00"
   *    (a different date — no collision yet).
   * 3. PATCH changes the car rental's pickupDatetime to "2025-10-15T09:00:00".
   * 4. GET /timeline now sees all three events on 2025-10-15 at 09:00.
   *    Cross-type priority must produce: car_rental (1) → activity (3) → reservation (4).
   */
  it("car_rental precedes activity and reservation after pickupDatetime is patched to match their date and time", async () => {
    // ── Step 1: PATCH the car rental's pickupDatetime ─────────────────────
    //
    // With super_admin role, requireTripParticipant makes NO db.select() call.
    // The only DB call is db.update(carRentalsTable).set(...).where(...).returning().
    // Enqueue the single array that the route's .returning() will dequeue.
    const updatedCarRentalRow = {
      id: 40, tripId: 1,
      company: "FastWheels", pickupLocation: "Airport Terminal 1",
      dropoffLocation: null,
      pickupDatetime:  "2025-10-15T09:00:00",   // ← updated (was 2025-10-20T09:00:00)
      dropoffDatetime: "2025-10-18T09:00:00",
      carType: "economy",
      confirmationCode: null, driverName: null, phone: null,
      lat: null, lon: null, imageUrl: null, notes: null,
    };
    enqueue([updatedCarRentalRow]); // consumed by db.update().returning()

    const patchRes = await patch3("/trips/1/car-rentals/40", {
      pickupDatetime: "2025-10-15T09:00:00",
    });
    expect(patchRes.status).toBe(200);

    // The PATCH response must carry the edited pickupDatetime so callers can
    // observe the mutation.  Assert it before proceeding so a regression where
    // the update silently ignores the new datetime fails here, not in the
    // ordering assertions below.
    expect(patchRes.body.pickupDatetime).toBe("2025-10-15T09:00:00");

    // ── Step 2: GET the timeline ──────────────────────────────────────────
    //
    // Derive the car rental's pickupDatetime from the PATCH response rather
    // than re-hardcoding "2025-10-15T09:00:00".  This makes the GET seed
    // stateful with respect to what the PATCH actually returned, so a bug
    // that returns the wrong datetime would also break the ordering assertions
    // (the extracted date/time would no longer match the activity/reservation).
    //
    // Enqueue the six arrays consumed by the Promise.all in the timeline handler
    // (flights, accommodations, activities, itinerary, carRentals, reservations).
    const updatedPickupDatetime: string = patchRes.body.pickupDatetime;

    enqueueTimeline({
      activities: [
        {
          id: 20, tripId: 1,
          title: "City Walking Tour",
          date: "2025-10-15", time: "09:00",
          description: null, location: "Old Town", imageUrl: null,
        },
      ],
      carRentals: [
        {
          id: 40, tripId: 1,
          company: "FastWheels", pickupLocation: "Airport Terminal 1",
          pickupDatetime:  updatedPickupDatetime,   // ← derived from PATCH response
          dropoffDatetime: "2025-10-18T09:00:00",
          confirmationCode: null,
        },
      ],
      reservations: [
        {
          id: 50, tripId: 1,
          title: "Rooftop Brunch",
          date: "2025-10-15", time: "09:00",
          notes: null, address: null, venue: "Sky Lounge",
          imageUrl: null, confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get3("/trips/1/timeline");
    expect(status).toBe(200);

    const oct15at09 = body.filter(
      (e: any) => e.date === "2025-10-15" && e.time === "09:00",
    );
    expect(oct15at09).toHaveLength(3);

    // Cross-type priority: car_rental (1) < activity (3) < reservation (4).
    expect(oct15at09[0].type).toBe("car_rental");
    expect(oct15at09[0].title).toBe("FastWheels pick-up");

    expect(oct15at09[1].type).toBe("activity");
    expect(oct15at09[1].title).toBe("City Walking Tour");

    expect(oct15at09[2].type).toBe("reservation");
    expect(oct15at09[2].title).toBe("Rooftop Brunch");
  });
});

// ── Day-boundary flight tests ─────────────────────────────────────────────────

describe("GET /trips/:tripId/timeline — day-boundary flights (23:59 vs 00:00 next day)", () => {
  /**
   * A connecting itinerary where the first flight departs at 23:59 on day D
   * and the second departs at 00:00 on day D+1. The two departures must land
   * on different calendar dates and appear in the correct chronological order.
   */
  it("places a 23:59 departure on its own date, separate from the 00:00 departure on the next day", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 1, tripId: 1,
          airline: "Night Air", flightNumber: "NA001",
          departureAirport: "LHR", arrivalAirport: "DXB",
          departureDatetime: "2025-09-10T23:59:00",
          arrivalDatetime:   "2025-09-11T05:30:00",
          notes: null, confirmationCode: null,
        },
        {
          id: 2, tripId: 1,
          airline: "Dawn Air", flightNumber: "DA002",
          departureAirport: "DXB", arrivalAirport: "SYD",
          departureDatetime: "2025-09-11T00:00:00",
          arrivalDatetime:   "2025-09-11T22:00:00",
          notes: null, confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    const sep11 = body.filter((e: any) => e.date === "2025-09-11");

    // Each flight lands on its own calendar date — they must not collapse.
    expect(sep10).toHaveLength(1);
    expect(sep11).toHaveLength(1);
  });

  it("assigns the 23:59 flight to date D and the 00:00 flight to date D+1", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 1, tripId: 1,
          airline: "Night Air", flightNumber: "NA001",
          departureAirport: "LHR", arrivalAirport: "DXB",
          departureDatetime: "2025-09-10T23:59:00",
          arrivalDatetime:   "2025-09-11T05:30:00",
          notes: null, confirmationCode: null,
        },
        {
          id: 2, tripId: 1,
          airline: "Dawn Air", flightNumber: "DA002",
          departureAirport: "DXB", arrivalAirport: "SYD",
          departureDatetime: "2025-09-11T00:00:00",
          arrivalDatetime:   "2025-09-11T22:00:00",
          notes: null, confirmationCode: null,
        },
      ],
    });

    const { body } = await get("/trips/1/timeline");

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    const sep11 = body.filter((e: any) => e.date === "2025-09-11");

    expect(sep10[0].type).toBe("flight");
    expect(sep10[0].title).toBe("Night Air NA001: LHR → DXB");

    expect(sep11[0].type).toBe("flight");
    expect(sep11[0].title).toBe("Dawn Air DA002: DXB → SYD");
  });

  it("preserves the time value for both boundary flights", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 1, tripId: 1,
          airline: "Night Air", flightNumber: "NA001",
          departureAirport: "LHR", arrivalAirport: "DXB",
          departureDatetime: "2025-09-10T23:59:00",
          arrivalDatetime:   "2025-09-11T05:30:00",
          notes: null, confirmationCode: null,
        },
        {
          id: 2, tripId: 1,
          airline: "Dawn Air", flightNumber: "DA002",
          departureAirport: "DXB", arrivalAirport: "SYD",
          departureDatetime: "2025-09-11T00:00:00",
          arrivalDatetime:   "2025-09-11T22:00:00",
          notes: null, confirmationCode: null,
        },
      ],
    });

    const { body } = await get("/trips/1/timeline");

    const lhr = body.find((e: any) => e.title === "Night Air NA001: LHR → DXB");
    const dxb = body.find((e: any) => e.title === "Dawn Air DA002: DXB → SYD");

    expect(lhr.time).toBe("23:59");
    expect(dxb.time).toBe("00:00");
  });

  it("returns events in chronological date order (D before D+1)", async () => {
    // Enqueue with the later flight listed first in the DB result to confirm
    // the route does not rely on DB insertion order for date sorting.
    enqueueTimeline({
      flights: [
        {
          id: 2, tripId: 1,
          airline: "Dawn Air", flightNumber: "DA002",
          departureAirport: "DXB", arrivalAirport: "SYD",
          departureDatetime: "2025-09-11T00:00:00",
          arrivalDatetime:   "2025-09-11T22:00:00",
          notes: null, confirmationCode: null,
        },
        {
          id: 1, tripId: 1,
          airline: "Night Air", flightNumber: "NA001",
          departureAirport: "LHR", arrivalAirport: "DXB",
          departureDatetime: "2025-09-10T23:59:00",
          arrivalDatetime:   "2025-09-11T05:30:00",
          notes: null, confirmationCode: null,
        },
      ],
    });

    const { body } = await get("/trips/1/timeline");

    const flights = body.filter((e: any) => e.type === "flight");
    expect(flights).toHaveLength(2);
    // The 23:59 departure on Sep 10 must precede the 00:00 departure on Sep 11.
    expect(flights[0].date).toBe("2025-09-10");
    expect(flights[1].date).toBe("2025-09-11");
  });

  /**
   * After-midnight arrival edge case:
   *
   * A flight departs at 23:00 on day D (2025-11-15) and arrives at 01:30 on
   * day D+1 (2025-11-16). The timeline entry must be placed on the departure
   * date (day D), not the arrival date. The arrival crosses midnight but the
   * event should not "leak" onto 2025-11-16.
   *
   * Additionally, if the server ever exposes arrivalDate as a distinct field,
   * it must equal "2025-11-16" (day D+1) — not the departure date.
   */
  it("places a flight with an after-midnight arrival on the departure date, not the arrival date", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 50, tripId: 1,
          airline: "Red Eye Air", flightNumber: "RE123",
          departureAirport: "LAX", arrivalAirport: "JFK",
          departureDatetime: "2025-11-15T23:00:00",
          arrivalDatetime:   "2025-11-16T01:30:00",
          notes: null, confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    // The flight must appear exactly once, on the departure date (day D).
    const nov15 = body.filter((e: any) => e.date === "2025-11-15");
    const nov16 = body.filter((e: any) => e.date === "2025-11-16");

    expect(nov15).toHaveLength(1);
    expect(nov15[0].type).toBe("flight");
    expect(nov15[0].title).toBe("Red Eye Air RE123: LAX → JFK");

    // The arrival crosses midnight but must NOT produce an event on day D+1.
    expect(nov16).toHaveLength(0);
  });

  it("preserves the departure time (23:00) for a flight that arrives after midnight", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 51, tripId: 1,
          airline: "Red Eye Air", flightNumber: "RE123",
          departureAirport: "LAX", arrivalAirport: "JFK",
          departureDatetime: "2025-11-15T23:00:00",
          arrivalDatetime:   "2025-11-16T01:30:00",
          notes: null, confirmationCode: null,
        },
      ],
    });

    const { body } = await get("/trips/1/timeline");

    const flight = body.find((e: any) => e.type === "flight");
    expect(flight).toBeDefined();

    // date must be the departure date, not the arrival date.
    expect(flight.date).toBe("2025-11-15");

    // time must be the departure time extracted from departureDatetime.
    expect(flight.time).toBe("23:00");

    // If arrivalDate is ever exposed as a separate field, it must be day D+1.
    if ("arrivalDate" in flight) {
      expect(flight.arrivalDate).toBe("2025-11-16");
    }
  });
});

// ── Date-only activity alongside timed/date-only flights and car rentals ────────

describe("GET /trips/:tripId/timeline — date-only activity sorting", () => {
  /**
   * Core scenario from task #108: a flight stored with only a date
   * (departureDatetime = "2025-09-10", length ≤ 10 → time=null) and an
   * activity with date="2025-09-10" and time=null both land on the same
   * calendar date.  The flight must precede the activity because its
   * eventPriority (0) is lower than an activity's (3), even though both
   * carry time=null.
   */
  it("places a date-only flight before a null-time activity on the same date", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 1, tripId: 1,
          airline: "Simple Air", flightNumber: "SA001",
          departureAirport: "JFK", arrivalAirport: "LAX",
          departureDatetime: "2025-09-10",   // date-only — no time component
          arrivalDatetime:   null,
          notes: null, confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 2, tripId: 1,
          title: "Beach Walk",
          date: "2025-09-10", time: null,    // explicit null time
          description: null, location: "Santa Monica", imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(2);

    // Both events carry time: null because neither has a time component.
    expect(sep10[0].time).toBeNull();
    expect(sep10[1].time).toBeNull();

    // Flight (priority 0) must precede activity (priority 3).
    expect(sep10[0].type).toBe("flight");
    expect(sep10[0].title).toBe("Simple Air SA001: JFK → LAX");

    expect(sep10[1].type).toBe("activity");
    expect(sep10[1].title).toBe("Beach Walk");
  });

  /**
   * A timed flight (departureDatetime has a real time component, e.g. 08:30)
   * and a null-time activity on the same calendar date.  When exactly one
   * event lacks a time, type priority decides the order rather than
   * normalising null to "00:00" — this prevents a null-time activity from
   * accidentally appearing before a timed flight.  Flight (priority 0) must
   * appear before activity (priority 3) even though the flight departs at
   * 08:30 while the activity carries no time at all.
   */
  it("places a timed flight before a null-time activity on the same date (type priority applied when one side lacks a time)", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 3, tripId: 1,
          airline: "Morning Air", flightNumber: "MA010",
          departureAirport: "BOS", arrivalAirport: "SFO",
          departureDatetime: "2025-09-10T08:30:00",  // real departure time
          arrivalDatetime:   "2025-09-10T14:00:00",
          notes: null, confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 4, tripId: 1,
          title: "Harbor Tour",
          date: "2025-09-10", time: null,  // no time → type priority decides
          description: null, location: "San Francisco Bay", imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(2);

    // Flight (priority 0) precedes activity (priority 3) — type priority
    // is applied when exactly one event lacks a time.
    expect(sep10[0].type).toBe("flight");
    expect(sep10[0].time).toBe("08:30");
    expect(sep10[0].title).toBe("Morning Air MA010: BOS → SFO");

    // Null-time activity follows the timed flight.
    expect(sep10[1].type).toBe("activity");
    expect(sep10[1].time).toBeNull();
    expect(sep10[1].title).toBe("Harbor Tour");
  });

  /**
   * Timed car rental pickup and a null-time activity on the same date.
   * When exactly one event lacks a time, type priority decides the order.
   * Car rental (priority 1) must appear before activity (priority 3)
   * even though the pickup is at 10:00 and the activity carries no time.
   */
  it("places a timed car rental pickup before a null-time activity on the same date (type priority applied when one side lacks a time)", async () => {
    enqueueTimeline({
      carRentals: [
        {
          id: 5, tripId: 1,
          company: "SpeedRent", pickupLocation: "Terminal 3",
          pickupDatetime:  "2025-09-10T10:00:00",  // real pickup time
          dropoffDatetime: "2025-09-14T10:00:00",
          confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 6, tripId: 1,
          title: "City Tour",
          date: "2025-09-10", time: null,  // no time → type priority decides
          description: null, location: "Downtown", imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(2);

    // Car rental (priority 1) precedes activity (priority 3) — type priority
    // is applied when exactly one event lacks a time.
    expect(sep10[0].type).toBe("car_rental");
    expect(sep10[0].time).toBe("10:00");

    // Null-time activity follows the timed car rental.
    expect(sep10[1].type).toBe("activity");
    expect(sep10[1].time).toBeNull();
  });

  /**
   * Chronological regression guard: when both events carry explicit times,
   * the earlier time must win even if the later event has a lower type
   * priority.  A car pickup at 06:00 must appear before a flight at 08:30
   * because 06:00 < 08:30, even though flight has a higher priority (0) than
   * car_rental (1).
   */
  it("keeps chronological order for two timed events of different types (earlier time wins)", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 9, tripId: 1,
          airline: "Quick Air", flightNumber: "QA050",
          departureAirport: "LAX", arrivalAirport: "ORD",
          departureDatetime: "2025-09-10T08:30:00",  // later in the day
          arrivalDatetime:   "2025-09-10T14:00:00",
          notes: null, confirmationCode: null,
        },
      ],
      carRentals: [
        {
          id: 10, tripId: 1,
          company: "EarlyBird Cars", pickupLocation: "Hotel Lobby",
          pickupDatetime:  "2025-09-10T06:00:00",  // earlier in the day
          dropoffDatetime: "2025-09-10T09:00:00",
          confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(2);

    // Car rental at 06:00 sorts before flight at 08:30 — both timed, so
    // chronological order applies; type priority is not the tie-break here.
    expect(sep10[0].type).toBe("car_rental");
    expect(sep10[0].time).toBe("06:00");

    expect(sep10[1].type).toBe("flight");
    expect(sep10[1].time).toBe("08:30");
  });

  it("keeps chronological order when an activity's explicit time precedes a timed flight", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 11, tripId: 1,
          airline: "Late Air", flightNumber: "LA099",
          departureAirport: "SFO", arrivalAirport: "JFK",
          departureDatetime: "2025-09-10T21:00:00",  // evening departure
          arrivalDatetime:   null,
          notes: null, confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 12, tripId: 1,
          title: "Morning Yoga",
          date: "2025-09-10", time: "07:00",  // early morning — has an explicit time
          description: null, location: "Beach", imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(2);

    // Activity at 07:00 sorts before the 21:00 flight — chronological order
    // prevails when both events carry explicit times.
    expect(sep10[0].type).toBe("activity");
    expect(sep10[0].time).toBe("07:00");

    expect(sep10[1].type).toBe("flight");
    expect(sep10[1].time).toBe("21:00");
  });

  /**
   * Three-event regression: date-only flight (null), null-time activity, and
   * a timed activity — all on the same calendar date.
   *
   * Sort-key policy (date → normalised-time → type-priority):
   *   - date-only flight   → "2025-09-10", "00:00", priority 0
   *   - null-time activity → "2025-09-10", "00:00", priority 3
   *   - timed activity     → "2025-09-10", "09:00", priority 3
   *
   * Expected order:
   *   1. date-only flight (00:00, priority 0)
   *   2. null-time activity (00:00, priority 3)
   *   3. timed activity (09:00)
   *
   * This is fully transitive: a < b (type priority at equal time),
   * b < c (time), and a < c (time).
   */
  it("orders a date-only flight, null-time activity, and timed activity correctly (three-event transitivity)", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 20, tripId: 1,
          airline: "Plain Air", flightNumber: "PL001",
          departureAirport: "DEN", arrivalAirport: "SEA",
          departureDatetime: "2025-09-10",    // date-only
          arrivalDatetime:   null,
          notes: null, confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 21, tripId: 1,
          title: "Sunrise Hike",
          date: "2025-09-10", time: null,     // null-time
          description: null, location: "Mountain Trail", imageUrl: null,
        },
        {
          id: 22, tripId: 1,
          title: "Coffee Tour",
          date: "2025-09-10", time: "09:00",  // explicit time
          description: null, location: "Cafe District", imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(3);

    // 1. date-only flight: time=null, type priority 0.
    expect(sep10[0].type).toBe("flight");
    expect(sep10[0].time).toBeNull();
    expect(sep10[0].title).toBe("Plain Air PL001: DEN → SEA");

    // 2. null-time activity: time=null, type priority 3 (tie-break after flight).
    expect(sep10[1].type).toBe("activity");
    expect(sep10[1].time).toBeNull();
    expect(sep10[1].title).toBe("Sunrise Hike");

    // 3. timed activity: time="09:00" → sorts after the "00:00" slot.
    expect(sep10[2].type).toBe("activity");
    expect(sep10[2].time).toBe("09:00");
    expect(sep10[2].title).toBe("Coffee Tour");
  });

  /**
   * Regression guard: a date-only car rental pickup (pickupDatetime length
   * ≤ 10 → time=null) and a null-time activity on the same date must also
   * respect the car_rental(1) < activity(3) priority order.
   */
  it("places a date-only car rental pickup before a null-time activity on the same date", async () => {
    enqueueTimeline({
      carRentals: [
        {
          id: 7, tripId: 1,
          company: "EasyCar", pickupLocation: "Airport",
          pickupDatetime:  "2025-09-10",    // date-only pickup
          dropoffDatetime: "2025-09-15",
          confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 8, tripId: 1,
          title: "Museum Visit",
          date: "2025-09-10", time: null,
          description: null, location: "City Center", imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(2);

    // Both carry time: null.
    expect(sep10[0].time).toBeNull();
    expect(sep10[1].time).toBeNull();

    // Car rental (priority 1) must precede activity (priority 3).
    expect(sep10[0].type).toBe("car_rental");
    expect(sep10[1].type).toBe("activity");
  });

  /**
   * A timed flight (14:30) and a null-time activity share the same date.
   * The comparator normalises null time to "00:00", which would accidentally
   * place a null-time activity before the 14:30 flight unless type priority
   * is applied first.  Flight (priority 0) must always precede activity
   * (priority 3) regardless of the time values involved.
   */
  it("places a timed flight before a null-time activity on the same date (type priority beats null-time normalisation)", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 30, tripId: 1,
          airline: "Sky Air", flightNumber: "SK500",
          departureAirport: "LAX", arrivalAirport: "ORD",
          departureDatetime: "2025-09-10T14:30:00",
          arrivalDatetime:   null,
          notes: null, confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 31, tripId: 1,
          title: "Afternoon Walk",
          date: "2025-09-10", time: null,    // null-time → normalises to "00:00"
          description: null, location: "Riverwalk", imageUrl: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    const sep10 = body.filter((e: any) => e.date === "2025-09-10");
    expect(sep10).toHaveLength(2);

    // Flight carries its real departure time; activity carries null.
    expect(sep10[0].type).toBe("flight");
    expect(sep10[0].time).toBe("14:30");
    expect(sep10[0].title).toBe("Sky Air SK500: LAX → ORD");

    // Despite null being normalised to "00:00" (< 14:30), type priority
    // keeps the activity after the flight.
    expect(sep10[1].type).toBe("activity");
    expect(sep10[1].time).toBeNull();
    expect(sep10[1].title).toBe("Afternoon Walk");
  });
});

// ── Five-way same-datetime tie-break ──────────────────────────────────────────

describe("GET /trips/:tripId/timeline — five-way same-datetime priority order", () => {
  /**
   * All five user-facing event types (flight, car_rental, accommodation,
   * activity, reservation) land on the same calendar date.  Accommodation
   * events always carry time: null which the comparator treats as "00:00",
   * so placing the remaining four event types at 00:00 creates a true
   * five-way collision.
   *
   * Expected order (by eventPriority): flight(0) → car_rental(1) →
   *   accommodation(2) → activity(3) → reservation(4).
   */
  it("orders all five event types correctly when they share the same date and time", async () => {
    enqueueTimeline({
      flights: [
        {
          id: 10, tripId: 1,
          airline: "Atlas Air", flightNumber: "AT100",
          departureAirport: "JFK", arrivalAirport: "CDG",
          departureDatetime: "2025-12-01T00:00:00",
          arrivalDatetime:   "2025-12-01T12:00:00",
          notes: null, confirmationCode: null,
        },
      ],
      accommodations: [
        {
          id: 20, tripId: 1,
          name: "Grand Hotel",
          checkIn:  "2025-12-01",
          checkOut: "2025-12-05",
          address: "1 Rue de Rivoli", notes: null,
          imageUrl: null, confirmationCode: null,
        },
      ],
      activities: [
        {
          id: 30, tripId: 1,
          title: "Museum Tour",
          date: "2025-12-01", time: "00:00",
          description: null, location: "Louvre", imageUrl: null,
        },
      ],
      carRentals: [
        {
          id: 40, tripId: 1,
          company: "SpeedCar", pickupLocation: "CDG Terminal 2",
          pickupDatetime:  "2025-12-01T00:00:00",
          dropoffDatetime: "2025-12-05T00:00:00",
          confirmationCode: null,
        },
      ],
      reservations: [
        {
          id: 50, tripId: 1,
          title: "Welcome Dinner",
          date: "2025-12-01", time: "00:00",
          notes: null, address: null, venue: "Café de Flore",
          imageUrl: null, confirmationCode: null,
        },
      ],
    });

    const { status, body } = await get("/trips/1/timeline");
    expect(status).toBe(200);

    // Collect all events on 2025-12-01 at time 00:00 (accommodations carry
    // time: null which the comparator normalises to "00:00").
    const dec01 = body.filter(
      (e: any) =>
        e.date === "2025-12-01" &&
        (e.time === "00:00" || e.time === null),
    );

    // Exactly five events must be present (the check-out for Grand Hotel falls
    // on 2025-12-05, so only the check-in lands on 2025-12-01).
    expect(dec01).toHaveLength(5);

    // Priority order: flight(0) → car_rental(1) → accommodation(2) → activity(3) → reservation(4).
    expect(dec01[0].type).toBe("flight");
    expect(dec01[0].title).toBe("Atlas Air AT100: JFK → CDG");

    expect(dec01[1].type).toBe("car_rental");
    expect(dec01[1].title).toBe("SpeedCar pick-up");

    expect(dec01[2].type).toBe("accommodation");
    expect(dec01[2].title).toBe("Check-in: Grand Hotel");

    expect(dec01[3].type).toBe("activity");
    expect(dec01[3].title).toBe("Museum Tour");

    expect(dec01[4].type).toBe("reservation");
    expect(dec01[4].title).toBe("Welcome Dinner");
  });
});
