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
