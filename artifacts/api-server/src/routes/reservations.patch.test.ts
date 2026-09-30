/**
 * Regression tests: PATCH reservation persists explicit nulls for cleared fields.
 *
 * Bug: renaming a venue (e.g. "Orlando's" → "Bayside") clears the Website URL
 * field in the edit form, but the old URL survived the save. Root cause chain:
 * the form mapped the cleared field to `undefined` → JSON.stringify drops
 * `undefined` keys → the PATCH handler destructures `url` as `undefined` →
 * Drizzle's `.set()` skips `undefined` values → the column keeps its old value.
 *
 * The form now sends explicit `null` for cleared fields. These tests pin the
 * API side of the contract: a `null` in the PATCH body must reach Drizzle's
 * `.set()` as `null` (which writes SQL NULL), not be dropped or converted.
 *
 * Strategy: same lazy-dequeue chainable DB fake as reservations.delete.test.ts.
 * Mount the reservations router on a minimal Express app with a fake session,
 * then drive PATCH requests with Node's built-in fetch.
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

const resultQueue: unknown[] = [];
const updateCalls: { setArgs: unknown; whereArgs: unknown }[] = [];

function enqueue(...items: unknown[]) {
  resultQueue.push(...items);
}

function makeChain(captureSet = false): any {
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
    if (captureSet) updateCalls.push({ setArgs: capturedSet, whereArgs: args });
    return chain;
  };

  return chain;
}

const fakeTable = new Proxy({}, { get: (_t, p) => p });

const mockDb = {
  select: vi.fn(() => makeChain()),
  insert: vi.fn(() => makeChain()),
  update: vi.fn(() => makeChain(/* captureSet = */ true)),
  delete: vi.fn(() => makeChain()),
};

vi.mock("@workspace/db", () => ({
  db: mockDb,
  reservationsTable: fakeTable,
}));

// ── Minimal Express app ───────────────────────────────────────────────────────

async function buildReservationsApp() {
  const { default: reservationsRouter } = await import("./reservations.js");
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = { userId: 1, role: "super_admin" };
    next();
  });
  app.use("/api", reservationsRouter);
  return app;
}

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
  vi.clearAllMocks();
});

const updatedRow = {
  id: 3, tripId: 7, type: "restaurant", title: "Dinner at Bayside",
  venue: "Bayside", address: null, date: "2027-05-12", time: "19:30",
  endTime: null, confirmationCode: null, numberOfPeople: 2, phone: null,
  notes: null, url: null, imageUrl: null, lat: null, lon: null, sortOrder: 0,
};

describe("PATCH /trips/:tripId/reservations/:reservationId — cleared fields", () => {
  it("passes an explicit null url through to the update so the clear persists", async () => {
    enqueue([updatedRow]);
    const res = await fetch(`${base}/trips/7/reservations/3`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: null, venue: "Bayside" }),
    });
    expect(res.status).toBe(200);
    expect(updateCalls).toHaveLength(1);
    const setArgs = updateCalls[0].setArgs as Record<string, unknown>;
    expect("url" in setArgs).toBe(true);
    expect(setArgs.url).toBeNull();
    expect(setArgs.venue).toBe("Bayside");
    const body = (await res.json()) as { url?: string | null };
    expect(body.url).toBeNull();
  });

  it("clears phone, notes, and imageUrl to null as well", async () => {
    enqueue([updatedRow]);
    const res = await fetch(`${base}/trips/7/reservations/3`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: null, notes: null, imageUrl: null }),
    });
    expect(res.status).toBe(200);
    const setArgs = updateCalls[0].setArgs as Record<string, unknown>;
    expect(setArgs.phone).toBeNull();
    expect(setArgs.notes).toBeNull();
    expect(setArgs.imageUrl).toBeNull();
  });

  it("leaves omitted keys as undefined (unchanged) — only explicit null clears", async () => {
    enqueue([updatedRow]);
    const res = await fetch(`${base}/trips/7/reservations/3`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Dinner at Bayside" }),
    });
    expect(res.status).toBe(200);
    const setArgs = updateCalls[0].setArgs as Record<string, unknown>;
    expect(setArgs.title).toBe("Dinner at Bayside");
    expect(setArgs.url).toBeUndefined();
  });
});
