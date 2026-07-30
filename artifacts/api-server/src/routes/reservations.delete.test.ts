/**
 * Integration tests: DELETE reservation gap-closing re-index
 *
 * Covers:
 *   1. DELETE /trips/:tripId/reservations/:reservationId — happy path and 404.
 *   2. Re-index logic: remaining reservations on the same (trip, date) receive
 *      contiguous 0-based sort_orders after a deletion.
 *   3. Cross-date isolation: the re-index SELECT is scoped to the deleted
 *      reservation's date; reservations on other dates are never updated.
 *
 * Strategy: mock @workspace/db with the same lazy-dequeue chainable fake used
 * in activities.reorder.test.ts. Mount the reservations router on a minimal
 * Express app with a fake session, then drive requests with Node's built-in
 * fetch.
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Mock drizzle-orm operators ────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq:  (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
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

// Track every db.update() call so tests can inspect set/where arguments.
const updateCalls: { setArgs: unknown; whereArgs: unknown }[] = [];

// Track WHERE args passed to db.select() so cross-date isolation tests can
// assert the date filter is scoped to the correct date.
const selectWhereCalls: unknown[] = [];

function makeChain(captureSet = false, captureWhere = false): any {
  let p: Promise<unknown> | null = null;
  let capturedSet: unknown;

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
    if (captureSet) {
      updateCalls.push({ setArgs: capturedSet, whereArgs: args });
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

// ── Minimal Express app ───────────────────────────────────────────────────────

async function buildReservationsApp() {
  const { default: reservationsRouter } = await import("./reservations.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    // super_admin role so requireTripParticipant short-circuits without a DB hit
    req.session = { userId: 1, role: "super_admin" };
    next();
  });
  app.use("/api", reservationsRouter);
  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = await buildReservationsApp();
  await new Promise<void>(resolve => {
    server = http.createServer(app).listen(0, resolve);
  });
  base = `http://localhost:${(server.address() as { port: number }).port}/api`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  resultQueue.length = 0;
  updateCalls.length = 0;
  selectWhereCalls.length = 0;
  mockDb.update.mockClear();
  mockDb.select.mockClear();
  mockDb.delete.mockClear();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function deleteReservation(tripId: number, reservationId: number) {
  const res = await fetch(
    `${base}/trips/${tripId}/reservations/${reservationId}`,
    { method: "DELETE" },
  );
  return { status: res.status, body: await res.json() as any };
}

async function reorderReservations(tripId: number, ids: number[]) {
  const res = await fetch(
    `${base}/trips/${tripId}/reservations/reorder`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
    },
  );
  return { status: res.status, body: await res.json() as any };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

/**
 * The DELETE handler:
 *   1. Deletes the reservation (db.delete → dequeues first result)
 *   2. Fetches remaining reservations on the same (trip, date) ordered by
 *      sortOrder ASC, id ASC (db.select → dequeues second result)
 *   3. Writes contiguous 0-based sort_order back to each remaining row
 *      (one db.update per row → captured in updateCalls)
 */

describe("DELETE /trips/:tripId/reservations/:reservationId — gap-closing re-index", () => {
  it("returns 200 { success: true } when the reservation exists", async () => {
    enqueue(
      [{ id: 5, tripId: 1, date: "2025-08-10", sortOrder: 1 }], // deleted row
      [],                                                          // no remaining
    );
    const { status, body } = await deleteReservation(1, 5);
    expect(status).toBe(200);
    expect(body).toEqual({ success: true });
  });

  it("returns 404 when the reservation does not belong to the trip", async () => {
    enqueue([]); // db.delete returns no rows → not found
    const { status } = await deleteReservation(1, 9999);
    expect(status).toBe(404);
  });

  it("re-indexes three remaining reservations to 0, 1, 2 after a middle one is deleted", async () => {
    // Original order: ids 1,2,3,4 with sort_orders 0,1,2,3.
    // Deleting id=2 (sortOrder=1) leaves a gap: sort_orders 0,2,3.
    // After re-index the remaining ids 1,3,4 must receive sort_orders 0,1,2.
    enqueue(
      [{ id: 2, tripId: 1, date: "2025-08-10", sortOrder: 1 }], // deleted row
      [{ id: 1 }, { id: 3 }, { id: 4 }],                        // remaining (DB returns in sortOrder asc)
    );

    await deleteReservation(1, 2);

    // One db.update() per remaining reservation
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

    await deleteReservation(1, 10);

    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1, 2]);
  });

  it("assigns sort_order 0 to the single remaining reservation", async () => {
    // Two reservations; after deleting one only the other remains.
    enqueue(
      [{ id: 20, tripId: 1, date: "2025-10-05", sortOrder: 0 }],
      [{ id: 21 }],
    );

    await deleteReservation(1, 20);

    expect(mockDb.update).toHaveBeenCalledTimes(1);
    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0]);
  });

  it("does not call db.update when the deleted reservation was the only one on that date", async () => {
    enqueue(
      [{ id: 99, tripId: 1, date: "2025-12-31", sortOrder: 0 }],
      [], // no remaining reservations on this date
    );

    await deleteReservation(1, 99);

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  /**
   * Cross-date isolation: deleting a reservation from date A must not touch
   * reservations on date B within the same trip.
   *
   * The re-index SELECT filters by both tripId AND date, so the DB only
   * returns date-A rows.  This test confirms:
   *   1. The WHERE clause passed to db.select contains the deleted reservation's
   *      date (date A), not date B.
   *   2. db.update is called only for the reservations that the select returned
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
  it("re-index SELECT is scoped to the deleted reservation's date, leaving date-B reservations untouched", async () => {
    const DATE_A = "2025-08-10";
    const DATE_B = "2025-08-11";

    // db.delete returns the reservation being deleted (on date A)
    // db.select returns only the two survivors on date A (the route filters by date)
    // date-B reservations (ids 4, 5) are never returned by the select because the
    // real DB WHERE clause includes eq(reservationsTable.date, item.date)
    enqueue(
      [{ id: 2, tripId: 1, date: DATE_A, sortOrder: 1 }], // deleted row
      [{ id: 1 }, { id: 3 }],                              // remaining on date A only
    );

    await deleteReservation(1, 2);

    // ── Assert 1: the SELECT WHERE clause names date A, not date B ────────────
    // The route issues exactly one db.select for the re-index query.
    // selectWhereCalls[0] = and(eq(tripId,1), eq(date, DATE_A))
    //                     = [["tripId", 1], ["date", DATE_A]]
    expect(selectWhereCalls).toHaveLength(1);
    const whereArr     = selectWhereCalls[0] as [unknown, unknown][];
    const tripIdClause = whereArr[0] as [string, number];
    const dateClause   = whereArr[1] as [string, string];

    expect(tripIdClause[0]).toBe("tripId");
    expect(tripIdClause[1]).toBe(1);

    expect(dateClause[0]).toBe("date");
    expect(dateClause[1]).toBe(DATE_A);    // must be date A
    expect(dateClause[1]).not.toBe(DATE_B); // must NOT be date B

    // ── Assert 2: db.update called only for the two date-A survivors ──────────
    // The re-index UPDATE uses eq(reservationsTable.id, r.id) without and(),
    // so whereArgs is ["id", <value>] directly (not a nested array).
    // date-B reservations (ids 4, 5) are never in the update list.
    expect(mockDb.update).toHaveBeenCalledTimes(2);
    const updatedIds = updateCalls.map(c => {
      const w = c.whereArgs as [string, number];
      return w[1]; // second element is the reservation id value
    });
    expect(updatedIds).toEqual([1, 3]);    // only date-A survivors
    expect(updatedIds).not.toContain(4);   // date-B reservation never touched
    expect(updatedIds).not.toContain(5);   // date-B reservation never touched

    // ── Assert 3: sort_orders are compacted for date A only ───────────────────
    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1]);
  });

  it("re-indexes correctly when deleting the last reservation in the list", async () => {
    // Original order: ids 1,2,3 with sort_orders 0,1,2.
    // Deleting id=3 (sortOrder=2, the last one); remaining: 0,1 — no gaps but
    // the re-index must still fire and assign clean 0,1 values.
    enqueue(
      [{ id: 3, tripId: 1, date: "2025-11-15", sortOrder: 2 }], // deleted row
      [{ id: 1 }, { id: 2 }],                                    // remaining
    );

    await deleteReservation(1, 3);

    expect(mockDb.update).toHaveBeenCalledTimes(2);
    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1]);
  });

  it("re-indexes correctly when deleting the first reservation in the list", async () => {
    // Original order: ids 1,2,3 with sort_orders 0,1,2.
    // Deleting id=1 (sortOrder=0, the first); remaining: 1,2 — gap at start.
    // After re-index: 0,1.
    enqueue(
      [{ id: 1, tripId: 1, date: "2025-06-20", sortOrder: 0 }], // deleted row
      [{ id: 2 }, { id: 3 }],                                    // remaining
    );

    await deleteReservation(1, 1);

    expect(mockDb.update).toHaveBeenCalledTimes(2);
    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1]);
  });
});

/**
 * Cross-trip isolation: deleting a reservation from trip A must never touch
 * reservations belonging to trip B, even when both trips share the same
 * calendar date.
 *
 * The re-index SELECT filters by the URL's tripId, so the real DB will only
 * return trip-A rows.  These tests confirm:
 *   1. The WHERE clause passed to db.select binds to the URL's tripId (trip A),
 *      not to any foreign tripId (trip B).
 *   2. db.update is called only for reservation IDs that the select returned
 *      (trip A survivors); trip B reservation IDs are never updated.
 *
 * With the drizzle-orm mock:
 *   eq(col, val)   → [col, val]
 *   and(a, b, ...) → [a, b, ...]
 *
 * So the WHERE arg for tripId=1, date="2025-08-10" becomes:
 *   [["tripId", 1], ["date", "2025-08-10"]]
 */
describe("DELETE /trips/:tripId/reservations/:reservationId — cross-trip isolation", () => {
  it("re-index SELECT WHERE clause binds to the URL tripId, not a foreign tripId", async () => {
    const SHARED_DATE = "2025-08-10";
    const TRIP_A_ID   = 1;
    const TRIP_B_ID   = 2;

    // Trip A has reservations 10, 11, 12 on SHARED_DATE (sort_orders 0,1,2).
    // Trip B has reservations 20, 21    on SHARED_DATE — different trip.
    // We delete reservation 11 from trip A (sort_order 1).
    // The re-index SELECT must be scoped to tripId=TRIP_A_ID; the mock returns
    // only trip-A survivors [10, 12] because the real DB would never return
    // trip-B rows when tripId is bound in the WHERE clause.
    enqueue(
      [{ id: 11, tripId: TRIP_A_ID, date: SHARED_DATE, sortOrder: 1 }], // deleted row
      [{ id: 10 }, { id: 12 }],                                          // trip-A survivors
    );

    await deleteReservation(TRIP_A_ID, 11);

    // ── Assert 1: SELECT WHERE names TRIP_A_ID, not TRIP_B_ID ────────────────
    expect(selectWhereCalls).toHaveLength(1);
    const whereArr     = selectWhereCalls[0] as [unknown, unknown][];
    const tripIdClause = whereArr[0] as [string, number];
    const dateClause   = whereArr[1] as [string, string];

    expect(tripIdClause[0]).toBe("tripId");
    expect(tripIdClause[1]).toBe(TRIP_A_ID);    // bound to trip A's id
    expect(tripIdClause[1]).not.toBe(TRIP_B_ID); // never trip B's id

    expect(dateClause[0]).toBe("date");
    expect(dateClause[1]).toBe(SHARED_DATE);

    // ── Assert 2: db.update called only for trip-A reservation IDs ───────────
    // The re-index UPDATE uses eq(reservationsTable.id, r.id) so whereArgs is
    // ["id", <value>] directly (not a nested array).
    expect(mockDb.update).toHaveBeenCalledTimes(2);
    const updatedIds = updateCalls.map(c => {
      const w = c.whereArgs as [string, number];
      return w[1];
    });

    expect(updatedIds).toEqual([10, 12]);         // only trip-A survivors
    expect(updatedIds).not.toContain(20);          // trip-B reservation never touched
    expect(updatedIds).not.toContain(21);          // trip-B reservation never touched

    // ── Assert 3: sort_orders are compacted for trip-A survivors only ─────────
    const sortOrders = updateCalls.map(c => (c.setArgs as any).sortOrder);
    expect(sortOrders).toEqual([0, 1]);
  });

  it("does not call db.update at all when the deleted reservation was the sole trip-A entry on the shared date", async () => {
    // Trip A has exactly one reservation on SHARED_DATE; trip B has two on the
    // same date.  After deleting trip A's reservation, no survivors exist for
    // trip A → db.update must not fire (trip B is never involved).
    const SHARED_DATE = "2025-09-15";
    const TRIP_A_ID   = 3;

    enqueue(
      [{ id: 30, tripId: TRIP_A_ID, date: SHARED_DATE, sortOrder: 0 }], // deleted row
      [],  // no remaining reservations for trip A on SHARED_DATE
    );

    await deleteReservation(TRIP_A_ID, 30);

    // SELECT was issued with the correct tripId
    expect(selectWhereCalls).toHaveLength(1);
    const tripIdClause = (selectWhereCalls[0] as [unknown, unknown][])[0] as [string, number];
    expect(tripIdClause[0]).toBe("tripId");
    expect(tripIdClause[1]).toBe(TRIP_A_ID);

    // No updates at all — trip-B reservations (ids 40, 41) are untouched
    expect(mockDb.update).not.toHaveBeenCalled();
  });
});

/**
 * Delete → Reorder chain: confirms that after a deletion re-indexes survivors,
 * a subsequent reorder request assigns fresh 0-based sort_orders without any
 * stale values from before the delete interfering.
 *
 * The reorder endpoint (POST /trips/:tripId/reservations/reorder):
 *   - Receives an ordered array of ids from the client.
 *   - Writes sortOrder = array-index for each id via db.update().
 *
 * The DELETE handler already re-indexes survivors to 0-based contiguous values.
 * After that re-index the client fetches the updated list and sends a reorder
 * request.  The reorder endpoint must assign positions based solely on the
 * supplied ids array — stale sort_order values that existed before the delete
 * must never leak through.
 *
 * Reorder endpoint WHERE clause shape (from mock):
 *   db.update().set({ sortOrder: index })
 *     .where(and(eq(reservationsTable.id, id), eq(reservationsTable.tripId, tripId)))
 *   → whereArgs = [["id", id_value], ["tripId", tripId_value]]
 *
 * Helper: extract { reservationId, sortOrder } from a captured update call
 * that originated from the reorder endpoint.
 */
function extractReorderUpdate(call: { setArgs: unknown; whereArgs: unknown }) {
  const whereArr      = call.whereArgs as [string, number][];
  const reservationId = whereArr[0][1]; // eq(reservationsTable.id, id) → ["id", id]
  const sortOrder     = (call.setArgs as { sortOrder: number }).sortOrder;
  return { reservationId, sortOrder };
}

describe("DELETE then reorder — combined chain", () => {
  it("reorder after deleting the middle reservation maps each id to its correct position", async () => {
    // Three reservations: ids 1, 2, 3 with sort_orders 0, 1, 2.
    // Step 1 — delete id=2 (middle).  DELETE re-indexes survivors: ids 1,3 → 0,1.
    // Step 2 — user drags id=3 to front; client sends reorder [3, 1].
    //           Reorder endpoint must assign: id=3 → sortOrder=0, id=1 → sortOrder=1.
    const TRIP_ID = 10;

    // ── Step 1: DELETE id=2 ───────────────────────────────────────────────────
    enqueue(
      [{ id: 2, tripId: TRIP_ID, date: "2025-08-10", sortOrder: 1 }], // deleted row
      [{ id: 1 }, { id: 3 }],                                          // survivors returned by re-index SELECT
    );

    const deleteResult = await deleteReservation(TRIP_ID, 2);
    expect(deleteResult.status).toBe(200);

    // Record how many update calls came from the DELETE re-index phase
    const reindexCallCount = updateCalls.length;
    expect(reindexCallCount).toBe(2); // one update per survivor

    // ── Step 2: POST reorder [3, 1] ───────────────────────────────────────────
    const reorderResult = await reorderReservations(TRIP_ID, [3, 1]);
    expect(reorderResult.status).toBe(200);
    expect(reorderResult.body).toEqual({ success: true });

    // Two more db.update() calls from the reorder endpoint
    const reorderCalls = updateCalls.slice(reindexCallCount);
    expect(reorderCalls).toHaveLength(2);

    // Verify each id is bound to its positional index in the supplied array
    const mapped = reorderCalls.map(extractReorderUpdate);
    expect(mapped[0]).toEqual({ reservationId: 3, sortOrder: 0 }); // first in [3,1] → pos 0
    expect(mapped[1]).toEqual({ reservationId: 1, sortOrder: 1 }); // second in [3,1] → pos 1
  });

  it("reorder after deleting the first reservation assigns correct id↔position mapping", async () => {
    // Three reservations: ids 1, 2, 3 with sort_orders 0, 1, 2.
    // Step 1 — delete id=1 (first, sortOrder=0).
    //           DELETE re-indexes survivors: ids 2,3 → 0,1 (gap at 0 is closed).
    // Step 2 — user keeps the existing order; client sends reorder [2, 3].
    //           Reorder endpoint must assign: id=2 → sortOrder=0, id=3 → sortOrder=1.
    //           The stale sort_order=1 that id=2 held before the delete must not interfere.
    const TRIP_ID = 11;

    enqueue(
      [{ id: 1, tripId: TRIP_ID, date: "2025-09-05", sortOrder: 0 }], // deleted row
      [{ id: 2 }, { id: 3 }],                                          // survivors
    );

    await deleteReservation(TRIP_ID, 1);

    const reindexCallCount = updateCalls.length;

    await reorderReservations(TRIP_ID, [2, 3]);

    const reorderCalls = updateCalls.slice(reindexCallCount);
    expect(reorderCalls).toHaveLength(2);

    const mapped = reorderCalls.map(extractReorderUpdate);
    expect(mapped[0]).toEqual({ reservationId: 2, sortOrder: 0 }); // first in [2,3]
    expect(mapped[1]).toEqual({ reservationId: 3, sortOrder: 1 }); // second in [2,3]
  });

  it("reorder after deleting the last reservation maps swapped ids to their new positions", async () => {
    // Three reservations: ids 1, 2, 3 with sort_orders 0, 1, 2.
    // Step 1 — delete id=3 (last, sortOrder=2).  Survivors: ids 1,2 → 0,1.
    // Step 2 — user swaps order; client sends reorder [2, 1].
    //           Reorder endpoint must assign: id=2 → sortOrder=0, id=1 → sortOrder=1.
    const TRIP_ID = 12;

    enqueue(
      [{ id: 3, tripId: TRIP_ID, date: "2025-10-20", sortOrder: 2 }], // deleted row
      [{ id: 1 }, { id: 2 }],                                          // survivors
    );

    await deleteReservation(TRIP_ID, 3);

    const reindexCallCount = updateCalls.length;

    await reorderReservations(TRIP_ID, [2, 1]);

    const reorderCalls = updateCalls.slice(reindexCallCount);
    expect(reorderCalls).toHaveLength(2);

    const mapped = reorderCalls.map(extractReorderUpdate);
    expect(mapped[0]).toEqual({ reservationId: 2, sortOrder: 0 }); // first in [2,1]
    expect(mapped[1]).toEqual({ reservationId: 1, sortOrder: 1 }); // second in [2,1]
  });

  it("reorder of a single survivor after two deletions assigns id=3 to sort_order 0", async () => {
    // Three reservations: ids 1, 2, 3.
    // Delete id=1, then delete id=2 → only id=3 survives with sort_order 0.
    // Client sends reorder [3]; endpoint must assign id=3 → sortOrder=0.
    const TRIP_ID = 13;

    // ── First delete: remove id=1 ─────────────────────────────────────────────
    enqueue(
      [{ id: 1, tripId: TRIP_ID, date: "2025-07-15", sortOrder: 0 }],
      [{ id: 2 }, { id: 3 }],
    );
    await deleteReservation(TRIP_ID, 1);

    const afterFirstDelete = updateCalls.length; // 2 re-index updates

    // ── Second delete: remove id=2 ────────────────────────────────────────────
    enqueue(
      [{ id: 2, tripId: TRIP_ID, date: "2025-07-15", sortOrder: 0 }],
      [{ id: 3 }],
    );
    await deleteReservation(TRIP_ID, 2);

    const afterSecondDelete = updateCalls.length; // 1 more re-index update for id=3

    // After both deletes only id=3 remains; re-index set it to sortOrder=0
    const secondReindex = updateCalls.slice(afterFirstDelete, afterSecondDelete);
    expect(secondReindex).toHaveLength(1);
    expect((secondReindex[0].setArgs as any).sortOrder).toBe(0);

    // ── Reorder: client sends [3] ─────────────────────────────────────────────
    await reorderReservations(TRIP_ID, [3]);

    const reorderCalls = updateCalls.slice(afterSecondDelete);
    expect(reorderCalls).toHaveLength(1);

    const mapped = reorderCalls.map(extractReorderUpdate);
    expect(mapped[0]).toEqual({ reservationId: 3, sortOrder: 0 });
  });

  it("reorder after deletion assigns positions solely from the supplied ids array, ignoring pre-delete sort_orders", async () => {
    // Explicitly verifies that stale sort_order values do not bleed into the
    // reorder endpoint.  The reorder endpoint must use array-index position only.
    //
    // Setup: ids 10, 20, 30 had sort_orders 0, 5, 10 (non-contiguous due to
    // prior edits).  Delete id=20 (sortOrder=5); re-index assigns 10→0, 30→1.
    // Client drags 30 to front → sends reorder [30, 10].
    // Expected: id=30 → sortOrder=0, id=10 → sortOrder=1.
    // Must NOT assign any value derived from stale sort_orders (5 or 10).
    const TRIP_ID = 14;

    enqueue(
      [{ id: 20, tripId: TRIP_ID, date: "2025-11-01", sortOrder: 5 }], // deleted row — stale non-contiguous sortOrder
      [{ id: 10 }, { id: 30 }],                                         // survivors
    );

    await deleteReservation(TRIP_ID, 20);

    const reindexCallCount = updateCalls.length;

    await reorderReservations(TRIP_ID, [30, 10]);

    const reorderCalls = updateCalls.slice(reindexCallCount);
    expect(reorderCalls).toHaveLength(2);

    const mapped = reorderCalls.map(extractReorderUpdate);

    // id=30 is first in the supplied array → must receive sortOrder=0
    expect(mapped[0]).toEqual({ reservationId: 30, sortOrder: 0 });
    // id=10 is second in the supplied array → must receive sortOrder=1
    expect(mapped[1]).toEqual({ reservationId: 10, sortOrder: 1 });

    // Neither stale pre-delete value may appear as a sort_order
    const assignedOrders = mapped.map(m => m.sortOrder);
    expect(assignedOrders).not.toContain(5);  // stale sortOrder of deleted id=20
    expect(assignedOrders).not.toContain(10); // stale sortOrder of survivor id=30
  });
});
