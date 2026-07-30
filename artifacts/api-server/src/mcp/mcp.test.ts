/**
 * MCP endpoint tests.
 *
 * Strategy: identical to the existing expenses test pattern — mock @workspace/db
 * with a chainable fake, mount the MCP router on a minimal Express app, and
 * drive requests with the built-in Node fetch.
 *
 * Covers:
 *  - Unauthenticated request rejection
 *  - Authenticated user can list only their own trips
 *  - Cross-trip access is denied for non-participants
 *  - Trip admin can access the trip
 *  - Itinerary output is sanitized (no confirmation codes)
 *  - Participant output excludes confidential fields (email, passwordHash)
 *  - Expense summary uses the existing minimizeDebts logic
 *  - All tool calls are read-only (no insert/update/delete calls)
 *  - Invalid trip IDs return a safe MCP error
 *  - Dev token is rejected when MCP_DEV_AUTH_ENABLED is not set
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";

// ── Chainable DB mock (same pattern as expenses.routes.test.ts) ───────────────

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
  for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "set", "values", "returning", "groupBy"]) {
    chain[m] = () => chain;
  }
  return chain;
}

const fakeTable = new Proxy({}, { get: (_t, p) => p });

const dbInsertSpy = vi.fn(() => makeChain());
const dbUpdateSpy = vi.fn(() => makeChain());
const dbDeleteSpy = vi.fn(() => makeChain());

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: dbInsertSpy,
    update: dbUpdateSpy,
    delete: dbDeleteSpy,
    transaction: vi.fn(async (fn: (tx: Record<string, unknown>) => Promise<void>) =>
      fn({ update: vi.fn(() => makeChain()) }),
    ),
  },
  tripsTable: fakeTable,
  tripParticipantsTable: fakeTable,
  usersTable: fakeTable,
  itineraryDaysTable: fakeTable,
  flightsTable: fakeTable,
  accommodationsTable: fakeTable,
  activitiesTable: fakeTable,
  packingItemsTable: fakeTable,
  carRentalsTable: fakeTable,
  tripExpensesTable: fakeTable,
  expenseSplitsTable: fakeTable,
  pool: { query: vi.fn(), end: vi.fn() },
}));

// Mock verifyAuthToken so the test does not need a live SESSION_SECRET
vi.mock("../routes/auth", () => ({
  verifyAuthToken: vi.fn((token: string) => {
    if (token === "valid-jwt-alice") return { userId: 1, role: "traveler" };
    if (token === "valid-jwt-admin") return { userId: 99, role: "super_admin" };
    return null;
  }),
  signAuthToken: vi.fn(),
}));

// ── Minimal test Express app ──────────────────────────────────────────────────

async function buildTestApp() {
  const { default: mcpRouter } = await import("./router.js");
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    // Provide a minimal session stub so the MCP auth adapter can inspect it
    // without crashing. Tests authenticate via Bearer token only.
    (req as unknown as { session: Record<string, unknown> }).session = {};
    next();
  });
  app.use(mcpRouter);
  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = await buildTestApp();
  await new Promise<void>(resolve => {
    server = http.createServer(app as Parameters<typeof http.createServer>[1]).listen(0, "127.0.0.1", resolve);
  });
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  resultQueue.length = 0;
  dbInsertSpy.mockClear();
  dbUpdateSpy.mockClear();
  dbDeleteSpy.mockClear();
});

// ── Helper: send an MCP JSON-RPC request ─────────────────────────────────────

interface McpCallOptions {
  method: string;
  params?: Record<string, unknown>;
  token?: string;
}

/**
 * Parse the first JSON object from an SSE-formatted response body.
 * The Streamable HTTP transport returns `text/event-stream` with lines like:
 *   event: message\ndata: {...}\n\n
 */
function parseSseBody(text: string): unknown {
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      try { return JSON.parse(line.slice(5).trim()); } catch { /* keep looking */ }
    }
  }
  return null;
}

async function mcpCall({ method, params = {}, token }: McpCallOptions) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    // The Streamable HTTP transport responds with text/event-stream SSE
    "Accept": "application/json, text/event-stream",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  const res = await fetch(`${baseUrl}/mcp`, { method: "POST", headers, body });

  const ct = res.headers.get("content-type") ?? "";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let responseBody: any = null;
  if (ct.includes("text/event-stream")) {
    responseBody = parseSseBody(await res.text());
  } else {
    responseBody = await res.json().catch(() => null);
  }
  return { status: res.status, body: responseBody };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MCP health endpoint", () => {
  it("GET /mcp/health returns ok with no secrets", async () => {
    const res = await fetch(`${baseUrl}/mcp/health`);
    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;
    expect(data.status).toBe("ok");
    expect(data.server).toBe("wander-group-travel");
    expect(data.version).toBe("0.1.0");
    // Must not expose secrets or sensitive config
    expect(data).not.toHaveProperty("sessionSecret");
    expect(data).not.toHaveProperty("devToken");
    expect(data).not.toHaveProperty("databaseUrl");
  });
});

describe("MCP authentication", () => {
  it("rejects requests with no token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = await res.json() as any;
    expect(data.error).toMatch(/unauthenticated/i);
  });

  it("rejects requests with an invalid/expired token", async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer bad-token-xyz",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects dev token when MCP_DEV_AUTH_ENABLED is not set", async () => {
    const original = process.env.MCP_DEV_AUTH_ENABLED;
    delete process.env.MCP_DEV_AUTH_ENABLED;
    process.env.MCP_DEV_TOKEN = "some-dev-token";
    process.env.MCP_DEV_USER_ID = "1";
    try {
      const res = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer some-dev-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
      expect(res.status).toBe(401);
    } finally {
      if (original !== undefined) process.env.MCP_DEV_AUTH_ENABLED = original;
      else delete process.env.MCP_DEV_AUTH_ENABLED;
      delete process.env.MCP_DEV_TOKEN;
      delete process.env.MCP_DEV_USER_ID;
    }
  });

  it("accepts a valid JWT and lists tools", async () => {
    // validateMcpUserId DB call
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]);

    const { status, body } = await mcpCall({
      method: "tools/list",
      token: "valid-jwt-alice",
    });
    expect(status).toBe(200);
    const tools: Array<{ name: string }> = body.result?.tools ?? [];
    expect(tools.map(t => t.name)).toEqual(
      expect.arrayContaining([
        "list_my_trips",
        "get_trip_overview",
        "get_trip_itinerary",
        "get_trip_participants",
        "get_trip_expense_summary",
      ]),
    );
  });

  it("all tools are annotated readOnlyHint:true, destructiveHint:false", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]);

    const { body } = await mcpCall({ method: "tools/list", token: "valid-jwt-alice" });
    const tools: Array<{ name: string; annotations?: Record<string, unknown> }> = body.result?.tools ?? [];
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });
});

describe("list_my_trips tool", () => {
  it("returns only trips the user participates in", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]);
    // trips joined with participants
    enqueue([
      {
        trip: {
          id: 10, title: "Paris Trip", destination: "Paris",
          startDate: "2026-09-01", endDate: "2026-09-10",
          status: "planning", description: null, coverImage: null,
          adminNotes: null, createdAt: new Date(),
        },
        participant: { isTripAdmin: true },
      },
    ]);
    // batch participant count
    enqueue([{ tripId: 10, count: 3 }]);

    const { status, body } = await mcpCall({
      method: "tools/call",
      params: { name: "list_my_trips", arguments: {} },
      token: "valid-jwt-alice",
    });
    expect(status).toBe(200);
    const trips: Array<Record<string, unknown>> = body.result?.structuredContent?.trips ?? [];
    expect(Array.isArray(trips)).toBe(true);
    expect(trips[0].tripId).toBe(10);
    expect(trips[0].name).toBe("Paris Trip");
    expect(trips[0].participantCount).toBe(3);
    expect(trips[0].isTripAdmin).toBe(true);
  });

  it("super_admin sees all trips without participant filter", async () => {
    enqueue([{ id: 99, name: "Admin", role: "super_admin" }]);
    enqueue([
      {
        id: 5, title: "Any Trip", destination: "Tokyo",
        startDate: "2026-10-01", endDate: "2026-10-10",
        status: "confirmed", description: null, coverImage: null,
        adminNotes: null, createdAt: new Date(),
      },
    ]);
    enqueue([{ tripId: 5, count: 2 }]);

    const { body } = await mcpCall({
      method: "tools/call",
      params: { name: "list_my_trips", arguments: {} },
      token: "valid-jwt-admin",
    });
    const trips: Array<Record<string, unknown>> = body.result?.structuredContent?.trips ?? [];
    expect(trips[0].tripId).toBe(5);
  });
});

describe("get_trip_overview tool", () => {
  it("returns trip overview counts", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]); // validateMcpUserId
    enqueue([{ tripId: 10, userId: 1, isTripAdmin: false }]); // assertTripAccess
    enqueue([{ id: 10, title: "Paris Trip", destination: "Paris", startDate: "2026-09-01", endDate: "2026-09-10", status: "planning", description: null }]); // trip
    enqueue([{ count: 2 }]); // flights
    enqueue([{ count: 1 }]); // accommodations
    enqueue([{ count: 3 }]); // activities
    enqueue([{ count: 4 }]); // participants
    enqueue([{ count: 5 }]); // packing items
    enqueue([{ count: 2 }]); // packing checked
    enqueue([{ count: 6 }]); // expenses

    const { status, body } = await mcpCall({
      method: "tools/call",
      params: { name: "get_trip_overview", arguments: { tripId: 10 } },
      token: "valid-jwt-alice",
    });
    expect(status).toBe(200);
    const sc = body.result?.structuredContent;
    expect(sc.counts.participants).toBe(4);
    expect(sc.counts.flights).toBe(2);
    expect(sc.counts.expenses).toBe(6);
  });

  it("denies access to a trip the user does not belong to", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]); // validateMcpUserId
    enqueue([]); // assertTripAccess — no participant record

    const { body } = await mcpCall({
      method: "tools/call",
      params: { name: "get_trip_overview", arguments: { tripId: 999 } },
      token: "valid-jwt-alice",
    });
    expect(body.result?.content?.[0]?.text).toMatch(/TRIP_ACCESS_DENIED/);
  });

  it("returns safe error for non-existent trip ID", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]); // validateMcpUserId
    enqueue([{ tripId: 10, userId: 1 }]); // access check passes
    enqueue([]); // trip not found

    const { body } = await mcpCall({
      method: "tools/call",
      params: { name: "get_trip_overview", arguments: { tripId: 10 } },
      token: "valid-jwt-alice",
    });
    expect(body.result?.content?.[0]?.text).toMatch(/TRIP_NOT_FOUND/);
  });

  it("trip admin can access the trip", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]);
    enqueue([{ tripId: 10, userId: 1, isTripAdmin: true }]); // admin participant
    enqueue([{ id: 10, title: "Admin Trip", destination: "Rome", startDate: "2026-11-01", endDate: "2026-11-07", status: "confirmed", description: null }]);
    // count queries
    for (let i = 0; i < 7; i++) enqueue([{ count: 0 }]);

    const { status } = await mcpCall({
      method: "tools/call",
      params: { name: "get_trip_overview", arguments: { tripId: 10 } },
      token: "valid-jwt-alice",
    });
    expect(status).toBe(200);
  });
});

describe("get_trip_participants tool", () => {
  it("excludes confidential fields from participant output", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]); // validateMcpUserId
    enqueue([{ tripId: 10, userId: 1 }]); // access check
    enqueue([
      {
        user: { id: 1, name: "Alice", role: "traveler", username: "alice@test.com", email: "alice@test.com", passwordHash: "SHOULD_NOT_APPEAR", createdAt: new Date() },
        participant: { isTripAdmin: true },
      },
      {
        user: { id: 2, name: "Bob", role: "traveler", username: "bob@test.com", email: "bob@test.com", passwordHash: "ALSO_SHOULD_NOT_APPEAR", createdAt: new Date() },
        participant: { isTripAdmin: false },
      },
    ]);

    const { status, body } = await mcpCall({
      method: "tools/call",
      params: { name: "get_trip_participants", arguments: { tripId: 10 } },
      token: "valid-jwt-alice",
    });
    expect(status).toBe(200);
    const parts: Array<Record<string, unknown>> = body.result?.structuredContent?.participants ?? [];
    expect(parts).toHaveLength(2);

    for (const p of parts) {
      expect(p).toHaveProperty("participantId");
      expect(p).toHaveProperty("displayName");
      expect(p).toHaveProperty("role");
      expect(p).toHaveProperty("isTripAdmin");
      // Confidential fields must be absent
      expect(p).not.toHaveProperty("passwordHash");
      expect(p).not.toHaveProperty("email");
      expect(p).not.toHaveProperty("username");
    }
  });
});

describe("get_trip_itinerary tool", () => {
  it("returns itinerary events without confirmation codes", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]);
    enqueue([{ tripId: 10, userId: 1 }]); // access check
    // parallel fetches: itinerary, flights, accommodations, activities, carRentals
    enqueue([{ id: 1, tripId: 10, date: "2026-09-01", title: "Arrive Paris", description: "Landing day", notes: null, startTime: null, endTime: null }]);
    enqueue([{ id: 1, tripId: 10, airline: "AF", flightNumber: "AF001", departureAirport: "JFK", arrivalAirport: "CDG", departureDatetime: "2026-09-01T08:00", notes: null, confirmationCode: "SECRET123" }]);
    enqueue([]); // accommodations
    enqueue([]); // activities
    enqueue([]); // car rentals

    const { status, body } = await mcpCall({
      method: "tools/call",
      params: { name: "get_trip_itinerary", arguments: { tripId: 10 } },
      token: "valid-jwt-alice",
    });
    expect(status).toBe(200);
    const events: unknown[] = body.result?.structuredContent?.events ?? [];
    expect(events.length).toBeGreaterThan(0);
    // Confirmation codes must not appear anywhere in the output
    const json = JSON.stringify(events);
    expect(json).not.toContain("SECRET123");
    expect(json).not.toContain("confirmationCode");
  });

  it("filters events by date when date param is provided", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]);
    enqueue([{ tripId: 10, userId: 1 }]);
    enqueue([
      { id: 1, tripId: 10, date: "2026-09-01", title: "Day 1", description: null, notes: null, startTime: null, endTime: null },
      { id: 2, tripId: 10, date: "2026-09-02", title: "Day 2", description: null, notes: null, startTime: null, endTime: null },
    ]);
    enqueue([]); // flights
    enqueue([]); // accommodations
    enqueue([]); // activities
    enqueue([]); // car rentals

    const { body } = await mcpCall({
      method: "tools/call",
      params: { name: "get_trip_itinerary", arguments: { tripId: 10, date: "2026-09-01" } },
      token: "valid-jwt-alice",
    });
    const events: Array<{ date: string }> = body.result?.structuredContent?.events ?? [];
    expect(events.every(e => e.date === "2026-09-01")).toBe(true);
  });
});

describe("get_trip_expense_summary tool", () => {
  it("returns expense summary using the existing settlement logic", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]); // validateMcpUserId
    enqueue([{ tripId: 10, userId: 1 }]); // access check
    // participants
    enqueue([
      { userId: 1, name: "Alice" },
      { userId: 2, name: "Bob" },
    ]);
    // expenses
    enqueue([{ id: 100, tripId: 10, paidByUserId: 1, amount: "100.00", currency: "USD" }]);
    // splits
    enqueue([
      { expenseId: 100, userId: 1, shareAmount: "50.00", isPaid: true, paidAt: new Date() },
      { expenseId: 100, userId: 2, shareAmount: "50.00", isPaid: false, paidAt: null },
    ]);

    const { status, body } = await mcpCall({
      method: "tools/call",
      params: { name: "get_trip_expense_summary", arguments: { tripId: 10 } },
      token: "valid-jwt-alice",
    });
    expect(status).toBe(200);
    const sc = body.result?.structuredContent;
    expect(sc.totalSpent).toBe(100);
    expect(sc.currency).toBe("USD");
    // Bob owes Alice 50
    expect(sc.settlements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromName: "Bob", toName: "Alice", amount: 50 }),
      ]),
    );
  });

  it("denies cross-trip access in expense summary", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]);
    enqueue([]); // no participant record

    const { body } = await mcpCall({
      method: "tools/call",
      params: { name: "get_trip_expense_summary", arguments: { tripId: 999 } },
      token: "valid-jwt-alice",
    });
    expect(body.result?.content?.[0]?.text).toMatch(/TRIP_ACCESS_DENIED/);
  });
});

describe("read-only guarantee", () => {
  it("tools/call never invokes db.insert, db.update, or db.delete", async () => {
    enqueue([{ id: 1, name: "Alice", role: "traveler" }]);
    enqueue([]); // trips (empty)
    enqueue([]); // participant count

    await mcpCall({
      method: "tools/call",
      params: { name: "list_my_trips", arguments: {} },
      token: "valid-jwt-alice",
    });
    expect(dbInsertSpy).not.toHaveBeenCalled();
    expect(dbUpdateSpy).not.toHaveBeenCalled();
    expect(dbDeleteSpy).not.toHaveBeenCalled();
  });
});
