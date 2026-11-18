/**
 * Claim → participant, route level (§3.2): POST /traveler-setup/:token/submit
 * fires recalcExpenseSplitsForTrip exactly once — when the claim created
 * a NEW trip_participants row — and never on a re-claim.
 *
 * Harness: the outreach router on a minimal Express app, a chainable
 * FIFO @workspace/db mock (agent.intake.eval.test.ts pattern), the real
 * lib/outreach + lib/travelerProfile services, a stubbed mailer, and a
 * mocked ./expenses module whose recalc is a spy (the real recalc's own
 * behavior is covered by the expenses suites; here we assert the HOOK).
 *
 * FIFO choreography for an existing-user submit, in order:
 *   validate token (tokens select) → loadEntry (roster select) →
 *   find user (users select; skipped when the entry is already linked) →
 *   vault upsert (profiles select → insert/update) → link entry (roster
 *   update) → ensure participant (participants select [→ insert]) →
 *   change propagation (roster select; empty = early return) →
 *   recompute (profiles select) → final roster update → consume token.
 */

import http from "node:http";
import express from "express";
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { hashInviteToken } from "../lib/outreachLogic.js";

// ── Chainable FIFO DB mock ───────────────────────────────────────────────────

const dbMock = vi.hoisted(() => {
  const resultQueue: unknown[] = [];
  function enqueue(...items: unknown[]) {
    resultQueue.push(...items);
  }
  function makeChain(): Record<string, unknown> {
    let p: Promise<unknown> | null = null;
    function promise() {
      if (!p) p = Promise.resolve(resultQueue.shift() ?? []);
      return p;
    }
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => promise().then(res, rej),
      catch: (rej: (e: unknown) => unknown) => promise().catch(rej),
      finally: (fin: () => void) => promise().finally(fin),
    };
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "set", "values", "returning", "groupBy", "limit"]) {
      chain[m] = () => chain;
    }
    return chain;
  }
  const fakeTable = new Proxy({}, { get: (_t, p) => p });
  const db: Record<string, unknown> = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  };
  db.transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return { resultQueue, enqueue, fakeTable, db };
});

const { enqueue } = dbMock;

vi.mock("@workspace/db", () => ({
  db: dbMock.db,
  travelerInviteTokensTable: dbMock.fakeTable,
  tripParticipantsTable: dbMock.fakeTable,
  tripRosterEntriesTable: dbMock.fakeTable,
  tripsTable: dbMock.fakeTable,
  usersTable: dbMock.fakeTable,
  travelerProfilesTable: dbMock.fakeTable,
  profileAccessLogTable: dbMock.fakeTable,
  pool: { query: vi.fn(), end: vi.fn() },
}));

vi.mock("../lib/email.js", () => ({
  sendEmail: vi.fn(async () => ({ sent: true })),
  sendPasswordResetEmail: vi.fn(async () => ({ sent: true })),
  sendWelcomeEmail: vi.fn(async () => ({ sent: true })),
}));

const recalcSpy = vi.hoisted(() => vi.fn(async (_tripId: number) => 0));
vi.mock("./expenses", () => ({
  recalcExpenseSplitsForTrip: recalcSpy,
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FUTURE = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

const tokenRow = {
  id: 3,
  rosterEntryId: 11,
  tokenHash: hashInviteToken("raw-token"),
  expiresAt: FUTURE,
  usedAt: null,
  createdAt: new Date(),
};

function entryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    tripId: 7,
    invitedName: "Kurt",
    invitedEmail: "kurt@example.com",
    userId: null,
    status: "setting_up",
    requiredFieldsProfile: ["passport_number"],
    missingFields: ["passport_number"],
    chaseState: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const profileRow = {
  userId: 55,
  legalFirstName: "Kurt",
  legalMiddleName: null,
  legalLastName: "Rao",
  dateOfBirthEnc: null,
  passportNumberEnc: "ciphertext-passport",
  passportIssuingCountry: "US",
  passportExpiry: "2031-05-01",
  nationality: "US",
  phone: null,
  emergencyContactEnc: null,
  profileVersion: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
};

// ── App ───────────────────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

const savedKek = process.env.CREDENTIALS_KEK;

// Explicit timeout: the router's import graph (auth middleware → auth
// routes → api-zod) is heavy, and this VM throttles CPU — the default
// 10s hook budget is not enough on a cold transform cache.
beforeAll(async () => {
  const { default: outreachRouter } = await import("./outreach.js");
  const app = express();
  app.use(express.json());
  app.use(outreachRouter);
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60000);

afterAll(() => {
  server?.close();
  if (savedKek === undefined) delete process.env.CREDENTIALS_KEK;
  else process.env.CREDENTIALS_KEK = savedKek;
});

beforeEach(() => {
  dbMock.resultQueue.length = 0;
  recalcSpy.mockClear();
  // The vault write path encrypts for real in these tests.
  process.env.CREDENTIALS_KEK = crypto.randomBytes(32).toString("hex");
});

async function postSubmit(body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}/traveler-setup/raw-token/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("POST /traveler-setup/:token/submit — claim → recalc hook (§3.2)", () => {
  it("first claim: creates the participant and fires the split recalc exactly once", async () => {
    enqueue([tokenRow]); // validate token
    enqueue([entryRow()]); // loadEntry
    enqueue([{ id: 55, name: "Kurt", email: "kurt@example.com" }]); // find user (exists)
    enqueue([]); // vault upsert: no profile yet
    enqueue([]); // vault insert
    enqueue([]); // link entry (roster update)
    enqueue([]); // ensure participant: none yet
    enqueue([]); // participant insert
    enqueue([]); // change propagation: no in-flight entries
    enqueue([profileRow]); // recompute: profile load
    enqueue([]); // final roster update
    enqueue([]); // consume token

    const { status, body } = await postSubmit({ passportNumber: "XUK1234567" });
    expect(status).toBe(200);
    expect(body?.status).toBe("ready");
    expect(recalcSpy).toHaveBeenCalledTimes(1);
    expect(recalcSpy).toHaveBeenCalledWith(7);
  });

  it("re-claim: an already-linked, already-participant traveler fires NO recalc", async () => {
    enqueue([tokenRow]); // validate token (a fresh token for the same entry)
    enqueue([entryRow({ userId: 55, status: "ready", missingFields: [] })]); // loadEntry — already claimed
    // (no users select: the entry already knows its user)
    enqueue([profileRow]); // vault upsert: profile exists
    enqueue([]); // vault update
    enqueue([]); // link entry (roster update)
    enqueue([{ tripId: 7, userId: 55, isTripAdmin: false }]); // ensure: participant exists
    enqueue([]); // change propagation: nothing in-flight
    enqueue([profileRow]); // recompute: profile load
    enqueue([]); // final roster update
    enqueue([]); // consume token

    const { status, body } = await postSubmit({ passportNumber: "XUK1234567" });
    expect(status).toBe(200);
    expect(body?.status).toBe("ready");
    expect(recalcSpy).not.toHaveBeenCalled();
  });
});
