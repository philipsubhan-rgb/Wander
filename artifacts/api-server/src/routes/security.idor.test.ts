/**
 * Regression tests for the Sep 2026 IDOR fixes:
 *
 *  1. Sub-resource GETs (flights, accommodations, car-rentals, activities,
 *     itinerary, reservations) and the trips sub-resource GETs (summary,
 *     timeline, participants) must require trip membership — a logged-in user
 *     who is not on the trip gets 403 instead of the trip's data.
 *  2. PATCH /trips/:tripId/reservations/:reservationId must scope the update
 *     to the trip (and(id, tripId)), so a participant on trip A cannot
 *     overwrite a reservation belonging to trip B.
 *
 * Strategy: same lazy-dequeue @workspace/db mock as the other route tests.
 * Sessions use a NON-admin user (userId 2, role "user") so
 * requireTripParticipant() actually hits the mocked membership query.
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Mock drizzle-orm operators ────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq:  (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  ne:  (...args: unknown[]) => args,
  asc: (...args: unknown[]) => args,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    ({ sql: String(strings[0]), values }),
  count: () => "count_placeholder",
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash:    async (_pwd: string, _rounds: number) => "hashed-password",
    compare: async (a: string, b: string) => a === b,
  },
}));

// ── Lazy-dequeue DB mock (captures where() args for scoping assertions) ───────

const resultQueue: unknown[] = [];
const whereCalls: unknown[][] = [];

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
  for (const m of [
    "from", "innerJoin", "leftJoin", "orderBy",
    "set", "values", "returning", "onConflictDoNothing",
  ]) {
    chain[m] = () => chain;
  }
  chain.where = (...args: unknown[]) => { whereCalls.push(args); return chain; };
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

vi.mock("../lib/destination-image.js", () => ({
  fetchDestinationImage: async () => null,
}));

// ── Test apps (non-admin session → membership check runs) ────────────────────

async function buildApp(routerPath: string) {
  const { default: router } = await import(routerPath);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = { userId: 2, role: "user" };
    next();
  });
  app.use("/api", router);
  return app;
}

let flightsBase = "";
let reservationsBase = "";
let tripsBase = "";
let servers: http.Server[] = [];

beforeAll(async () => {
  const [flightsApp, reservationsApp, tripsApp] = await Promise.all([
    buildApp("./flights.js"),
    buildApp("./reservations.js"),
    buildApp("./trips.js"),
  ]);
  const bases: string[] = [];
  for (const app of [flightsApp, reservationsApp, tripsApp]) {
    const server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, resolve));
    servers.push(server);
    bases.push(`http://localhost:${(server.address() as { port: number }).port}/api`);
  }
  [flightsBase, reservationsBase, tripsBase] = bases;
});

afterAll(() => { for (const s of servers) s.close(); });

beforeEach(() => { resultQueue.length = 0; whereCalls.length = 0; });

async function get(base: string, path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

describe("sub-resource GETs require trip membership", () => {
  it("GET /trips/1/flights → 403 for a non-participant", async () => {
    resultQueue.push([]); // membership check: not a participant
    const { status, body } = await get(flightsBase, "/trips/1/flights");
    expect(status).toBe(403);
    expect(body.error).toMatch(/access/i);
  });

  it("GET /trips/1/flights → 200 for a participant", async () => {
    resultQueue.push([{ tripId: 1, userId: 2 }]); // membership check: participant
    resultQueue.push([]);                          // flights query
    const { status } = await get(flightsBase, "/trips/1/flights");
    expect(status).toBe(200);
  });

  it("GET /trips/1/reservations → 403 for a non-participant", async () => {
    resultQueue.push([]); // membership check: not a participant
    const { status } = await get(reservationsBase, "/trips/1/reservations");
    expect(status).toBe(403);
  });

  it("GET /trips/1/timeline → 403 for a non-participant", async () => {
    resultQueue.push([]); // membership check: not a participant
    const { status } = await get(tripsBase, "/trips/1/timeline");
    expect(status).toBe(403);
  });

  it("GET /trips/1/participants → 403 for a non-participant", async () => {
    resultQueue.push([]); // membership check: not a participant
    const { status } = await get(tripsBase, "/trips/1/participants");
    expect(status).toBe(403);
  });
});

describe("PATCH /trips/:tripId/reservations/:reservationId is trip-scoped", () => {
  it("scopes the update WHERE clause to both reservation id and trip id", async () => {
    resultQueue.push([{ tripId: 1, userId: 2 }]); // membership check: participant of trip 1
    resultQueue.push([]);                          // update returns nothing → 404

    const res = await fetch(`${reservationsBase}/trips/1/reservations/99`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Hijacked", date: "2026-09-24" }),
    });
    expect(res.status).toBe(404);

    // The update's WHERE must mention BOTH the reservation id (99) and the
    // trip id (1). whereCalls[0] is the membership check; whereCalls[1] is
    // the update.
    expect(whereCalls.length).toBeGreaterThanOrEqual(2);
    const updateWhere = JSON.stringify(whereCalls[1]);
    expect(updateWhere).toContain("99");
    expect(updateWhere).toContain("tripId");
    // And the trip id value 1 must be bound in the same clause (guards
    // against a regression that scopes by id alone).
    expect(updateWhere).toMatch(/tripId.*1|1.*tripId/);
  });
});
