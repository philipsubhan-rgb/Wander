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
