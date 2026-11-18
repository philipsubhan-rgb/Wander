/**
 * Attempt-the-read tests for the traveler-profile vault
 * (architecture-north-star §3.3, Story 5.2 — the QA charter's
 * release-blocking privacy item).
 *
 * The claim under attack: there is NO request an organizer, a trip
 * admin, or a super_admin can make that returns another traveler's
 * profile contents — because the owner surface keys strictly on the
 * session user, no route takes a userId, and the roster projection
 * never touches the vault tables at all.
 *
 * Harness: lazy-dequeue @workspace/db mock (security.idor pattern) that
 * also records every WHERE argument and every table touched, so the
 * tests assert on the actual queries issued, not just the responses.
 * Real encryption with a test KEK: the traveler's row holds genuine
 * ciphertext for sentinel values, so a leak would be visible.
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { randomBytes } from "node:crypto";

// ── Mock drizzle-orm operators (eq/and return their args for capture) ──────

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  ne: (...args: unknown[]) => args,
  gt: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  desc: (...args: unknown[]) => args,
  asc: (...args: unknown[]) => args,
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
    sql: String(strings[0]),
    values,
  }),
  count: () => "count_placeholder",
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash: async (_pwd: string, _rounds: number) => "hashed-password",
    compare: async (a: string, b: string) => a === b,
  },
}));

vi.mock("../lib/email.js", () => ({
  sendEmail: async () => ({ sent: true }),
  sendPasswordResetEmail: async () => ({ sent: true }),
  sendWelcomeEmail: async () => ({ sent: true }),
}));

// ── Lazy-dequeue DB mock with query capture ─────────────────────────────────

const resultQueue: unknown[] = [];
const whereCalls: unknown[][] = [];
const tablesTouched: string[] = [];

function tableName(t: unknown): string {
  return (t as { __tableName?: string })?.__tableName ?? "unknown";
}

function makeChain(): any {
  let p: Promise<unknown> | null = null;
  function promise() {
    if (!p) p = Promise.resolve(resultQueue.shift() ?? []);
    return p;
  }
  const chain: any = {
    then: (res: any, rej: any) => promise().then(res, rej),
    catch: (rej: any) => promise().catch(rej),
    finally: (fin: any) => promise().finally(fin),
  };
  chain.from = (t: unknown) => {
    tablesTouched.push(tableName(t));
    return chain;
  };
  for (const m of ["innerJoin", "leftJoin", "orderBy", "limit", "set", "values", "returning", "onConflictDoNothing"]) {
    chain[m] = () => chain;
  }
  chain.where = (...args: unknown[]) => {
    whereCalls.push(args);
    return chain;
  };
  return chain;
}

function mkTable(name: string): unknown {
  const base = { __tableName: name };
  return new Proxy(base, {
    get: (t, p) => (p === "__tableName" ? name : (p as string)),
  });
}

const dbMock: any = {
  select: vi.fn(() => makeChain()),
  insert: vi.fn((t: unknown) => {
    tablesTouched.push(tableName(t));
    return makeChain();
  }),
  update: vi.fn((t: unknown) => {
    tablesTouched.push(tableName(t));
    return makeChain();
  }),
  delete: vi.fn((t: unknown) => {
    tablesTouched.push(tableName(t));
    return makeChain();
  }),
  transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(dbMock)),
};

vi.mock("@workspace/db", () => ({
  db: dbMock,
  pool: { query: vi.fn(), end: vi.fn() },
  usersTable: mkTable("users"),
  tripsTable: mkTable("trips"),
  tripParticipantsTable: mkTable("trip_participants"),
  tripRosterEntriesTable: mkTable("trip_roster_entries"),
  travelerInviteTokensTable: mkTable("traveler_invite_tokens"),
  travelerProfilesTable: mkTable("traveler_profiles"),
  profileAccessLogTable: mkTable("profile_access_log"),
  passwordResetTokensTable: mkTable("password_reset_tokens"),
}));

import { encryptProfileField } from "../lib/profileCrypto.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const PASSPORT = "XUK1234567";
const DOB = "1990-04-12";
const EC_PHONE = "+1-555-0199";

const ORGANIZER = { userId: 42, role: "traveler" }; // trip admin of trip 7
const TRAVELER = { userId: 77, role: "traveler" };
const SUPER_ADMIN = { userId: 1, role: "super_admin" };

let currentSession: { userId: number; role: string } | null = null;
let travelerProfileRow: Record<string, unknown>;

function queue(...results: unknown[]): void {
  resultQueue.push(...results);
}

/** Every numeric value appearing in any captured WHERE argument. */
function whereNumbers(): number[] {
  const nums: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === "number") nums.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
  };
  whereCalls.forEach(walk);
  return nums;
}

// ── App ─────────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl = "";

beforeAll(async () => {
  process.env.CREDENTIALS_KEK = randomBytes(32).toString("hex");
  travelerProfileRow = {
    userId: 77,
    legalFirstName: "Kurt",
    legalMiddleName: null,
    legalLastName: "Rao",
    dateOfBirthEnc: encryptProfileField("date_of_birth", DOB),
    passportNumberEnc: encryptProfileField("passport_number", PASSPORT),
    passportIssuingCountry: "US",
    passportExpiry: "2031-05-01",
    nationality: "US",
    phone: "+1-555-0100",
    emergencyContactEnc: encryptProfileField(
      "emergency_contact",
      JSON.stringify({ name: "Mom", relationship: "mother", phone: EC_PHONE }),
    ),
    profileVersion: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const [{ default: profilesRouter }, { default: outreachRouter }] = await Promise.all([
    import("./profiles.js"),
    import("./outreach.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    if (currentSession) req.session = { ...currentSession };
    next();
  });
  app.use("/api", profilesRouter);
  app.use("/api", outreachRouter);
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  resultQueue.length = 0;
  whereCalls.length = 0;
  tablesTouched.length = 0;
  currentSession = null;
});

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function put(path: string, payload: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

// ── The owner door works ────────────────────────────────────────────────────

describe("owner surface", () => {
  it("the owner reads their own decrypted profile (and the read is keyed to their session id)", async () => {
    currentSession = TRAVELER;
    queue([travelerProfileRow], []); // profile select, access-log insert
    const { status, body } = await get("/api/profile/me");
    expect(status).toBe(200);
    expect(body.profile.passportNumber).toBe(PASSPORT);
    expect(body.profile.dateOfBirth).toBe(DOB);
    expect(body.profile.emergencyContact.phone).toBe(EC_PHONE);
    expect(whereNumbers()).toContain(77);
    expect(tablesTouched).toContain("profile_access_log"); // the view was logged
  });

  it("the owner updates only their own profile", async () => {
    currentSession = TRAVELER;
    queue([travelerProfileRow], [], []); // select, update, propagation scan (none)
    const { status, body } = await put("/api/profile/me", { phone: "+1-555-9999" });
    expect(status).toBe(200);
    expect(body.profileVersion).toBe(2);
    expect(whereNumbers()).not.toContain(42);
    expect(whereNumbers()).not.toContain(1);
  });

  it("the owner's access log shows field names and purposes — never values", async () => {
    currentSession = TRAVELER;
    queue([
      {
        id: 5,
        profileUserId: 77,
        accessorKind: "agent",
        accessorUserId: null,
        purpose: "booking_execution",
        fieldsAccessed: ["passport_number"],
        bookingId: 900,
        createdAt: new Date(),
      },
    ]);
    const { status, body } = await get("/api/profile/me/access-log");
    expect(status).toBe(200);
    expect(body.accessLog).toHaveLength(1);
    expect(body.accessLog[0].fieldsAccessed).toEqual(["passport_number"]);
    const json = JSON.stringify(body);
    expect(json).not.toContain(PASSPORT);
    expect(json).not.toContain(DOB);
    expect(whereNumbers()).toContain(77);
  });
});

// ── Attempt-the-read: organizer / trip admin / super_admin ─────────────────

describe("attempt-the-read (Story 5.2 / §3.3)", () => {
  it("an organizer asking for 'their' profile gets their OWN (empty) one — the vault lookup never names the traveler", async () => {
    currentSession = ORGANIZER;
    queue([]); // the organizer has no profile row
    const { status, body } = await get("/api/profile/me");
    expect(status).toBe(200);
    expect(body.profile).toBeNull();
    expect(whereNumbers()).toContain(42);
    expect(whereNumbers()).not.toContain(77);
    expect(JSON.stringify(body)).not.toContain(PASSPORT);
  });

  it("super_admin gets NO bypass: their profile lookup is keyed to the super_admin's own id", async () => {
    currentSession = SUPER_ADMIN;
    queue([]);
    const { status, body } = await get("/api/profile/me");
    expect(status).toBe(200);
    expect(body.profile).toBeNull();
    expect(whereNumbers()).toContain(1);
    expect(whereNumbers()).not.toContain(77);
  });

  it("super_admin cannot read the traveler's access log either — only their own (empty) one", async () => {
    currentSession = SUPER_ADMIN;
    queue([]);
    const { status, body } = await get("/api/profile/me/access-log");
    expect(status).toBe(200);
    expect(body.accessLog).toEqual([]);
    expect(whereNumbers()).toContain(1);
    expect(whereNumbers()).not.toContain(77);
  });

  it("there is no route addressed by another user's id", async () => {
    currentSession = SUPER_ADMIN;
    for (const path of ["/api/profile/77", "/api/profiles/77", "/api/users/77/profile"]) {
      const { status } = await get(path);
      expect(status).toBe(404);
    }
    expect(tablesTouched).not.toContain("traveler_profiles");
  });

  it("the organizer roster projection never touches the vault tables and carries names, not values", async () => {
    currentSession = ORGANIZER;
    queue(
      [{ tripId: 7, userId: 42, isTripAdmin: true }], // participant check
      [
        {
          id: 11,
          tripId: 7,
          invitedName: "Kurt",
          invitedEmail: "kurt@example.com",
          userId: 77,
          status: "setting_up",
          requiredFieldsProfile: ["passport_number"],
          missingFields: ["passport_number"],
          chaseState: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    );
    const { status, body } = await get("/api/trips/7/roster");
    expect(status).toBe(200);
    expect(body.roster[0].missingFields).toEqual(["passport_number"]); // NAMES are fine
    expect(tablesTouched).not.toContain("traveler_profiles");
    expect(tablesTouched).not.toContain("profile_access_log");
    const json = JSON.stringify(body);
    expect(json).not.toContain(PASSPORT);
    expect(json).not.toContain(DOB);
    expect(json).not.toContain(EC_PHONE);
  });

  it("unauthenticated requests are rejected before any vault access", async () => {
    currentSession = null;
    const me = await get("/api/profile/me");
    expect(me.status).toBe(401);
    const log = await get("/api/profile/me/access-log");
    expect(log.status).toBe(401);
    expect(tablesTouched).not.toContain("traveler_profiles");
    expect(tablesTouched).not.toContain("profile_access_log");
  });
});
