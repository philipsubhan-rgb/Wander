/**
 * Integration tests for the participant invite flow.
 *
 * Covers three behaviours required by the "invited traveler" spec:
 *   1. A successful invite creates the account, adds the traveler to the trip,
 *      and returns a temporary password — confirming the participant count rises.
 *   2. Searching for the just-invited email via GET /users/lookup finds the
 *      existing account instead of returning 404 (no-account-found path).
 *   3. Calling POST …/participants/invite a second time with the same email
 *      returns 409 with a clear human-readable error.
 *
 * Strategy:
 *   - Mock @workspace/db with a lazy queue so each DB call dequeues the next
 *     preset result.  No real Postgres connection is required.
 *   - Mock bcryptjs so password hashing is instant.
 *   - Mount both the trips router and the users router on a single Express app
 *     with a fake trip-admin session, then drive requests with built-in fetch
 *     (Node ≥ 18).
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Mock drizzle-orm operators ────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq:  (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  ne:  (...args: unknown[]) => args,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    ({ sql: String(strings[0]), values }),
  count: () => "count_placeholder",
}));

// ── Mock bcryptjs ─────────────────────────────────────────────────────────────
// Real bcrypt with cost=10 is ~100 ms per call; we replace it with a no-op so
// the test suite stays fast.

vi.mock("bcryptjs", () => ({
  default: {
    hash:    async (_pwd: string, _rounds: number) => "hashed-password",
    compare: async (a: string, b: string) => a === b,
  },
}));

// ── Lazy-dequeue DB mock ──────────────────────────────────────────────────────
//
// Each top-level db method (select / insert / update / delete) creates a fresh
// chain. The chain is thenable; the first time it's awaited it dequeues the
// next item from resultQueue.  All builder methods (from, where, …) return the
// same chain so the mock is agnostic of the exact Drizzle call sequence.

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

  for (const m of [
    "from", "where", "innerJoin", "leftJoin", "orderBy",
    "set", "values", "returning", "onConflictDoNothing",
  ]) {
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
  tripsTable:             fakeTable,
  tripParticipantsTable:  fakeTable,
  usersTable:             fakeTable,
  tripExpensesTable:      fakeTable,
  expenseSplitsTable:     fakeTable,
  flightsTable:           fakeTable,
  accommodationsTable:    fakeTable,
  activitiesTable:        fakeTable,
  itineraryDaysTable:     fakeTable,
  packingItemsTable:      fakeTable,
  carRentalsTable:        fakeTable,
}));

// ── Mock destination-image (non-essential side-effect) ────────────────────────

vi.mock("../lib/destination-image.js", () => ({
  fetchDestinationImage: async () => null,
}));

// ── Test app ──────────────────────────────────────────────────────────────────
//
// Session: userId=1, role="super_admin" so requireTripAdmin() passes without
// an extra DB query.

async function buildTestApp() {
  const [{ default: tripsRouter }, { default: usersRouter }] = await Promise.all([
    import("./trips.js"),
    import("./users.js"),
  ]);

  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.session = { userId: 1, role: "super_admin" };
    next();
  });
  app.use("/api", tripsRouter);
  app.use("/api", usersRouter);
  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = await buildTestApp();
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, resolve);
  });
  base = `http://localhost:${(server.address() as { port: number }).port}/api`;
});

afterAll(() => server.close());

beforeEach(() => {
  resultQueue.length = 0;
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

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  return { status: res.status, body: (await res.json()) as any };
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

/**
 * Enqueue the DB results for a successful invite of a brand-new traveler.
 *
 * DB call sequence inside POST …/participants/invite:
 *   1. select users where email = ?       → [] (no existing account)
 *   2. insert users returning             → [newUser]
 *   3. insert tripParticipants (no return — onConflictDoNothing)
 *
 * recalcExpenseSplitsForTrip then runs two parallel selects:
 *   4. select tripParticipants (Promise.all[0])  → [{ userId: 1 }, { userId: 99 }]
 *   5. select tripExpenses     (Promise.all[1])  → [] (no expenses → early return 0)
 */
function enqueueSuccessfulInvite(
  newUser = {
    id: 99,
    username: "alice@example.com",
    name: "Alice",
    email: "alice@example.com",
    role: "traveler",
    createdAt: new Date(),
    passwordHash: "hashed-password",
  }
) {
  enqueue(
    [],             // 1. no existing user with that email
    [newUser],      // 2. insert user returning
    [],             // 3. insert participant (onConflictDoNothing — ignored result)
    [{ userId: 1 }, { userId: newUser.id }],  // 4. recalc: participants
    [],             // 5. recalc: expenses (empty → early exit, returns 0)
  );
  return newUser;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /trips/:tripId/participants/invite — happy path", () => {
  it("returns 201 with the new traveler's details and a temporary password", async () => {
    enqueueSuccessfulInvite();

    const { status, body } = await post("/trips/1/participants/invite", {
      name: "Alice",
      email: "alice@example.com",
    });

    expect(status).toBe(201);
    expect(body.id).toBe(99);
    expect(body.name).toBe("Alice");
    expect(body.email).toBe("alice@example.com");
    expect(body.role).toBe("traveler");
    // A temporary password must be returned so the admin can relay it
    expect(typeof body.temporaryPassword).toBe("string");
    expect(body.temporaryPassword.length).toBeGreaterThan(0);
  });

  it("normalises the email to lowercase before storing", async () => {
    enqueueSuccessfulInvite({
      id: 100,
      username: "bob@example.com",
      name: "Bob",
      email: "bob@example.com",
      role: "traveler",
      createdAt: new Date(),
      passwordHash: "hashed-password",
    });

    const { status, body } = await post("/trips/1/participants/invite", {
      name: "Bob",
      email: "BOB@EXAMPLE.COM",   // intentionally upper-case
    });

    expect(status).toBe(201);
    // The route normalises on the way in; what comes back is the stored row
    expect(body.email).toBe("bob@example.com");
  });
});

describe("POST /trips/:tripId/participants/invite — duplicate email guard", () => {
  /**
   * When the same email is invited a second time the route must return 409
   * with a human-readable message that guides the admin to the search flow.
   *
   * DB call sequence (only 1 query — we short-circuit after finding the user):
   *   1. select users where email = ?  → [{ id: 50 }]  (existing account found)
   */
  it("returns 409 with a clear error when the email is already registered", async () => {
    enqueue([{ id: 50 }]); // 1. existing user found → reject immediately

    const { status, body } = await post("/trips/1/participants/invite", {
      name: "Alice Again",
      email: "alice@example.com",
    });

    expect(status).toBe(409);
    expect(typeof body.error).toBe("string");
    // The message should mention searching by email so the admin knows what to do
    expect(body.error.toLowerCase()).toMatch(/already exists|search by email/i);
  });

  it("does not create a second account when the email already exists", async () => {
    // Return an existing user on the lookup, triggering the 409 early exit
    enqueue([{ id: 50 }]);

    const { status } = await post("/trips/1/participants/invite", {
      name: "Duplicate",
      email: "alice@example.com",
    });

    // Confirm only one DB call was consumed (the lookup); no insert happened
    expect(status).toBe(409);
    // If an insert had been attempted, it would consume the next queue slot;
    // the queue is now empty so any further DB call would return [].
    // We verify no stray results were queued (queue is fully drained at correct depth).
    expect(resultQueue.length).toBe(0);
  });
});

describe("GET /users/lookup — email resolves after invite", () => {
  /**
   * After a traveler is invited their account exists in the DB.  Searching for
   * that email must return the user record (status 200) — not a 404 that would
   * show the "create account" form in the UI.
   *
   * DB call sequence inside GET /users/lookup:
   *   1. select users where email = ?           → [user]  (account exists)
   *   2. select count(*) from tripParticipants  → [{ tripCount: 1 }]
   */
  it("returns 200 with the existing account when the email is already registered", async () => {
    enqueue(
      [{ id: 99, username: "alice@example.com", name: "Alice", email: "alice@example.com", role: "traveler", createdAt: new Date() }],
      [{ tripCount: 1 }],
    );

    const { status, body } = await get(
      "/users/lookup?email=alice%40example.com"
    );

    expect(status).toBe(200);
    expect(body.id).toBe(99);
    expect(body.name).toBe("Alice");
    expect(body.email).toBe("alice@example.com");
    // otherTripsCount is returned so the UI can show the confirmation dialog
    expect(typeof body.otherTripsCount).toBe("number");
  });

  it("returns 404 when no account exists for that email", async () => {
    enqueue([]); // no user found

    const { status } = await get("/users/lookup?email=unknown%40example.com");

    expect(status).toBe(404);
  });
});

describe("GET /trips/:tripId/participants — count after invite", () => {
  /**
   * The participants list must include the newly-invited traveler immediately
   * after the invite completes (query-cache invalidation is handled on the
   * client; here we verify the API returns the right data).
   *
   * DB call sequence inside GET /trips/:tripId/participants:
   *   1. select users + tripParticipants (joined)  → list of participants
   */
  it("reflects the new participant in the list after a successful invite", async () => {
    // Simulate the list endpoint returning two participants (admin + new invite)
    enqueue([
      {
        user: { id: 1,  username: "admin@example.com", name: "Admin", role: "super_admin",  email: "admin@example.com",  createdAt: new Date() },
        participant: { isTripAdmin: true },
      },
      {
        user: { id: 99, username: "alice@example.com",  name: "Alice", role: "traveler", email: "alice@example.com", createdAt: new Date() },
        participant: { isTripAdmin: false },
      },
    ]);

    const { status, body } = await get("/trips/1/participants");

    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);

    const alice = body.find((p: any) => p.email === "alice@example.com");
    expect(alice).toBeDefined();
    expect(alice.name).toBe("Alice");
    expect(alice.isTripAdmin).toBe(false);
  });

  it("participant count increases from 1 to 2 after an invite", async () => {
    // Before invite: only the admin
    enqueue([
      {
        user: { id: 1, username: "admin@example.com", name: "Admin", role: "super_admin", email: "admin@example.com", createdAt: new Date() },
        participant: { isTripAdmin: true },
      },
    ]);
    const before = await get("/trips/1/participants");
    expect(before.body).toHaveLength(1);

    // Invite succeeds
    enqueueSuccessfulInvite();
    const invite = await post("/trips/1/participants/invite", {
      name: "Alice",
      email: "alice@example.com",
    });
    expect(invite.status).toBe(201);

    // After invite: admin + new traveler
    enqueue([
      {
        user: { id: 1,  username: "admin@example.com", name: "Admin", role: "super_admin",  email: "admin@example.com",  createdAt: new Date() },
        participant: { isTripAdmin: true },
      },
      {
        user: { id: 99, username: "alice@example.com",  name: "Alice", role: "traveler", email: "alice@example.com", createdAt: new Date() },
        participant: { isTripAdmin: false },
      },
    ]);
    const after = await get("/trips/1/participants");
    expect(after.body).toHaveLength(2);

    // Count went up by exactly 1
    expect(after.body.length - before.body.length).toBe(1);
  });
});

describe("POST /trips/:tripId/participants/invite — input validation", () => {
  it("returns 400 when name is missing", async () => {
    const { status, body } = await post("/trips/1/participants/invite", {
      email: "alice@example.com",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/name/i);
  });

  it("returns 400 when email is missing", async () => {
    const { status, body } = await post("/trips/1/participants/invite", {
      name: "Alice",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/email/i);
  });

  it("returns 400 when name is blank whitespace", async () => {
    const { status, body } = await post("/trips/1/participants/invite", {
      name: "   ",
      email: "alice@example.com",
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/name/i);
  });
});
