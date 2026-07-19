/**
 * Integration tests for the expenses routes.
 *
 * Strategy: mock @workspace/db with a chainable fake that dequeues preset
 * results in the order the route handler makes DB calls. Mount the expenses
 * router on a minimal Express app (no real session store) and use the
 * built-in fetch (Node ≥ 18) to drive requests.
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";

// ── Chainable DB mock ─────────────────────────────────────────────────────────
//
// Each top-level db method (select / insert / update / delete) creates a fresh
// "chain". The chain is thenable — when awaited it dequeues the next item from
// `resultQueue`. All intermediate builder methods (from, where, …) return the
// same chain, so the mock is agnostic of which drizzle methods the real code
// chains together.

const resultQueue: unknown[] = [];

function enqueue(...items: unknown[]) {
  resultQueue.push(...items);
}

function makeChain(): any {
  // Build the promise lazily so the dequeue happens at await-time, not at
  // chain-construction time (important: multiple chains can be built before
  // any of them is awaited).
  let p: Promise<unknown> | null = null;
  function promise() {
    if (!p) p = Promise.resolve(resultQueue.shift() ?? []);
    return p;
  }

  const chain: any = {
    then:    (res: any, rej: any)  => promise().then(res, rej),
    catch:   (rej: any)            => promise().catch(rej),
    finally: (fin: any)            => promise().finally(fin),
  };

  for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "set", "values", "returning"]) {
    chain[m] = () => chain;
  }
  return chain;
}

// Minimal table placeholder objects — real column references are not needed
// because our mock .where() / .from() etc. ignore their arguments entirely.
const fakeTable = new Proxy({}, { get: (_t, p) => p });

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  tripExpensesTable:    fakeTable,
  expenseSplitsTable:   fakeTable,
  tripParticipantsTable: fakeTable,
  usersTable:            fakeTable,
  pool:                  { query: vi.fn(), end: vi.fn() },
}));

// ── Minimal test Express app ──────────────────────────────────────────────────
//
// We deliberately skip the real session / ConnectPgSimple setup (which would
// need a live DB). Instead we inject a fake session that makes every request
// look like a logged-in global admin (role = 'admin'), which lets
// requireTripParticipant short-circuit without touching the DB.

async function buildTestApp() {
  const { default: expensesRouter } = await import("./expenses.js");

  const app = express();
  app.use(express.json());

  // Fake session middleware
  app.use((req: any, _res, next) => {
    req.session = { userId: 1, role: "admin" };
    next();
  });

  app.use("/api", expensesRouter);
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
  resultQueue.length = 0; // reset queue before every test
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function patch(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

// ── POST /trips/:tripId/expenses ──────────────────────────────────────────────

describe("POST /trips/:tripId/expenses", () => {
  /**
   * DB call sequence inside the handler:
   *  1. select participants (for payer-validation)            → [{userId:1},{userId:2},{userId:3}]
   *  2. insert expense .returning()                           → [expense row]
   *  3. (recreateSplits) delete old splits                    → []
   *  4. (recreateSplits) select participants                  → [{userId:1},{userId:2},{userId:3}]
   *  5. (recreateSplits) insert new splits                    → []
   *  6. (fetchExpensesWithSplits) select expenses + payer     → [{expense, payerName}]
   *  7. (fetchExpensesWithSplits) select splits + user names  → [{split, userName}]
   */
  function enqueuePostScenario({
    participants = [{ userId: 1 }, { userId: 2 }, { userId: 3 }],
    expense = {
      id: 42, tripId: 1, paidByUserId: 1, amount: "30.00",
      currency: "USD", description: "Dinner", category: "restaurant",
      date: "2025-07-01", notes: null, createdAt: new Date(),
    },
    splits = [
      { split: { id: 1, expenseId: 42, userId: 1, shareAmount: "10.00", isPaid: true,  paidAt: new Date() }, userName: "Alice" },
      { split: { id: 2, expenseId: 42, userId: 2, shareAmount: "10.00", isPaid: false, paidAt: null       }, userName: "Bob"   },
      { split: { id: 3, expenseId: 42, userId: 3, shareAmount: "10.00", isPaid: false, paidAt: null       }, userName: "Carol" },
    ],
  } = {}) {
    enqueue(
      participants,                              // 1. validate payer
      [expense],                                 // 2. insert expense
      [],                                        // 3. delete splits
      participants,                              // 4. select participants (recreateSplits)
      [],                                        // 5. insert splits
      [{ expense, payerName: "Alice" }],         // 6. fetch expenses
      splits,                                    // 7. fetch splits
    );
    return { expense, splits };
  }

  it("returns 201 with the created expense", async () => {
    enqueuePostScenario();
    const { status } = await post("/trips/1/expenses", {
      paidByUserId: 1,
      amount: "30.00",
      description: "Dinner",
      date: "2025-07-01",
    });
    expect(status).toBe(201);
  });

  it("response includes a splits array", async () => {
    const { expense } = enqueuePostScenario();
    const { body } = await post("/trips/1/expenses", {
      paidByUserId: 1,
      amount: expense.amount,
      description: expense.description,
      date: expense.date,
    });
    expect(Array.isArray(body.splits)).toBe(true);
    expect(body.splits).toHaveLength(3);
  });

  it("payer split is marked isPaid=true; others are isPaid=false", async () => {
    const { expense } = enqueuePostScenario();
    const { body } = await post("/trips/1/expenses", {
      paidByUserId: 1,
      amount: expense.amount,
      description: expense.description,
      date: expense.date,
    });
    const payerSplit  = body.splits.find((s: any) => s.userId === 1);
    const otherSplits = body.splits.filter((s: any) => s.userId !== 1);
    expect(payerSplit?.isPaid).toBe(true);
    expect(otherSplits.every((s: any) => s.isPaid === false)).toBe(true);
  });

  it("split amounts sum to the total expense amount", async () => {
    const { expense } = enqueuePostScenario();
    const { body } = await post("/trips/1/expenses", {
      paidByUserId: 1,
      amount: expense.amount,
      description: expense.description,
      date: expense.date,
    });
    const total = body.splits.reduce(
      (sum: number, s: any) => sum + parseFloat(s.shareAmount), 0
    );
    expect(Math.round(total * 100) / 100).toBeCloseTo(parseFloat(expense.amount), 2);
  });

  it("returns 400 when paidByUserId is not a participant", async () => {
    // Return participants that do NOT include userId 99
    enqueue([{ userId: 1 }, { userId: 2 }]);
    const { status, body } = await post("/trips/1/expenses", {
      paidByUserId: 99,
      amount: "20.00",
      description: "Taxi",
      date: "2025-07-01",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/participant/i);
  });

  it("returns 400 when trip has no participants", async () => {
    enqueue([]);
    const { status } = await post("/trips/1/expenses", {
      paidByUserId: 1,
      amount: "20.00",
      description: "Taxi",
      date: "2025-07-01",
    });
    expect(status).toBe(400);
  });
});

// ── PATCH /trips/:tripId/expenses/:expenseId ──────────────────────────────────

describe("PATCH /trips/:tripId/expenses/:expenseId — splits recalculate on change", () => {
  const updatedExpense = {
    id: 42, tripId: 1, paidByUserId: 1, amount: "60.00",
    currency: "USD", description: "Hotel", category: "accommodation",
    date: "2025-07-01", notes: null, createdAt: new Date(),
  };
  const participants = [{ userId: 1 }, { userId: 2 }, { userId: 3 }];
  const updatedSplits = [
    { split: { id: 10, expenseId: 42, userId: 1, shareAmount: "20.00", isPaid: true,  paidAt: new Date() }, userName: "Alice" },
    { split: { id: 11, expenseId: 42, userId: 2, shareAmount: "20.00", isPaid: false, paidAt: null       }, userName: "Bob"   },
    { split: { id: 12, expenseId: 42, userId: 3, shareAmount: "20.00", isPaid: false, paidAt: null       }, userName: "Carol" },
  ];

  /**
   * PATCH handler DB sequence when amount changes:
   *  1. update expense .returning()          → [updatedExpense]
   *  2. (recreateSplits) delete splits       → []
   *  3. (recreateSplits) select participants → participants
   *  4. (recreateSplits) insert splits       → []
   *  5. (fetchExpenses) select expenses      → [{expense, payerName}]
   *  6. (fetchExpenses) select splits        → updatedSplits
   */
  function enqueueAmountChange() {
    enqueue(
      [updatedExpense],                                        // 1. update
      [],                                                      // 2. delete splits
      participants,                                            // 3. select participants
      [],                                                      // 4. insert splits
      [{ expense: updatedExpense, payerName: "Alice" }],       // 5. fetch expenses
      updatedSplits,                                           // 6. fetch splits
    );
  }

  it("returns the updated expense after an amount change", async () => {
    enqueueAmountChange();
    const { status, body } = await patch("/trips/1/expenses/42", { amount: "60.00" });
    expect(status).toBe(200);
    expect(body.id).toBe(42);
  });

  it("splits are present on the response after an amount change", async () => {
    enqueueAmountChange();
    const { body } = await patch("/trips/1/expenses/42", { amount: "60.00" });
    expect(Array.isArray(body.splits)).toBe(true);
    expect(body.splits).toHaveLength(3);
  });

  it("new split amounts reflect the updated total", async () => {
    enqueueAmountChange();
    const { body } = await patch("/trips/1/expenses/42", { amount: "60.00" });
    const total = body.splits.reduce(
      (sum: number, s: any) => sum + parseFloat(s.shareAmount), 0
    );
    expect(Math.round(total * 100) / 100).toBeCloseTo(60, 2);
  });

  it("description-only PATCH does NOT trigger recreateSplits (fewer DB calls)", async () => {
    /**
     * When neither amount nor paidByUserId changes the handler skips recreateSplits.
     * DB sequence for description-only PATCH:
     *  1. update expense .returning()         → [updatedExpense]
     *  2. (fetchExpenses) select expenses     → [{expense, payerName}]
     *  3. (fetchExpenses) select splits       → updatedSplits
     *
     * We enqueue exactly 3 results; if recreateSplits ran it would dequeue 3 more
     * (delete + select + insert), leaving the fetchExpenses calls to get wrong data.
     * A successful 200 response proves recreateSplits was NOT called.
     */
    enqueue(
      [updatedExpense],
      [{ expense: updatedExpense, payerName: "Alice" }],
      updatedSplits,
    );
    const { status } = await patch("/trips/1/expenses/42", { description: "Hotel (updated)" });
    expect(status).toBe(200);
    // Queue should now be empty — no extra DB calls were made
    expect(resultQueue).toHaveLength(0);
  });

  it("returns 404 when expense does not belong to the trip", async () => {
    enqueue([]); // update returns empty (no matching row)
    const { status, body } = await patch("/trips/1/expenses/999", { amount: "50.00" });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });
});
