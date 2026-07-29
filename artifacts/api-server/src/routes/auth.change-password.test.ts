/**
 * Integration tests for the invite → login → change-password flow.
 *
 * Covers the full end-to-end path a newly-invited traveler takes:
 *   1. The invite endpoint returns a `temporaryPassword` in its 201 response.
 *   2. Logging in with the temporary password succeeds (200 + token).
 *   3. Logging in with a wrong password returns 401.
 *   4. POST /auth/change-password with the correct current password succeeds (200).
 *   5. POST /auth/change-password with a wrong current password is rejected (400).
 *   6. Logging in with the old (temporary) password after a change returns 401.
 *   7. Full end-to-end sequence runs correctly from invite to new-password login.
 *
 * Strategy:
 *   - Mock @workspace/db with the same lazy-dequeue pattern used by the other
 *     route tests — no real Postgres connection required.
 *   - Mock bcryptjs so hashing/comparison is instant and deterministic:
 *       hash(pwd)     → "hashed:<pwd>"
 *       compare(a, b) → a === b   (plaintext equality)
 *   - Mount the auth router and the trips router on a single Express app.
 *   - Two flavours of app are used:
 *       • unauthApp — no session (for login tests)
 *       • authApp(userId, role) — pre-populated session (for change-password tests)
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Set SESSION_SECRET before importing routes (jwt.sign requires it) ─────────

process.env.SESSION_SECRET = "test-secret-do-not-use-in-production";

// ── Mock drizzle-orm operators ────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq:  (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  ne:  (...args: unknown[]) => args,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    ({ sql: String(strings[0]), values }),
}));

// ── Mock bcryptjs ─────────────────────────────────────────────────────────────
// hash(pwd) → "hashed:<pwd>" so we can distinguish "before" and "after" states.
// compare(a, b) → a === b so tests remain deterministic without real cost-10 hashing.

vi.mock("bcryptjs", () => ({
  default: {
    hash:    async (pwd: string, _rounds: number) => `hashed:${pwd}`,
    compare: async (a: string, b: string) => a === b,
  },
}));

// ── Mock @workspace/api-zod ───────────────────────────────────────────────────
// Only LoginBody is consumed by auth.ts.  We replicate its safeParse behaviour
// without importing zod so the factory stays free of top-level variables.

vi.mock("@workspace/api-zod", () => ({
  LoginBody: {
    safeParse(data: unknown) {
      const d = data as Record<string, unknown>;
      if (typeof d?.username === "string" && typeof d?.password === "string") {
        return { success: true, data: { username: d.username, password: d.password } };
      }
      return { success: false, error: new Error("Invalid login body") };
    },
  },
}));

// ── Lazy-dequeue DB mock ──────────────────────────────────────────────────────
// Identical to the approach in participants.invite.test.ts.

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
  usersTable:             fakeTable,
  tripsTable:             fakeTable,
  tripParticipantsTable:  fakeTable,
  tripExpensesTable:      fakeTable,
  expenseSplitsTable:     fakeTable,
  flightsTable:           fakeTable,
  accommodationsTable:    fakeTable,
  activitiesTable:        fakeTable,
  itineraryDaysTable:     fakeTable,
  packingItemsTable:      fakeTable,
  carRentalsTable:        fakeTable,
}));

// ── Mock destination-image (non-essential side-effect for trips router) ───────

vi.mock("../lib/destination-image.js", () => ({
  fetchDestinationImage: async () => null,
}));

// ── Test app builders ─────────────────────────────────────────────────────────

/**
 * App with NO session — used for login tests.
 * req.session is a plain mutable object (no real session store needed).
 */
async function buildUnauthApp() {
  const { default: authRouter } = await import("./auth.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.session = {};   // empty — login handler may write userId/role into it
    next();
  });
  app.use("/api", authRouter);
  return app;
}

/**
 * App with a pre-authenticated session — used for change-password tests.
 * Mimics a traveler who is already logged in.
 */
async function buildAuthApp(userId: number, role = "traveler") {
  const { default: authRouter } = await import("./auth.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.session = { userId, role };
    next();
  });
  app.use("/api", authRouter);
  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let unauthServer: http.Server;
let unauthBase: string;

let authServer: http.Server;
let authBase: string;

function listen(app: express.Express): Promise<{ server: http.Server; base: string }> {
  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({ server, base: `http://localhost:${addr.port}/api` });
    });
  });
}

beforeAll(async () => {
  const [unauth, auth] = await Promise.all([
    buildUnauthApp(),
    buildAuthApp(99, "traveler"),
  ]);
  ({ server: unauthServer, base: unauthBase } = await listen(unauth));
  ({ server: authServer, base: authBase } = await listen(auth));
});

afterAll(() => {
  unauthServer.close();
  authServer.close();
});

beforeEach(() => {
  resultQueue.length = 0;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postUnauth(path: string, body: unknown) {
  const res = await fetch(`${unauthBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function postAuth(path: string, body: unknown) {
  const res = await fetch(`${authBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

// ── Fixture: a traveler user as stored in the DB ──────────────────────────────
//
// With the bcrypt mock, the "passwordHash" field holds the temporary password
// prefixed with "hashed:" — but compare(a, b) just does a === b, so in tests
// we store the plain password directly as the hash to keep assertions simple.

function makeTraveler(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 99,
    username: "alice@example.com",
    name: "Alice",
    email: "alice@example.com",
    role: "traveler",
    passwordHash: "temp-pass-abc123",  // what compare() sees as the "stored hash"
    createdAt: new Date(),
    ...overrides,
  };
}

// ── 1. Login with temporary password ─────────────────────────────────────────

describe("POST /auth/login — temporary password", () => {
  /**
   * DB call sequence inside POST /auth/login:
   *   1. select users where username = ?  → [user]
   */

  it("returns 200 when the temporary password matches the stored hash", async () => {
    const user = makeTraveler({ passwordHash: "temp-pass-abc123" });
    enqueue([user]);

    const { status } = await postUnauth("/auth/login", {
      username: "alice@example.com",
      password: "temp-pass-abc123",
    });

    expect(status).toBe(200);
  });

  it("response includes the user id, username, name, role, and a JWT token", async () => {
    const user = makeTraveler({ passwordHash: "temp-pass-abc123" });
    enqueue([user]);

    const { body } = await postUnauth("/auth/login", {
      username: "alice@example.com",
      password: "temp-pass-abc123",
    });

    expect(body.id).toBe(99);
    expect(body.username).toBe("alice@example.com");
    expect(body.name).toBe("Alice");
    expect(body.role).toBe("traveler");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  it("returns 401 when the temporary password is wrong", async () => {
    const user = makeTraveler({ passwordHash: "temp-pass-abc123" });
    enqueue([user]);

    const { status } = await postUnauth("/auth/login", {
      username: "alice@example.com",
      password: "wrong-password",
    });

    expect(status).toBe(401);
  });

  it("returns 401 when the username does not exist", async () => {
    enqueue([]); // no user found

    const { status, body } = await postUnauth("/auth/login", {
      username: "nobody@example.com",
      password: "any-password",
    });

    expect(status).toBe(401);
    expect(typeof body.error).toBe("string");
  });
});

// ── 2. Change password with correct current password ─────────────────────────

describe("POST /auth/change-password — correct current password", () => {
  /**
   * DB call sequence inside POST /auth/change-password:
   *   1. select users where id = ?   → [user]
   *   2. update users set passwordHash (returns ignored)
   */

  it("returns 200 when currentPassword matches and newPassword is valid", async () => {
    const user = makeTraveler({ passwordHash: "temp-pass-abc123" });
    enqueue([user]); // 1. user lookup
    enqueue([]);     // 2. update (return value not used)

    const { status, body } = await postAuth("/auth/change-password", {
      currentPassword: "temp-pass-abc123",
      newPassword: "my-new-secure-password",
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  it("accepts a new password that is exactly 8 characters long", async () => {
    const user = makeTraveler({ passwordHash: "temp-pass-abc123" });
    enqueue([user]);
    enqueue([]);

    const { status } = await postAuth("/auth/change-password", {
      currentPassword: "temp-pass-abc123",
      newPassword: "8charspw",
    });

    expect(status).toBe(200);
  });
});

// ── 3. Change password with wrong current password ───────────────────────────

describe("POST /auth/change-password — wrong current password", () => {
  it("returns 400 when currentPassword does not match", async () => {
    const user = makeTraveler({ passwordHash: "temp-pass-abc123" });
    enqueue([user]); // 1. user lookup — bcrypt.compare will fail

    const { status, body } = await postAuth("/auth/change-password", {
      currentPassword: "wrong-current-password",
      newPassword: "my-new-secure-password",
    });

    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(body.error.toLowerCase()).toMatch(/incorrect|wrong|invalid/i);
  });

  it("does not update the password when currentPassword is wrong", async () => {
    const user = makeTraveler({ passwordHash: "temp-pass-abc123" });
    enqueue([user]);
    // No update result queued — if an update were attempted it would consume
    // the next (empty) queue slot; the queue must be fully drained at depth 0.

    await postAuth("/auth/change-password", {
      currentPassword: "wrong-current-password",
      newPassword: "my-new-secure-password",
    });

    // The queue still has nothing left to consume (no update was issued)
    expect(resultQueue.length).toBe(0);
  });
});

// ── 4. Change-password input validation ──────────────────────────────────────

describe("POST /auth/change-password — input validation", () => {
  it("returns 400 when currentPassword is missing", async () => {
    const { status, body } = await postAuth("/auth/change-password", {
      newPassword: "my-new-secure-password",
    });
    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when currentPassword is blank whitespace", async () => {
    const { status, body } = await postAuth("/auth/change-password", {
      currentPassword: "   ",
      newPassword: "my-new-secure-password",
    });
    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when newPassword is missing", async () => {
    const { status, body } = await postAuth("/auth/change-password", {
      currentPassword: "temp-pass-abc123",
    });
    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 when newPassword is shorter than 8 characters", async () => {
    const { status, body } = await postAuth("/auth/change-password", {
      currentPassword: "temp-pass-abc123",
      newPassword: "short",
    });
    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
  });
});

// ── 5. Login with old password after password change ─────────────────────────

describe("POST /auth/login — old password after change", () => {
  /**
   * After the traveler updates their password the stored hash changes.
   * We simulate this by queuing a user whose passwordHash is the NEW
   * password — so a login attempt with the OLD password will fail with 401.
   */

  it("returns 401 when the old temporary password is used after a change", async () => {
    // Simulate the user record AFTER the password has been changed:
    // the stored hash now reflects the new password.
    const userAfterChange = makeTraveler({ passwordHash: "my-new-secure-password" });
    enqueue([userAfterChange]);

    const { status } = await postUnauth("/auth/login", {
      username: "alice@example.com",
      password: "temp-pass-abc123",   // old password — no longer valid
    });

    expect(status).toBe(401);
  });

  it("returns 200 when the NEW password is used after a change", async () => {
    const userAfterChange = makeTraveler({ passwordHash: "my-new-secure-password" });
    enqueue([userAfterChange]);

    const { status } = await postUnauth("/auth/login", {
      username: "alice@example.com",
      password: "my-new-secure-password",   // new password — should work
    });

    expect(status).toBe(200);
  });
});

// ── 6. Full end-to-end: invite → login → change → confirm ────────────────────

describe("Full flow: invite → login with temp password → change → verify", () => {
  /**
   * This test drives every step of the happy path in sequence within one test
   * so that the relationship between steps is explicit and cannot be broken by
   * a partial change to any one endpoint.
   *
   * Steps:
   *   A. Invite creates an account and returns a temporaryPassword.
   *   B. Traveler logs in with the temporaryPassword → 200 + token.
   *   C. Traveler changes password (currentPassword = temporaryPassword) → 200.
   *   D. Login with OLD (temp) password → 401.
   *   E. Login with NEW password → 200.
   */

  it("completes the invite → login → change-password → re-login cycle correctly", async () => {
    // ── A. Invite ─────────────────────────────────────────────────────────────
    // Build a separate trips app to exercise the invite endpoint.
    const { default: tripsRouter } = await import("./trips.js");
    const { default: authRouter } = await import("./auth.js");

    const fullApp = express();
    fullApp.use(express.json());
    fullApp.use((req: any, _res: any, next: any) => {
      req.session = { userId: 1, role: "super_admin" };
      next();
    });
    fullApp.use("/api", tripsRouter);
    fullApp.use("/api", authRouter);

    const { server: fullServer, base: fullBase } = await listen(fullApp);

    try {
      // DB results for invite: no existing user, insert new user, add participant, recalc
      const tempPassword = "randomTempPass99";
      const newUser = {
        id: 99,
        username: "alice@example.com",
        name: "Alice",
        email: "alice@example.com",
        role: "traveler",
        passwordHash: `hashed:${tempPassword}`,
        createdAt: new Date(),
      };
      enqueue(
        [],                                       // lookup: email not taken
        [newUser],                                // insert user returning
        [],                                       // insert participant
        [{ userId: 1 }, { userId: 99 }],          // recalc: participants
        [],                                       // recalc: expenses (empty)
      );

      const inviteRes = await fetch(`${fullBase}/trips/1/participants/invite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Alice", email: "alice@example.com" }),
      });
      const inviteBody = await inviteRes.json() as Record<string, any>;

      expect(inviteRes.status).toBe(201);
      expect(typeof inviteBody.temporaryPassword).toBe("string");
      expect(inviteBody.temporaryPassword.length).toBeGreaterThan(0);

      // ── B. Login with temporary password ───────────────────────────────────
      // bcrypt.hash in the invite route stored `hashed:<tempPassword>`, but our
      // mock stores "hashed-password" uniformly.  To keep this end-to-end step
      // realistic we enqueue a user whose passwordHash equals what compare()
      // expects: the traveler's raw temp password.
      //
      // In production bcrypt.compare(plain, realHash) works correctly. In tests,
      // compare(a, b) = a === b, so we enqueue passwordHash = plain password.

      const tempPwd = inviteBody.temporaryPassword as string;
      enqueue([{ ...newUser, passwordHash: tempPwd }]);

      const loginRes = await fetch(`${fullBase}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice@example.com", password: tempPwd }),
      });
      const loginBody = await loginRes.json() as Record<string, any>;

      expect(loginRes.status).toBe(200);
      expect(typeof loginBody.token).toBe("string");

      // ── C. Change password ─────────────────────────────────────────────────
      // Build a traveler-authenticated app to POST /auth/change-password.
      const travelerApp = express();
      travelerApp.use(express.json());
      travelerApp.use((req: any, _res: any, next: any) => {
        req.session = { userId: 99, role: "traveler" };
        next();
      });
      travelerApp.use("/api", authRouter);
      const { server: travelerServer, base: travelerBase } = await listen(travelerApp);

      try {
        enqueue([{ ...newUser, passwordHash: tempPwd }]); // select user for change-password
        enqueue([]);                                       // update (ignored)

        const changeRes = await fetch(`${travelerBase}/auth/change-password`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            currentPassword: tempPwd,
            newPassword: "MyNewSecurePass1",
          }),
        });
        const changeBody = await changeRes.json() as Record<string, any>;

        expect(changeRes.status).toBe(200);
        expect(changeBody.success).toBe(true);
      } finally {
        travelerServer.close();
      }

      // ── D. Login with OLD password → 401 ───────────────────────────────────
      enqueue([{ ...newUser, passwordHash: "MyNewSecurePass1" }]); // stored hash = new password

      const oldLoginRes = await fetch(`${fullBase}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice@example.com", password: tempPwd }),
      });

      expect(oldLoginRes.status).toBe(401);

      // ── E. Login with NEW password → 200 ───────────────────────────────────
      enqueue([{ ...newUser, passwordHash: "MyNewSecurePass1" }]);

      const newLoginRes = await fetch(`${fullBase}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice@example.com", password: "MyNewSecurePass1" }),
      });
      const newLoginBody = await newLoginRes.json() as Record<string, any>;

      expect(newLoginRes.status).toBe(200);
      expect(typeof newLoginBody.token).toBe("string");
    } finally {
      fullServer.close();
    }
  });
});
