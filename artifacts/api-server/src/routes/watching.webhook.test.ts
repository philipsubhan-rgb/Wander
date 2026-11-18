/**
 * FlightAware alert webhook — route tests over a real HTTP server
 * (agent.eval pattern), with the recording @workspace/db mock. Covers
 * the shared-secret provenance check (header + query forms, and the
 * unconfigured mode), payload validation, and that a well-formed
 * delivery for an unwatched flight is acknowledged without effects.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import http from "node:http";

const store = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name });
  const ops: Array<{ op: string; table: string }> = [];
  const selectQueues: Record<string, unknown[][]> = {};

  function makeChain(kind: string, tableName?: string): Record<string, unknown> {
    const ctx = { table: tableName };
    const resolve = (): Promise<unknown> => {
      if (kind === "select") return Promise.resolve(selectQueues[ctx.table ?? ""]?.shift() ?? []);
      return Promise.resolve([]);
    };
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolve().then(res, rej),
      catch: (rej: (e: unknown) => unknown) => resolve().catch(rej),
      finally: (fin: () => void) => resolve().finally(fin),
    };
    chain.from = (t: { __table: string }) => {
      ctx.table = t.__table;
      return chain;
    };
    for (const m of ["where", "orderBy", "limit", "returning"]) {
      chain[m] = () => chain;
    }
    chain.values = () => {
      ops.push({ op: "insert", table: ctx.table ?? "" });
      return chain;
    };
    chain.set = () => {
      ops.push({ op: "update", table: ctx.table ?? "" });
      return chain;
    };
    return chain;
  }

  const db = {
    select: vi.fn(() => makeChain("select")),
    insert: vi.fn((t: { __table: string }) => makeChain("insert", t.__table)),
    update: vi.fn((t: { __table: string }) => makeChain("update", t.__table)),
    delete: vi.fn((t: { __table: string }) => makeChain("delete", t.__table)),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { table, ops, selectQueues, db };
});

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  desc: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
}));

vi.mock("@workspace/db", () => ({
  db: store.db,
  flightsTable: store.table("flights"),
  tripsTable: store.table("trips"),
  flightWatchesTable: store.table("flight_watches"),
  advisoriesTable: store.table("advisories"),
  tripParticipantsTable: store.table("trip_participants"),
  usersTable: store.table("users"),
  accommodationsTable: store.table("accommodations"),
  activitiesTable: store.table("activities"),
  itineraryDaysTable: store.table("itinerary_days"),
  carRentalsTable: store.table("car_rentals"),
  reservationsTable: store.table("reservations"),
}));

vi.mock("../lib/email.js", () => ({
  sendEmail: vi.fn(async () => ({ sent: true })),
}));

import watchingRouter from "./watching.js";

let server: http.Server;
let baseUrl: string;

const ORIGINAL_SECRET = process.env.FLIGHTAWARE_WEBHOOK_SECRET;

const VALID_PAYLOAD = {
  alert_id: 42,
  event_code: "change",
  flight: {
    ident: "UA30",
    fa_flight_id: "UAL30-1",
    scheduled_out: "2026-09-23T17:00:00-04:00",
    estimated_in: "2026-09-24T07:10:00+02:00",
    scheduled_in: "2026-09-24T07:10:00+02:00",
  },
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(watchingRouter);
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  if (ORIGINAL_SECRET === undefined) delete process.env.FLIGHTAWARE_WEBHOOK_SECRET;
  else process.env.FLIGHTAWARE_WEBHOOK_SECRET = ORIGINAL_SECRET;
});

beforeEach(() => {
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  process.env.FLIGHTAWARE_WEBHOOK_SECRET = "test-secret";
  // Every watch lookup misses: deliveries are acknowledged as unmatched.
  store.selectQueues["flight_watches"] = [[], [], [], [], [], []];
});

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

describe("POST /webhooks/flightaware", () => {
  it("rejects a delivery without the shared secret when one is configured", async () => {
    const { status } = await post("/webhooks/flightaware", VALID_PAYLOAD);
    expect(status).toBe(401);
    const wrong = await post("/webhooks/flightaware", VALID_PAYLOAD, {
      "x-wander-alert-secret": "not-the-secret",
    });
    expect(wrong.status).toBe(401);
  });

  it("accepts the secret via header and via query parameter", async () => {
    const viaHeader = await post("/webhooks/flightaware", VALID_PAYLOAD, {
      "x-wander-alert-secret": "test-secret",
    });
    expect(viaHeader.status).toBe(200);
    expect(viaHeader.body).toMatchObject({ received: true, outcome: "unmatched" });

    const viaQuery = await post("/webhooks/flightaware?secret=test-secret", VALID_PAYLOAD);
    expect(viaQuery.status).toBe(200);
    expect(viaQuery.body).toMatchObject({ received: true });
  });

  it("rejects a malformed payload even with a valid secret", async () => {
    const { status } = await post(
      "/webhooks/flightaware",
      { flight: 42 },
      { "x-wander-alert-secret": "test-secret" },
    );
    expect(status).toBe(400);
  });

  it("accepts deliveries when no secret is configured (shape + watch match still enforced)", async () => {
    delete process.env.FLIGHTAWARE_WEBHOOK_SECRET;
    const { status, body } = await post("/webhooks/flightaware", VALID_PAYLOAD);
    expect(status).toBe(200);
    expect(body).toMatchObject({ received: true, outcome: "unmatched" });
    expect(store.ops.filter((o) => o.op === "insert")).toHaveLength(0);
  });
});
