/**
 * Integration tests: drag-and-drop sort order persistence
 *
 * Covers:
 *   1. POST /trips/:tripId/activities/reorder — verifies the reorder endpoint
 *      writes sort_order values to every activity in the supplied id list.
 *   2. GET /trips/:tripId/timeline sort-order tiebreaker — verifies that after
 *      a reorder (simulated by activities carrying different sortOrder values)
 *      the timeline returns activities in the expected sequence rather than by
 *      insertion order or id.
 *   3. Reservations are covered by the same sort logic (_sortOrder tiebreaker).
 *   4. The id fallback fires when every activity has a null sort_order.
 *
 * Strategy: mock @workspace/db with the lazy-dequeue chainable fake used
 * across all route tests. Mount the relevant router on a minimal Express app
 * that injects a fake session, then drive requests with Node's built-in fetch.
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Mock drizzle-orm operators ────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq:  (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  sql: (...args: unknown[]) => args,
  asc: (...args: unknown[]) => args,
}));

// ── Chainable DB mock ─────────────────────────────────────────────────────────
//
// Lazy dequeue: the promise is not created (and the queue not drained) until
// the chain is first awaited.  This is critical for Promise.all — all chains
// are constructed before any resolves, so dequeue order matches construction
// order inside the route.

const resultQueue: unknown[] = [];

function enqueue(...items: unknown[]) {
  resultQueue.push(...items);
}

// Track every db.update() call so the reorder tests can inspect arguments.
const updateCalls: { setArgs: unknown; whereArgs: unknown }[] = [];

// Track WHERE args passed to db.select() so isolation tests can assert the
// date filter is present and scoped to the correct date.
const selectWhereCalls: unknown[] = [];

function makeChain(captureSet = false, captureWhere = false): any {
  let p: Promise<unknown> | null = null;
  let capturedSet: unknown;
  let capturedWhere: unknown;

  function promise() {
    if (!p) p = Promise.resolve(resultQueue.shift() ?? []);
    return p;
  }

  const chain: any = {
    then:    (res: any, rej: any) => promise().then(res, rej),
    catch:   (rej: any)           => promise().catch(rej),
    finally: (fin: any)           => promise().finally(fin),
  };

  for (const m of ["from", "innerJoin", "leftJoin", "orderBy", "values", "returning"]) {
    chain[m] = () => chain;
  }

  chain.set = (args: unknown) => {
    capturedSet = args;
    return chain;
  };
  chain.where = (args: unknown) => {
    capturedWhere = args;
    if (captureSet) {
      updateCalls.push({ setArgs: capturedSet, whereArgs: capturedWhere });
    }
    if (captureWhere) {
      selectWhereCalls.push(args);
    }
    return chain;
  };

  return chain;
}

const fakeTable = new Proxy({}, { get: (_t, p) => p });

const mockDb = {
  select: vi.fn(() => makeChain(/* captureSet = */ false, /* captureWhere = */ true)),
  insert: vi.fn(() => makeChain()),
  update: vi.fn(() => makeChain(/* captureSet = */ true)),
  delete: vi.fn(() => makeChain()),
};

vi.mock("@workspace/db", () => ({
  db: mockDb,
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

// ── Minimal Express apps ──────────────────────────────────────────────────────

async function buildActivitiesApp() {
  const { default: activitiesRouter } = await import("./activities.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // super_admin role so requireTripParticipant short-circuits without a DB hit
    req.session = { userId: 1, role: "super_admin" };
    next();
  });
  app.use("/api", activitiesRouter);
  return app;
}

async function buildTripsApp() {
  const { default: tripsRouter } = await import("./trips.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = { userId: 1, role: "super_admin" };
    next();
  });
  app.use("/api", tripsRouter);
  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let activitiesServer: http.Server;
let activitiesBase: string;

let tripsServer: http.Server;
let tripsBase: string;

beforeAll(async () => {
  const [actApp, trpApp] = await Promise.all([
    buildActivitiesApp(),
    buildTripsApp(),
  ]);

  await Promise.all([
    new Promise<void>(resolve => {
      activitiesServer = http.createServer(actApp).listen(0, resolve);
    }),
    new Promise<void>(resolve => {
      tripsServer = http.createServer(trpApp).listen(0, resolve);
    }),
  ]);

  activitiesBase = `http://localhost:${(activitiesServer.address() as { port: number }).port}/api`;
  tripsBase      = `http://localhost:${(tripsServer.address()      as { port: number }).port}/api`;
});

afterAll(() => {
  activitiesServer.close();
  tripsServer.close();
});

beforeEach(() => {
  resultQueue.length = 0;
  updateCalls.length = 0;
  selectWhereCalls.length = 0;
  mockDb.update.mockClear();
  mockDb.select.mockClear();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postReorder(tripId: number, ids: number[]) {
  const res = await fetch(`${activitiesBase}/trips/${tripId}/activities/reorder`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ ids }),
  });
  return { status: res.status, body: await res.json() as any };
}

async function getTimeline(tripId = 1) {
  const res = await fetch(`${tripsBase}/trips/${tripId}/timeline`);
  return { status: res.status, body: await res.json() as any[] };
}

/**
 * Enqueue the six results that GET /trips/:tripId/timeline fetches via Promise.all:
 *   1. flights  2. accommodations  3. activities  4. itinerary days
 *   5. car rentals  6. reservations
 */
function enqueueTimeline({
  flights        = [] as any[],
  accommodations = [] as any[],
  activities     = [] as any[],
  itinerary      = [] as any[],
  carRentals     = [] as any[],
  reservations   = [] as any[],
} = {}) {
  enqueue(flights, accommodations, activities, itinerary, carRentals, reservations);
}

// ── 1. Reorder endpoint ───────────────────────────────────────────────────────

describe("POST /trips/:tripId/activities/reorder — persists sort_order", () => {
  it("returns 200 { success: true } for a valid reorder request", async () => {
    // Each db.update() in the Promise.all resolves to [] (default from resultQueue)
    const { status, body } = await postReorder(1, [3, 1, 2]);

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });

  it("calls db.update once per id in the supplied list", async () => {
    await postReorder(1, [10, 20, 30]);

    // One update() per activity id
    expect(mockDb.update).toHaveBeenCalledTimes(3);
  });

  it("sets sort_order to the positional index of each id (0-based)", async () => {
    await postReorder(1, [7, 3, 5]);

    // updateCalls are captured in chain.where(), which fires after .set()
    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1, 2]);
  });

  it("assigns sort_order 0 to the first id regardless of its numeric value", async () => {
    // The new first position is id=99 (was last); its sort_order must be 0
    await postReorder(1, [99, 1, 2, 3]);

    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders[0]).toBe(0);
    expect(sortOrders[3]).toBe(3);
  });

  it("returns 400 when ids is missing from the body", async () => {
    const res = await fetch(`${activitiesBase}/trips/1/activities/reorder`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when ids contains a non-numeric value", async () => {
    const res = await fetch(`${activitiesBase}/trips/1/activities/reorder`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ ids: [1, "two", 3] }),
    });
    expect(res.status).toBe(400);
  });
});

// ── 2. Timeline sort — activities respect sort_order after reorder ────────────

describe("GET /trips/:tripId/timeline — sort_order tiebreaker for activities", () => {
  /**
   * Three null-time activities on the same date.  They carry explicit
   * sort_order values that are intentionally out of id order (lower id has a
   * higher sort_order).  The timeline must return them in sort_order sequence,
   * not id sequence — confirming that a drag-and-drop reorder is honoured on
   * the next fetch.
   */
  it("returns activities in sort_order sequence when sort_order differs from id order", async () => {
    enqueueTimeline({
      activities: [
        // DB rows in id order — sort_order is deliberately inverted
        { id: 1, tripId: 1, title: "Activity A", date: "2025-08-10", time: null, sortOrder: 2, description: null, location: null, imageUrl: null },
        { id: 2, tripId: 1, title: "Activity B", date: "2025-08-10", time: null, sortOrder: 0, description: null, location: null, imageUrl: null },
        { id: 3, tripId: 1, title: "Activity C", date: "2025-08-10", time: null, sortOrder: 1, description: null, location: null, imageUrl: null },
      ],
    });

    const { status, body } = await getTimeline();

    expect(status).toBe(200);
    const aug10 = body.filter((e: any) => e.date === "2025-08-10");
    expect(aug10).toHaveLength(3);

    // Must be B (0) → C (1) → A (2), not id order A → B → C
    expect(aug10[0].title).toBe("Activity B");
    expect(aug10[1].title).toBe("Activity C");
    expect(aug10[2].title).toBe("Activity A");
  });

  /**
   * Simulates a page-reload check after a reorder:
   *
   * Before drag: order was A, B, C (sort_order 0, 1, 2)
   * After drag:  user moves A to last position  → sort_order 2, 0, 1 for A, B, C
   *
   * The fresh fetch must reflect the new order: B → C → A.
   */
  it("reflects the post-drag order on a fresh fetch (simulated page reload)", async () => {
    enqueueTimeline({
      activities: [
        // sort_order reflects what the reorder endpoint would have written
        { id: 10, tripId: 1, title: "Museum visit",   date: "2025-09-05", time: null, sortOrder: 2, description: null, location: null, imageUrl: null },
        { id: 11, tripId: 1, title: "Lunch break",    date: "2025-09-05", time: null, sortOrder: 0, description: null, location: null, imageUrl: null },
        { id: 12, tripId: 1, title: "City walk",      date: "2025-09-05", time: null, sortOrder: 1, description: null, location: null, imageUrl: null },
      ],
    });

    const { status, body } = await getTimeline();

    expect(status).toBe(200);
    const sep5 = body.filter((e: any) => e.date === "2025-09-05");
    expect(sep5).toHaveLength(3);

    expect(sep5[0].title).toBe("Lunch break");   // sortOrder 0
    expect(sep5[1].title).toBe("City walk");      // sortOrder 1
    expect(sep5[2].title).toBe("Museum visit");   // sortOrder 2
  });

  /**
   * Two activities share the same explicit time on the same date.  The
   * sort_order must break the tie within the same type bucket even when both
   * events carry a real time value.
   */
  it("uses sort_order to break ties between two timed activities that share date and time", async () => {
    enqueueTimeline({
      activities: [
        { id: 20, tripId: 1, title: "Tour A", date: "2025-07-20", time: "10:00", sortOrder: 1, description: null, location: null, imageUrl: null },
        { id: 21, tripId: 1, title: "Tour B", date: "2025-07-20", time: "10:00", sortOrder: 0, description: null, location: null, imageUrl: null },
      ],
    });

    const { body } = await getTimeline();
    const jul20 = body.filter((e: any) => e.date === "2025-07-20" && e.type === "activity");
    expect(jul20).toHaveLength(2);

    expect(jul20[0].title).toBe("Tour B");  // sortOrder 0
    expect(jul20[1].title).toBe("Tour A");  // sortOrder 1
  });

  /**
   * An activity with an explicit sort_order must sort before one without
   * (null sort_order), regardless of id.
   */
  it("places an activity with an explicit sort_order before one with null sort_order", async () => {
    enqueueTimeline({
      activities: [
        // Higher id but explicit sort_order 0 — must come first
        { id: 30, tripId: 1, title: "Explicit order", date: "2025-07-25", time: null, sortOrder: 0, description: null, location: null, imageUrl: null },
        // Lower id but null sort_order — must come last
        { id: 29, tripId: 1, title: "No order set",   date: "2025-07-25", time: null, sortOrder: null, description: null, location: null, imageUrl: null },
      ],
    });

    const { body } = await getTimeline();
    const jul25 = body.filter((e: any) => e.date === "2025-07-25" && e.type === "activity");
    expect(jul25).toHaveLength(2);

    expect(jul25[0].title).toBe("Explicit order");
    expect(jul25[1].title).toBe("No order set");
  });

  /**
   * Fallback: when every activity has a null sort_order the final tiebreaker
   * is id (as a string comparison via String(a.id).localeCompare(String(b.id))).
   * Lower ids must appear first.
   */
  it("falls back to id order when all activities have null sort_order", async () => {
    enqueueTimeline({
      activities: [
        // Enqueued in reverse id order to prove DB row order is irrelevant
        { id: 5, tripId: 1, title: "C activity", date: "2025-06-15", time: null, sortOrder: null, description: null, location: null, imageUrl: null },
        { id: 3, tripId: 1, title: "A activity", date: "2025-06-15", time: null, sortOrder: null, description: null, location: null, imageUrl: null },
        { id: 4, tripId: 1, title: "B activity", date: "2025-06-15", time: null, sortOrder: null, description: null, location: null, imageUrl: null },
      ],
    });

    const { body } = await getTimeline();
    const jun15 = body.filter((e: any) => e.date === "2025-06-15" && e.type === "activity");
    expect(jun15).toHaveLength(3);

    // id 3 < 4 < 5 as strings
    expect(jun15[0].title).toBe("A activity");  // id 3
    expect(jun15[1].title).toBe("B activity");  // id 4
    expect(jun15[2].title).toBe("C activity");  // id 5
  });

  /**
   * The internal _sortOrder helper must not appear in the API response.
   */
  it("does not expose _sortOrder in the timeline response", async () => {
    enqueueTimeline({
      activities: [
        { id: 40, tripId: 1, title: "Hidden field check", date: "2025-05-01", time: null, sortOrder: 0, description: null, location: null, imageUrl: null },
      ],
    });

    const { body } = await getTimeline();
    const event = body.find((e: any) => e.type === "activity");
    expect(event).toBeDefined();
    expect(event).not.toHaveProperty("_sortOrder");
  });
});

// ── 3. Cross-trip isolation — reorder cannot corrupt another trip ─────────────

describe("POST /trips/:tripId/activities/reorder — cross-trip isolation", () => {
  /**
   * Every db.update() WHERE clause must include both:
   *   eq(activitiesTable.id,     <activity id>)
   *   eq(activitiesTable.tripId, <tripId from the URL>)
   *
   * With the mock, eq(table.col, val) => [col, val] and
   * and(a, b) => [a, b], so whereArgs for tripId=1, activityId=7 becomes:
   *   [["id", 7], ["tripId", 1]]
   *
   * This test confirms that when a caller sends activity IDs that belong to
   * trip B (tripId=2) inside a request for trip A (tripId=1), every WHERE
   * clause binds to tripId=1 — ensuring the DB would match zero rows in
   * trip B.
   */
  it("binds every UPDATE WHERE clause to the tripId from the URL, not the activity's owning trip", async () => {
    // Activity IDs 100 and 200 conceptually belong to trip B (tripId=2),
    // but the request is for trip A (tripId=1).
    await postReorder(1, [100, 200]);

    expect(mockDb.update).toHaveBeenCalledTimes(2);

    for (const call of updateCalls) {
      // whereArgs = [["id", <activityId>], ["tripId", <urlTripId>]]
      const whereArr = call.whereArgs as [unknown, unknown][];
      const tripIdClause = whereArr[1] as [string, number];

      expect(tripIdClause[0]).toBe("tripId");
      expect(tripIdClause[1]).toBe(1); // URL tripId, NOT 2
    }
  });

  it("includes the activity's own id alongside the tripId in each WHERE clause", async () => {
    await postReorder(5, [10, 20, 30]);

    expect(updateCalls).toHaveLength(3);

    const activityIds = updateCalls.map(c => {
      const whereArr = c.whereArgs as [unknown, unknown][];
      const idClause = whereArr[0] as [string, number];
      return idClause[1];
    });

    expect(activityIds).toEqual([10, 20, 30]);
  });

  it("does not touch any activity when the supplied IDs are from a different trip", async () => {
    // Trip B has activities 50, 60, 70; request goes to trip A (tripId=1).
    // Because each WHERE includes tripId=1, the real DB would match nothing
    // in trip B. Confirm the WHERE clauses all reference tripId=1.
    await postReorder(1, [50, 60, 70]);

    expect(mockDb.update).toHaveBeenCalledTimes(3);

    for (const call of updateCalls) {
      const whereArr  = call.whereArgs as [unknown, unknown][];
      const tripIdClause = whereArr[1] as [string, number];

      expect(tripIdClause[0]).toBe("tripId");
      expect(tripIdClause[1]).toBe(1);

      // Confirm the set payload only carries sortOrder (no tripId override)
      expect(Object.keys(call.setArgs as object)).toEqual(["sortOrder"]);
    }
  });

  it("still returns 200 and does not leak trip B data when IDs don't belong to the request's trip", async () => {
    // DB returns empty arrays (default) → no rows updated for foreign IDs.
    // The endpoint must still respond cleanly.
    const { status, body } = await postReorder(1, [500, 600]);

    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });
});

// ── 4. DELETE gap-closing re-index ───────────────────────────────────────────

/**
 * The DELETE handler:
 *   1. Deletes the activity (db.delete → dequeues first result)
 *   2. Fetches remaining activities on the same (trip, date) ordered by
 *      sortOrder ASC, id ASC (db.select → dequeues second result)
 *   3. Writes contiguous 0-based sort_order back to each remaining row
 *      (one db.update per row → captured in updateCalls)
 */

describe("DELETE /trips/:tripId/activities/:activityId — gap-closing re-index", () => {
  async function deleteActivity(tripId: number, activityId: number) {
    const res = await fetch(
      `${activitiesBase}/trips/${tripId}/activities/${activityId}`,
      { method: "DELETE" },
    );
    return { status: res.status, body: await res.json() as any };
  }

  it("returns 200 { success: true } when the activity exists", async () => {
    enqueue(
      [{ id: 5, tripId: 1, date: "2025-08-10", sortOrder: 1 }], // deleted row
      [],                                                          // no remaining
    );
    const { status, body } = await deleteActivity(1, 5);
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });

  it("returns 404 when the activity does not belong to the trip", async () => {
    enqueue([]); // db.delete returns no rows → not found
    const { status } = await deleteActivity(1, 9999);
    expect(status).toBe(404);
  });

  it("re-indexes three remaining activities to 0, 1, 2 after a middle activity is deleted", async () => {
    // Original order: ids 1,2,3,4 with sort_orders 0,1,2,3.
    // Deleting id=2 (sortOrder=1) leaves a gap: sort_orders 0,2,3.
    // After re-index the remaining ids 1,3,4 must receive sort_orders 0,1,2.
    enqueue(
      [{ id: 2, tripId: 1, date: "2025-08-10", sortOrder: 1 }], // deleted row
      [{ id: 1 }, { id: 3 }, { id: 4 }],                        // remaining (DB returns in sortOrder asc)
    );

    await deleteActivity(1, 2);

    // One db.update() per remaining activity
    expect(mockDb.update).toHaveBeenCalledTimes(3);

    // sort_orders must be contiguous 0-based with no gaps
    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1, 2]);
  });

  it("closes gaps even when multiple gaps pre-existed before the delete", async () => {
    // sort_orders were already non-contiguous: 0, 2, 5, 9
    // Delete the first (sortOrder=0); remaining: 2, 5, 9 — two-gap sequence
    // After re-index: 0, 1, 2
    enqueue(
      [{ id: 10, tripId: 1, date: "2025-09-01", sortOrder: 0 }],
      [{ id: 11 }, { id: 12 }, { id: 13 }],
    );

    await deleteActivity(1, 10);

    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1, 2]);
  });

  it("assigns sort_order 0 to the single remaining activity", async () => {
    // Two activities; after deleting one only the other remains.
    enqueue(
      [{ id: 20, tripId: 1, date: "2025-10-05", sortOrder: 0 }],
      [{ id: 21 }],
    );

    await deleteActivity(1, 20);

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0]);
  });

  it("does not call db.update when the deleted activity was the only one on that date", async () => {
    enqueue(
      [{ id: 99, tripId: 1, date: "2025-12-31", sortOrder: 0 }],
      [], // no remaining activities on this date
    );

    await deleteActivity(1, 99);

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  /**
   * Cross-date isolation: deleting an activity from date A must not touch
   * activities on date B within the same trip.
   *
   * The re-index SELECT filters by both tripId AND date, so the DB only
   * returns date-A rows.  This test confirms:
   *   1. The WHERE clause passed to db.select contains the deleted activity's
   *      date (date A), not date B.
   *   2. db.update is called only for the activities that the select returned
   *      (date A survivors), never for date B.
   *   3. The sort_orders written match only the date-A survivors in sequence.
   *
   * With the drizzle-orm mock:
   *   eq(col, val)   → [col, val]
   *   and(a, b, ...) → [a, b, ...]
   *
   * So the WHERE arg for tripId=1, date="2025-08-10" becomes:
   *   [["tripId", 1], ["date", "2025-08-10"]]
   */
  it("re-index SELECT is scoped to the deleted activity's date, leaving date-B activities untouched", async () => {
    const DATE_A = "2025-08-10";
    const DATE_B = "2025-08-11";

    // db.delete returns the activity being deleted (on date A)
    // db.select returns only the two survivors on date A (the route filters by date)
    // date-B activities (ids 4, 5) are never returned by the select because the
    // real DB WHERE clause includes eq(activitiesTable.date, item.date)
    enqueue(
      [{ id: 2, tripId: 1, date: DATE_A, sortOrder: 1 }], // deleted row
      [{ id: 1 }, { id: 3 }],                              // remaining on date A only
    );

    await deleteActivity(1, 2);

    // ── Assert 1: the SELECT WHERE clause names date A, not date B ────────────
    // The route issues exactly one db.select for the re-index query.
    // selectWhereCalls[0] = and(eq(tripId,1), eq(date, DATE_A))
    //                     = [["tripId", 1], ["date", DATE_A]]
    expect(selectWhereCalls).toHaveLength(1);
    const whereArr = selectWhereCalls[0] as [unknown, unknown][];
    const tripIdClause = whereArr[0] as [string, number];
    const dateClause   = whereArr[1] as [string, string];

    expect(tripIdClause[0]).toBe("tripId");
    expect(tripIdClause[1]).toBe(1);

    expect(dateClause[0]).toBe("date");
    expect(dateClause[1]).toBe(DATE_A);   // must be date A
    expect(dateClause[1]).not.toBe(DATE_B); // must NOT be date B

    // ── Assert 2: db.update called only for the two date-A survivors ──────────
    // The re-index UPDATE uses eq(activitiesTable.id, r.id) without and(),
    // so whereArgs is ["id", <value>] directly (not a nested array).
    // date-B activities (ids 4, 5) are never in the update list.
    expect(mockDb.update).toHaveBeenCalledTimes(2);
    const updatedIds = updateCalls.map(c => {
      const w = c.whereArgs as [string, number];
      return w[1]; // second element is the activity id value
    });
    expect(updatedIds).toEqual([1, 3]);    // only date-A survivors
    expect(updatedIds).not.toContain(4);   // date-B activity never touched
    expect(updatedIds).not.toContain(5);   // date-B activity never touched

    // ── Assert 3: sort_orders are compacted for date A only ───────────────────
    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1]);
  });

  /**
   * Insert-after-delete ordering: a new activity added after a delete must
   * receive a sort_order that places it after the existing activities.
   *
   * This test simulates the combined effect on the timeline:
   *   - Three activities remain with re-indexed sort_orders 0, 1, 2.
   *   - A fourth activity is added with sort_order null.
   *   - The timeline must place the null-order activity last (after 0, 1, 2),
   *     relying on the id fallback rather than firing unexpectedly before any
   *     activity with an explicit sort_order.
   */
  it("new null-sort-order activity sorts after re-indexed activities on the timeline", async () => {
    enqueueTimeline({
      activities: [
        // Three re-indexed activities (contiguous after a delete)
        { id: 1, tripId: 1, title: "First",  date: "2025-07-01", time: null, sortOrder: 0, description: null, location: null, imageUrl: null },
        { id: 2, tripId: 1, title: "Second", date: "2025-07-01", time: null, sortOrder: 1, description: null, location: null, imageUrl: null },
        { id: 3, tripId: 1, title: "Third",  date: "2025-07-01", time: null, sortOrder: 2, description: null, location: null, imageUrl: null },
        // Newly inserted activity with no sort_order assigned yet
        { id: 4, tripId: 1, title: "New",    date: "2025-07-01", time: null, sortOrder: null, description: null, location: null, imageUrl: null },
      ],
    });

    const { status, body } = await getTimeline();

    expect(status).toBe(200);
    const jul1 = body.filter((e: any) => e.date === "2025-07-01" && e.type === "activity");
    expect(jul1).toHaveLength(4);

    // Explicitly-ordered activities come first in sort_order sequence
    expect(jul1[0].title).toBe("First");   // sortOrder 0
    expect(jul1[1].title).toBe("Second");  // sortOrder 1
    expect(jul1[2].title).toBe("Third");   // sortOrder 2
    // null-sort-order activity is placed last, not injected between the ordered ones
    expect(jul1[3].title).toBe("New");
  });
});

// ── 6. Delete → reorder chain ─────────────────────────────────────────────────

/**
 * Simulates the full lifecycle: three activities → delete one → reorder survivors.
 *
 * After a deletion the DELETE handler re-indexes the remaining activities to
 * contiguous 0-based sort_orders.  A subsequent reorder request must treat
 * those re-indexed values as the authoritative current state and assign new
 * positional sort_orders correctly, with no interference from the stale
 * sort_order values that existed before the delete.
 *
 * Each HTTP request is independent (separate fetch calls), so the mock queue
 * must be loaded for each operation separately.  The test clears updateCalls
 * between operations so assertions are unambiguous.
 */

describe("delete → reorder chain — stale sort_orders do not interfere", () => {
  async function deleteActivity(tripId: number, activityId: number) {
    const res = await fetch(
      `${activitiesBase}/trips/${tripId}/activities/${activityId}`,
      { method: "DELETE" },
    );
    return { status: res.status, body: await res.json() as any };
  }

  /**
   * Full chain: three activities (sort_orders 0, 1, 2) → delete the middle
   * one (id=2) → reorder the two survivors in reversed order ([3, 1]).
   *
   * After the delete, the DELETE handler re-indexes the survivors to 0, 1
   * (ids 1 and 3 in that order).  The subsequent reorder with [3, 1] must
   * assign sort_order 0 to id=3 and sort_order 1 to id=1 — reflecting the
   * user's new preferred order, not the stale pre-delete sort_orders.
   */
  it("reorder after delete assigns correct 0-based sort_orders to both survivors", async () => {
    // ── Phase 1: DELETE id=2 (the middle activity) ───────────────────────────
    enqueue(
      [{ id: 2, tripId: 1, date: "2025-08-10", sortOrder: 1 }], // deleted row
      [{ id: 1 }, { id: 3 }],                                    // remaining (re-index query)
    );

    const { status: deleteStatus, body: deleteBody } = await deleteActivity(1, 2);
    expect(deleteStatus).toBe(200);
    expect(deleteBody).toEqual({ success: true });

    // The DELETE handler must re-index the two survivors to [0, 1]
    expect(updateCalls.map(c => (c.setArgs as any).sortOrder)).toEqual([0, 1]);

    // Clear state between phases so reorder assertions are unambiguous
    updateCalls.length = 0;
    mockDb.update.mockClear();

    // ── Phase 2: REORDER survivors in reversed order [3, 1] ─────────────────
    // No extra DB rows need to be enqueued; the reorder Promise.all resolves
    // to the default [] for each update (already the queue default).
    const { status: reorderStatus, body: reorderBody } = await postReorder(1, [3, 1]);
    expect(reorderStatus).toBe(200);
    expect(reorderBody).toEqual({ success: true });

    // Two updates — one per surviving activity
    expect(mockDb.update).toHaveBeenCalledTimes(2);

    // sort_order must be positional (0-based) for the new order [3, 1]
    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1]);

    // id=3 is first in the reorder list → must receive sort_order 0
    // id=1 is second in the reorder list → must receive sort_order 1
    const activityIds = updateCalls.map(c => {
      const whereArr = c.whereArgs as [unknown, unknown][];
      return (whereArr[0] as [string, number])[1];
    });
    expect(activityIds).toEqual([3, 1]);
  });

  /**
   * Confirms that stale sort_order values from before the delete (which could
   * be non-contiguous if the original set had gaps) do not contaminate the
   * reorder assignment.
   *
   * Original state: ids 10, 11, 12 with sort_orders 0, 5, 9 (already gapped).
   * Delete id=11 (sort_order 5) → re-index survivors: id=10 → 0, id=12 → 1.
   * Reorder survivors as [12, 10] → id=12 gets sort_order 0, id=10 gets 1.
   * The stale sort_order 9 for id=12 must play no role in this final assignment.
   */
  it("stale non-contiguous sort_orders from before the delete do not affect the reorder result", async () => {
    // ── Phase 1: DELETE id=11 ────────────────────────────────────────────────
    enqueue(
      [{ id: 11, tripId: 1, date: "2025-09-15", sortOrder: 5 }], // deleted row
      [{ id: 10 }, { id: 12 }],                                   // survivors returned by re-index query
    );

    const { status: ds } = await deleteActivity(1, 11);
    expect(ds).toBe(200);
    // Re-index gives survivors contiguous sort_orders [0, 1]
    expect(updateCalls.map(c => (c.setArgs as any).sortOrder)).toEqual([0, 1]);

    updateCalls.length = 0;
    mockDb.update.mockClear();

    // ── Phase 2: REORDER [12, 10] ────────────────────────────────────────────
    const { status: rs } = await postReorder(1, [12, 10]);
    expect(rs).toBe(200);

    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1]); // id=12 → 0, id=10 → 1

    const activityIds = updateCalls.map(c => {
      const whereArr = c.whereArgs as [unknown, unknown][];
      return (whereArr[0] as [string, number])[1];
    });
    expect(activityIds).toEqual([12, 10]);
  });

  /**
   * Confirms that after deleting the first activity in a sequence the
   * reorder still produces a correct 0-based sequence for the survivors,
   * even though the original first activity's id no longer exists.
   */
  it("reorder after deleting the first activity produces correct sort_orders for remaining items", async () => {
    // Original: ids 20, 21, 22, sort_orders 0, 1, 2
    // Delete id=20 (the first) → survivors 21, 22 re-indexed to 0, 1
    enqueue(
      [{ id: 20, tripId: 1, date: "2025-10-20", sortOrder: 0 }],
      [{ id: 21 }, { id: 22 }],
    );

    const { status: ds } = await deleteActivity(1, 20);
    expect(ds).toBe(200);
    expect(updateCalls.map(c => (c.setArgs as any).sortOrder)).toEqual([0, 1]);

    updateCalls.length = 0;
    mockDb.update.mockClear();

    // Reorder survivors; keep the same order [21, 22] — sort_orders should still be 0, 1
    const { status: rs } = await postReorder(1, [21, 22]);
    expect(rs).toBe(200);

    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1]);

    const activityIds = updateCalls.map(c => {
      const whereArr = c.whereArgs as [unknown, unknown][];
      return (whereArr[0] as [string, number])[1];
    });
    expect(activityIds).toEqual([21, 22]);
  });

  /**
   * Timeline read after the full chain: once delete + reorder have run, the
   * timeline must return activities in the final sort_order sequence (as it
   * would after a page reload), with no trace of the deleted activity.
   */
  it("timeline reflects the final sort_order after a delete-then-reorder chain", async () => {
    // Simulate the DB state after: delete id=2, then reorder [3, 1]
    // id=3 now has sort_order 0, id=1 has sort_order 1, id=2 is gone.
    enqueueTimeline({
      activities: [
        { id: 1, tripId: 1, title: "Alpha", date: "2025-08-10", time: null, sortOrder: 1, description: null, location: null, imageUrl: null },
        { id: 3, tripId: 1, title: "Gamma", date: "2025-08-10", time: null, sortOrder: 0, description: null, location: null, imageUrl: null },
        // id=2 ("Beta") is gone — must not appear
      ],
    });

    const { status, body } = await getTimeline();
    expect(status).toBe(200);

    const aug10 = body.filter((e: any) => e.date === "2025-08-10" && e.type === "activity");
    expect(aug10).toHaveLength(2); // only 2 survivors

    // Gamma (sortOrder 0) must come before Alpha (sortOrder 1)
    expect(aug10[0].title).toBe("Gamma");
    expect(aug10[1].title).toBe("Alpha");

    // Deleted activity must not appear anywhere
    expect(body.some((e: any) => e.title === "Beta")).toBe(false);
  });
});

// ── 5. Timeline sort — reservations also respect sort_order ──────────────────

describe("GET /trips/:tripId/timeline — sort_order tiebreaker for reservations", () => {
  /**
   * Three null-time reservations on the same date with sort_order values that
   * are out of id order.  The timeline must return them in sort_order sequence.
   */
  it("returns reservations in sort_order sequence when sort_order differs from id order", async () => {
    enqueueTimeline({
      reservations: [
        { id: 100, tripId: 1, title: "Dinner", date: "2025-10-01", time: null, sortOrder: 1, notes: null, address: null, venue: null, imageUrl: null, confirmationCode: null },
        { id: 101, tripId: 1, title: "Lunch",  date: "2025-10-01", time: null, sortOrder: 0, notes: null, address: null, venue: null, imageUrl: null, confirmationCode: null },
        { id: 102, tripId: 1, title: "Brunch", date: "2025-10-01", time: null, sortOrder: 2, notes: null, address: null, venue: null, imageUrl: null, confirmationCode: null },
      ],
    });

    const { status, body } = await getTimeline();

    expect(status).toBe(200);
    const oct1 = body.filter((e: any) => e.date === "2025-10-01" && e.type === "reservation");
    expect(oct1).toHaveLength(3);

    expect(oct1[0].title).toBe("Lunch");   // sortOrder 0
    expect(oct1[1].title).toBe("Dinner");  // sortOrder 1
    expect(oct1[2].title).toBe("Brunch");  // sortOrder 2
  });

  /**
   * Cross-type priority is respected even when both an activity and a
   * reservation are on the same date with the same time and sort_order.
   * Activity (priority 3) must sort before reservation (priority 4).
   */
  it("preserves cross-type priority (activity before reservation) while respecting sort_order within each type", async () => {
    enqueueTimeline({
      activities: [
        { id: 200, tripId: 1, title: "Walk", date: "2025-11-11", time: null, sortOrder: 1, description: null, location: null, imageUrl: null },
        { id: 201, tripId: 1, title: "Run",  date: "2025-11-11", time: null, sortOrder: 0, description: null, location: null, imageUrl: null },
      ],
      reservations: [
        { id: 202, tripId: 1, title: "Tea",    date: "2025-11-11", time: null, sortOrder: 1, notes: null, address: null, venue: null, imageUrl: null, confirmationCode: null },
        { id: 203, tripId: 1, title: "Coffee", date: "2025-11-11", time: null, sortOrder: 0, notes: null, address: null, venue: null, imageUrl: null, confirmationCode: null },
      ],
    });

    const { status, body } = await getTimeline();

    expect(status).toBe(200);
    const nov11 = body.filter((e: any) => e.date === "2025-11-11");
    expect(nov11).toHaveLength(4);

    // All activities must come before any reservation
    expect(nov11[0].type).toBe("activity");
    expect(nov11[1].type).toBe("activity");
    expect(nov11[2].type).toBe("reservation");
    expect(nov11[3].type).toBe("reservation");

    // Within each type, sort_order determines order
    expect(nov11[0].title).toBe("Run");     // activity sortOrder 0
    expect(nov11[1].title).toBe("Walk");    // activity sortOrder 1
    expect(nov11[2].title).toBe("Coffee");  // reservation sortOrder 0
    expect(nov11[3].title).toBe("Tea");     // reservation sortOrder 1
  });
});
