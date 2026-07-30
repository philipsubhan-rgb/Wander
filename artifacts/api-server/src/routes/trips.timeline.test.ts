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
