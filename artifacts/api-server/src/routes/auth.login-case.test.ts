/**
 * Integration tests for case-insensitive login.
 *
 * The login route normalises the incoming username with `.trim().toLowerCase()`
 * before the DB lookup (auth.ts line 47).  These tests verify that normalisation
 * actually happens — not just that a 200 is returned — by capturing the argument
 * that the route passes to the `where()` clause and asserting it is the
 * trimmed-lowercase form of whatever the caller sent.
 *
 * Covered cases:
 *   1. Fully uppercase email      "SARAH@EXAMPLE.COM"   → where receives "sarah@example.com" → 200 + token
 *   2. Mixed-case email           "Sarah@Example.Com"   → where receives "sarah@example.com" → 200 + token
 *   3. Leading/trailing spaces    "  SARAH@EXAMPLE.COM  " → trimmed + lowercased             → 200 + token
 *   4. Lowercase (baseline)       "sarah@example.com"   → unchanged                          → 200 + token
 *   5. Wrong password with uppercase email                                                    → 401
 *   6. Unknown uppercase email                                                                → 401
 *
 * Strategy:
 *   - Mock @workspace/db with a lazy-dequeue pattern — no real Postgres needed.
 *   - The `where` clause handler captures its argument so tests can inspect the
 *     exact lookup value the route computed.
 *   - Mock bcryptjs: compare(a, b) === (a === b) — deterministic without real cost.
 *   - eq(column, value) returns [column, value] so inspecting where's argument
 *     reveals the normalised username directly.
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Set SESSION_SECRET before importing routes (jwt.sign requires it) ─────────

process.env.SESSION_SECRET = "test-secret-login-case";

// ── Mock drizzle-orm operators ────────────────────────────────────────────────
// eq(column, value) returns [column, value] — this lets tests inspect what
// the route actually passed as the lookup key.

vi.mock("drizzle-orm", () => ({
  eq:     (...args: unknown[]) => args,
  and:    (...args: unknown[]) => args,
  ne:     (...args: unknown[]) => args,
  gt:     (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    ({ sql: String(strings[0]), values }),
}));

// ── Mock bcryptjs ─────────────────────────────────────────────────────────────
// compare(a, b) → a === b so tests are deterministic without real cost-10 hashing.

vi.mock("bcryptjs", () => ({
  default: {
    hash:    async (pwd: string, _rounds: number) => `hashed:${pwd}`,
    compare: async (a: string, b: string) => a === b,
  },
}));

// ── Mock @workspace/api-zod ───────────────────────────────────────────────────

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

// ── DB mock that captures the where() argument ────────────────────────────────
// capturedWhereArg is reset in beforeEach.  Tests that care about the lookup
// value read it after the HTTP call.

const resultQueue: unknown[] = [];
let capturedWhereArg: unknown = undefined;

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
    // Capture the WHERE argument so tests can assert what username the route used.
    where: (arg: unknown) => {
      capturedWhereArg = arg;
      return chain;
    },
  };
  for (const m of [
    "from", "innerJoin", "leftJoin", "orderBy",
    "set", "values", "returning", "onConflictDoNothing",
  ]) {
    chain[m] = () => chain;
  }
  return chain;
}

// fakeTable is a Proxy that returns the property name as the column identifier,
// so eq(usersTable.username, value) → ["username", value].
const fakeTable = new Proxy({}, { get: (_t, p) => p });

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  usersTable:               fakeTable,
  tripsTable:               fakeTable,
  tripParticipantsTable:    fakeTable,
  tripExpensesTable:        fakeTable,
  expenseSplitsTable:       fakeTable,
  flightsTable:             fakeTable,
  accommodationsTable:      fakeTable,
  activitiesTable:          fakeTable,
  itineraryDaysTable:       fakeTable,
  packingItemsTable:        fakeTable,
  carRentalsTable:          fakeTable,
  passwordResetTokensTable: fakeTable,
}));

// ── Mock non-essential side-effects ──────────────────────────────────────────

vi.mock("../lib/destination-image.js", () => ({
  fetchDestinationImage: async () => null,
}));

vi.mock("../lib/email.js", () => ({
  sendPasswordResetEmail: async () => undefined,
}));

// ── Test app ──────────────────────────────────────────────────────────────────

async function buildApp() {
  const { default: authRouter } = await import("./auth.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.session = {};
    next();
  });
  app.use("/api", authRouter);
  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = await buildApp();
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, () => {
      const addr = server.address() as { port: number };
      base = `http://localhost:${addr.port}/api`;
      resolve();
    });
  });
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  resultQueue.length = 0;
  capturedWhereArg = undefined;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postLogin(username: string, password: string) {
  const res = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

// ── Fixture ───────────────────────────────────────────────────────────────────
// The DB stores usernames in lowercase. passwordHash equals the plain password
// so bcrypt mock (compare(a,b) = a===b) works without real hashing.

function makeSarah(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    username: "sarah@example.com",
    name: "Sarah",
    email: "sarah@example.com",
    role: "traveler",
    passwordHash: "correct-password",
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Core normalisation assertions ─────────────────────────────────────────────
// These tests prove that the route passes a lowercase value to the DB lookup,
// regardless of what casing the caller supplied.
//
// eq(usersTable.username, normalised) → ["username", normalised]
// capturedWhereArg therefore equals ["username", "sarah@example.com"].

describe("POST /auth/login — DB lookup uses the normalised (lowercase) username", () => {
  it("passes the lowercase username to the DB when the caller sends uppercase", async () => {
    enqueue([makeSarah()]);

    await postLogin("SARAH@EXAMPLE.COM", "correct-password");

    // The route's eq(usersTable.username, username) call must have normalised the email.
    expect(capturedWhereArg).toEqual(["username", "sarah@example.com"]);
  });

  it("passes the lowercase username to the DB when the caller sends mixed-case", async () => {
    enqueue([makeSarah()]);

    await postLogin("Sarah@Example.Com", "correct-password");

    expect(capturedWhereArg).toEqual(["username", "sarah@example.com"]);
  });

  it("trims leading/trailing spaces before normalising", async () => {
    enqueue([makeSarah()]);

    await postLogin("  SARAH@EXAMPLE.COM  ", "correct-password");

    expect(capturedWhereArg).toEqual(["username", "sarah@example.com"]);
  });

  it("leaves an already-lowercase username unchanged at the DB level", async () => {
    enqueue([makeSarah()]);

    await postLogin("sarah@example.com", "correct-password");

    expect(capturedWhereArg).toEqual(["username", "sarah@example.com"]);
  });
});

// ── HTTP response assertions ──────────────────────────────────────────────────
// Confirm the normalisation produces the expected HTTP outcomes.

describe("POST /auth/login — case-insensitive email returns correct HTTP responses", () => {
  it("returns 200 with a token when the email is fully uppercase", async () => {
    enqueue([makeSarah()]);

    const { status, body } = await postLogin("SARAH@EXAMPLE.COM", "correct-password");

    expect(status).toBe(200);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  it("returns the correct user payload when the email is fully uppercase", async () => {
    enqueue([makeSarah()]);

    const { body } = await postLogin("SARAH@EXAMPLE.COM", "correct-password");

    expect(body.id).toBe(7);
    expect(body.username).toBe("sarah@example.com");
    expect(body.name).toBe("Sarah");
    expect(body.role).toBe("traveler");
  });

  it("returns 200 with a token when the email is mixed-case", async () => {
    enqueue([makeSarah()]);

    const { status, body } = await postLogin("Sarah@Example.Com", "correct-password");

    expect(status).toBe(200);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(0);
  });

  it("returns 200 when the email has surrounding spaces and mixed case", async () => {
    enqueue([makeSarah()]);

    const { status, body } = await postLogin("  SARAH@EXAMPLE.COM  ", "correct-password");

    expect(status).toBe(200);
    expect(typeof body.token).toBe("string");
  });

  it("returns 200 (baseline) when the email is already lowercase", async () => {
    enqueue([makeSarah()]);

    const { status, body } = await postLogin("sarah@example.com", "correct-password");

    expect(status).toBe(200);
    expect(typeof body.token).toBe("string");
  });

  it("returns 401 when the password is wrong even if the email matches after normalisation", async () => {
    enqueue([makeSarah()]);

    const { status } = await postLogin("SARAH@EXAMPLE.COM", "wrong-password");

    expect(status).toBe(401);
  });

  it("returns 401 when the uppercased email is not in the DB", async () => {
    enqueue([]); // no user found

    const { status, body } = await postLogin("NOBODY@EXAMPLE.COM", "any-password");

    expect(status).toBe(401);
    expect(typeof body.error).toBe("string");
  });
});
