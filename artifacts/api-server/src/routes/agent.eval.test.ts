/**
 * Marco agent — Stage 1 eval suite.
 *
 * EVAL BOUNDARY (important): these evals run against a STUBBED model, so they
 * cannot test whether the real model honestly refuses to invent bookings.
 * True model-honesty testing (does Muse Spark actually say "no such booking"
 * instead of hallucinating one?) requires a live model call and is Phil's
 * Stage 1 live test. What this suite DOES assert is the guardrail machinery
 * around the model:
 *   - tool results for empty state are unambiguous ("No reservations …",
 *     nothing to hallucinate from), and
 *   - the system prompt sent to the model carries the anti-hallucination
 *     directive ("Never invent bookings, times, confirmation codes, or
 *     prices").
 * If the model ever ignores those, the failure is in the model call — not in
 * the plumbing this file covers.
 *
 * Strategy: chainable @workspace/db mock (mcp.test.ts pattern), the agent
 * router mounted on a minimal Express app, requests driven with Node fetch.
 * globalThis.fetch is stubbed per test: the Meta Model API
 * (https://api.ai.meta.com/v1/chat/completions) serves scripted model
 * responses from a queue, the Google Places endpoint serves fixture payloads,
 * and everything else passes through to the real fetch.
 *
 * Fixture: a Munich-flavored guys' trip (id 7) with 2 restaurant reservations
 * (one with a confirmation code), 1 flight, 1 hotel stay, 2 activities, and
 * 1 itinerary day; trip 8 has no reservations at all. User 42 participates in
 * trip 7 only; user 99 participates in nothing.
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { getToolDefinition, type ToolContext, type AgentToolResult } from "../lib/agentTools";
import { AGENT_RESEARCH_TOOLS } from "../lib/agentResearch";

// ── Chainable DB mock (same pattern as mcp.test.ts) ──────────────────────────
// NOTE: the mock factory must be self-contained because this file imports
// ../lib/agentTools statically, which triggers the factory during module
// load — before plain top-level consts are initialized. vi.hoisted runs
// before any mock factory, so the shared state lives there.

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
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "set", "values", "returning", "groupBy"]) {
      chain[m] = () => chain;
    }
    return chain;
  }

  const fakeTable = new Proxy({}, { get: (_t, p) => p });

  return { resultQueue, enqueue, makeChain, fakeTable };
});

const { enqueue } = dbMock;

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => dbMock.makeChain()),
    insert: vi.fn(() => dbMock.makeChain()),
    update: vi.fn(() => dbMock.makeChain()),
    delete: vi.fn(() => dbMock.makeChain()),
  },
  tripsTable: dbMock.fakeTable,
  tripParticipantsTable: dbMock.fakeTable,
  itineraryDaysTable: dbMock.fakeTable,
  reservationsTable: dbMock.fakeTable,
  flightsTable: dbMock.fakeTable,
  accommodationsTable: dbMock.fakeTable,
  activitiesTable: dbMock.fakeTable,
  carRentalsTable: dbMock.fakeTable,
  usersTable: dbMock.fakeTable,
  pool: { query: vi.fn(), end: vi.fn() },
}));

// Avoid loading the real auth router (it pulls in nodemailer via lib/email).
vi.mock("../routes/auth", () => ({
  verifyAuthToken: vi.fn(() => null),
  signAuthToken: vi.fn(() => "test-token"),
}));

// ── Fixtures: Munich guys' trip (id 7) and the empty trip (id 8) ──────────────

const trip7Row = {
  id: 7,
  title: "Munich Guys' Trip",
  destination: "Munich, Germany",
  startDate: "2026-09-24",
  endDate: "2026-09-27",
  status: "confirmed",
  description: "Oktoberfest long weekend with the guys",
};

const trip8Row = {
  id: 8,
  title: "Empty Test Trip",
  destination: "Nowhere",
  startDate: "2026-10-01",
  endDate: "2026-10-03",
  status: "planning",
  description: null,
};

const itineraryDays7 = [
  {
    id: 101, tripId: 7, date: "2026-09-25", title: "Oktoberfest Friday",
    description: "Hofbräu Festzelt evening with the group", notes: null,
    startTime: null, endTime: null,
  },
];

const reservations7 = [
  {
    id: 201, tripId: 7, type: "restaurant", title: "Dinner at Schneider Bräuhaus",
    venue: "Schneider Bräuhaus", address: "Tal 7, 80331 München",
    date: "2026-09-25", time: "19:30", endTime: "21:30",
    confirmationCode: "125113", numberOfPeople: 5,
    notes: "Table under Philip S.", imageUrl: null, sortOrder: 0,
  },
  {
    id: 202, tripId: 7, type: "restaurant", title: "Lunch at Augustiner-Keller",
    venue: "Augustiner-Keller", address: "Arnulfstraße 52, 80335 München",
    date: "2026-09-25", time: "13:45", endTime: null,
    confirmationCode: null, numberOfPeople: 4,
    notes: "Walk-in", imageUrl: null, sortOrder: 1,
  },
];

const flights7 = [
  {
    id: 301, tripId: 7, airline: "United", flightNumber: "UA 30",
    departureAirport: "EWR", arrivalAirport: "MUC",
    departureDatetime: "2026-09-23T17:00", arrivalDatetime: "2026-09-24T07:10",
    confirmationCode: "JQZZ2H", notes: null, departureTimezone: null,
  },
];

const accommodations7 = [
  {
    id: 401, tripId: 7, name: "The Westin Grand Munich",
    address: "Arabellastrasse 6, 81925 München",
    checkIn: "2026-09-24", checkOut: "2026-09-28",
    confirmationCode: "WGM-8841", notes: null, imageUrl: null,
  },
];

const activities7 = [
  {
    id: 501, tripId: 7, date: "2026-09-24", time: "15:00",
    title: "BMW Welt & Museum", location: "Am Olympiapark 1, München",
    description: "Factory tour via BMW contact", sortOrder: 0,
  },
  {
    id: 502, tripId: 7, date: "2026-09-25", time: "10:00",
    title: "Marienplatz walking tour", location: "Marienplatz, München",
    description: null, sortOrder: 1,
  },
];

const carRentals7: unknown[] = [];

/**
 * DB hits before the agent loop for a route-level chat on trip 7:
 *   1. trip-exists check
 *   2. route-level assertTripAccess
 *   3-9. loadTripSnapshot's 7 parallel selects
 *      (trips, itinerary, reservations, flights, accommodations, activities, carRentals)
 *   10-15. buildTimelineEvents' 6 parallel selects
 *      (flights, accommodations, activities, itinerary, carRentals, reservations)
 */
function enqueueTrip7RouteContext() {
  enqueue([{ id: 7 }]);
  enqueue([{ tripId: 7, userId: 42 }]);
  enqueue([trip7Row]);
  enqueue(itineraryDays7);
  enqueue(reservations7);
  enqueue(flights7);
  enqueue(accommodations7);
  enqueue(activities7);
  enqueue(carRentals7);
  enqueue(flights7);
  enqueue(accommodations7);
  enqueue(activities7);
  enqueue(itineraryDays7);
  enqueue(carRentals7);
  enqueue(reservations7);
}

/** Same pre-loop shape for trip 8 (all empty tables). Super-admin sessions skip the access shifts. */
function enqueueTrip8RouteContext() {
  enqueue([{ id: 8 }]);
  enqueue([trip8Row]);
  for (let i = 0; i < 6; i++) enqueue([]);
  for (let i = 0; i < 6; i++) enqueue([]);
}

/** DB hits for one tool call inside the agent loop: route re-assert + tool assert + the tool's query. */
function enqueueLoopToolCall(queryRows: unknown[]) {
  enqueue([{ tripId: 7, userId: 42 }]);
  enqueue([{ tripId: 7, userId: 42 }]);
  enqueue(queryRows);
}

/** buildTimelineEvents' 6 selects in Promise.all order. */
function enqueueTimeline(trip: {
  flights: unknown[]; accommodations: unknown[]; activities: unknown[];
  itinerary: unknown[]; carRentals: unknown[]; reservations: unknown[];
}) {
  enqueue(trip.flights);
  enqueue(trip.accommodations);
  enqueue(trip.activities);
  enqueue(trip.itinerary);
  enqueue(trip.carRentals);
  enqueue(trip.reservations);
}

// ── Scripted fetch: model API + Places API, passthrough otherwise ─────────────

interface ModelApiMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface ModelRequestBody {
  model: string;
  messages: ModelApiMessage[];
  tools: unknown[];
}

/** Scripted chat-completions payloads, consumed one per model API call. */
const modelScript: unknown[] = [];
/** Request bodies actually sent to the model API (for prompt/tool-flow assertions). */
const modelRequests: ModelRequestBody[] = [];
/** Places API calls (headers + body), for key-usage assertions. */
const placesCalls: Array<{ headers: Record<string, string>; body: unknown }> = [];
/** Fixture Places payload served to research tools. */
let placesFixture: unknown = { places: [] };

function toolCallPayload(name: string, args: Record<string, unknown>, id = "call_1"): unknown {
  return {
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
  };
}

function finalModelPayload(text: string): unknown {
  return { choices: [{ message: { content: text, tool_calls: [] } }] };
}

const realFetch = globalThis.fetch.bind(globalThis);

async function scriptedFetch(input: string | { url: string }, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.url;
  if (url === "https://api.ai.meta.com/v1/chat/completions") {
    const payload = modelScript.length > 0 ? modelScript.shift() : finalModelPayload("model script exhausted");
    modelRequests.push(JSON.parse(String(init?.body ?? "{}")) as ModelRequestBody);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }
  if (url === "https://places.googleapis.com/v1/places:searchText") {
    placesCalls.push({
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return {
      ok: true,
      status: 200,
      json: async () => placesFixture,
      text: async () => JSON.stringify(placesFixture),
    } as unknown as Response;
  }
  // Only string URLs reach the passthrough in this suite (route code and the
  // test driver both fetch with plain URL strings).
  return realFetch(input as string, init);
}

// ── Test app & session control ────────────────────────────────────────────────

let currentSession: { userId: number; role: string } | null = { userId: 42, role: "traveler" };
let server: http.Server;
let baseUrl: string;

const ORIG_SPARK_KEY = process.env.MUSE_SPARK_API_KEY;
const ORIG_PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY;

beforeAll(async () => {
  vi.stubGlobal("fetch", scriptedFetch);
  const { default: agentRouter } = await import("./agent.js");
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    if (currentSession) {
      (req as unknown as { session: unknown }).session = currentSession;
    }
    next();
  });
  app.use(agentRouter);
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => {
  server.close();
  vi.unstubAllGlobals();
  if (ORIG_SPARK_KEY === undefined) delete process.env.MUSE_SPARK_API_KEY;
  else process.env.MUSE_SPARK_API_KEY = ORIG_SPARK_KEY;
  if (ORIG_PLACES_KEY === undefined) delete process.env.GOOGLE_PLACES_API_KEY;
  else process.env.GOOGLE_PLACES_API_KEY = ORIG_PLACES_KEY;
});

beforeEach(() => {
  dbMock.resultQueue.length = 0;
  modelScript.length = 0;
  modelRequests.length = 0;
  placesCalls.length = 0;
  placesFixture = { places: [] };
  currentSession = { userId: 42, role: "traveler" };
  process.env.MUSE_SPARK_API_KEY = "test-spark-key";
  delete process.env.GOOGLE_PLACES_API_KEY;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function postChat(body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const CTX_42: ToolContext = { userId: 42, role: "traveler" };

/** Invoke a registered agent tool directly (bypasses the model loop) for focused tool evals. */
async function runTool(name: string, args: Record<string, unknown>): Promise<AgentToolResult> {
  const def = getToolDefinition(name) ?? AGENT_RESEARCH_TOOLS.find((t) => t.name === name);
  if (!def) throw new Error(`unknown tool ${name}`);
  return def.run(CTX_42, args as never);
}

function enqueueAccess() {
  enqueue([{ tripId: 7, userId: 42 }]);
}

// ── Evals ─────────────────────────────────────────────────────────────────────

describe("1. reservation lookup — tool loop plumbing", () => {
  it("executes get_reservations and its result reaches the model", async () => {
    enqueueTrip7RouteContext();
    enqueueLoopToolCall(reservations7);
    modelScript.push(
      toolCallPayload("get_reservations", { tripId: 7 }),
      // Scripted final answer: the model only names these venues because the
      // tool result carried them (see the tool-message assertion below).
      finalModelPayload(
        "Your dinner reservations: Schneider Bräuhaus on Sep 25 at 7:30 PM (conf 125113), " +
          "and Augustiner-Keller on Sep 25 at 1:45 PM.",
      ),
    );

    const { status, body } = await postChat({
      agentId: "muse-spark",
      tripId: 7,
      messages: [{ role: "user", content: "what are my dinner reservations?" }],
    });

    expect(status).toBe(200);
    expect(body?.mock).toBe(false);
    expect(String(body?.reply)).toContain("Schneider Bräuhaus");
    expect(String(body?.reply)).toContain("Augustiner-Keller");

    // The real proof of plumbing: the second model request carries the tool
    // result (a `tool` message) with the fixture data, which is what a live
    // model would read before composing its answer.
    expect(modelRequests).toHaveLength(2);
    const toolMessages = modelRequests[1].messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toContain("Schneider Bräuhaus");
    expect(toolMessages[0].content).toContain("125113");
    expect(toolMessages[0].content).toContain("Augustiner-Keller");
  });
});

describe("2. adversarial — nonexistent booking", () => {
  it("returns an unambiguous empty result and the prompt forbids invention", async () => {
    // Super-admin session: the only eval that exercises the super_admin
    // bypass, needed because user 42 is not a participant of trip 8.
    currentSession = { userId: 42, role: "super_admin" };
    enqueueTrip8RouteContext();
    // No access shifts (super_admin bypass); the tool's single select returns [].
    enqueue([]);
    modelScript.push(
      toolCallPayload("get_reservations", { tripId: 8 }),
      finalModelPayload("You have no dinner reservations on this trip — nothing is booked."),
    );

    const { status, body } = await postChat({
      agentId: "muse-spark",
      tripId: 8,
      messages: [{ role: "user", content: "what are my dinner reservations?" }],
    });

    expect(status).toBe(200);

    // The tool result the model saw must be unambiguous: plain "no
    // reservations", no venue names or codes to hallucinate from.
    expect(modelRequests).toHaveLength(2);
    const toolMessages = modelRequests[1].messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toContain("No reservations for trip 8.");
    expect(toolMessages[0].content).not.toContain("Schneider Bräuhaus");
    expect(toolMessages[0].content).not.toMatch(/conf \w+/);

    // Guardrail: the system prompt handed to the model forbids inventing bookings.
    const systemContent = modelRequests[0].messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(systemContent).toContain("Never invent bookings, times, confirmation codes, or prices.");
  });
});

describe("3. check_schedule_conflict — overlap found", () => {
  it("names the overlapping reservation", async () => {
    enqueueAccess();
    enqueueTimeline({
      flights: flights7, accommodations: accommodations7, activities: activities7,
      itinerary: itineraryDays7, carRentals: carRentals7, reservations: reservations7,
    });

    const result = await runTool("check_schedule_conflict", {
      tripId: 7,
      date: "2026-09-25",
      startTime: "19:00",
      endTime: "21:30",
      title: "Dinner with friends",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("Schneider Bräuhaus");
    expect(result.text).toMatch(/overlap/i);
  });
});

describe("4. check_schedule_conflict — no overlap", () => {
  it("reports the window is clear", async () => {
    enqueueAccess();
    // 2026-09-26 has no fixture events at all.
    enqueueTimeline({
      flights: [], accommodations: [], activities: [],
      itinerary: [], carRentals: [], reservations: [],
    });

    const result = await runTool("check_schedule_conflict", {
      tripId: 7,
      date: "2026-09-26",
      startTime: "19:00",
      endTime: "21:30",
      title: "Quiet dinner",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/no conflicts/i);
  });
});

describe("5. flights and stays detail", () => {
  it("get_flights returns times and confirmation codes", async () => {
    enqueueAccess();
    enqueue(flights7);

    const result = await runTool("get_flights", { tripId: 7 });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("UA 30");
    expect(result.text).toContain("2026-09-23T17:00");
    expect(result.text).toContain("2026-09-24T07:10");
    expect(result.text).toContain("JQZZ2H");
  });

  it("get_stays returns dates and confirmation codes", async () => {
    enqueueAccess();
    enqueue(accommodations7);

    const result = await runTool("get_stays", { tripId: 7 });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("The Westin Grand Munich");
    expect(result.text).toContain("2026-09-24");
    expect(result.text).toContain("2026-09-28");
    expect(result.text).toContain("WGM-8841");
  });
});

describe("6. itinerary merge", () => {
  it("get_itinerary returns events sorted by date/time including reservations", async () => {
    enqueueAccess();
    enqueueTimeline({
      flights: flights7, accommodations: accommodations7, activities: activities7,
      itinerary: itineraryDays7, carRentals: carRentals7, reservations: reservations7,
    });

    const result = await runTool("get_itinerary", { tripId: 7 });

    expect(result.ok).toBe(true);
    const text = result.text;
    // Reservations are merged in, with confirmation codes.
    expect(text).toContain("Schneider Bräuhaus");
    expect(text).toContain("125113");
    expect(text).toContain("UA 30");
    // Chronological order: flight (Sep 23) < check-in (Sep 24) <
    // Augustiner-Keller 13:45 < Schneider Bräuhaus 19:30 (both Sep 25).
    const idx = (s: string) => text.indexOf(s);
    expect(idx("UA 30")).toBeGreaterThanOrEqual(0);
    expect(idx("UA 30")).toBeLessThan(idx("Check-in: The Westin Grand Munich"));
    expect(idx("Check-in: The Westin Grand Munich")).toBeLessThan(idx("Augustiner-Keller"));
    expect(idx("Augustiner-Keller")).toBeLessThan(idx("Schneider Bräuhaus"));
  });
});

describe("7. research graceful degradation", () => {
  it("search_restaurants returns ok:false with an unavailable message when the key is unset", async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;

    const result = await runTool("search_restaurants", {
      location: "Munich, Germany",
      cuisine: "Bavarian",
    });

    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/unavailable/i);
    // No throw, no HTTP call, and no key-shaped value leaks into the output.
    expect(placesCalls).toHaveLength(0);
    expect(result.text).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
  });
});

describe("8. research parsing", () => {
  it("search_restaurants returns names, ratings, and addresses from the Places payload", async () => {
    process.env.GOOGLE_PLACES_API_KEY = "test-places-key-123";
    placesFixture = {
      places: [
        {
          id: "places/p1",
          displayName: { text: "Wirtshaus in der Au" },
          formattedAddress: "Lilienstraße 51, 81669 München",
          rating: 4.6,
          userRatingCount: 3210,
          priceLevel: "PRICE_LEVEL_MODERATE",
        },
        {
          id: "places/p2",
          displayName: { text: "Augustiner-Keller" },
          formattedAddress: "Arnulfstraße 52, 80335 München",
          rating: 4.5,
          userRatingCount: 18760,
          priceLevel: "PRICE_LEVEL_INEXPENSIVE",
        },
      ],
    };

    const result = await runTool("search_restaurants", {
      location: "Munich, Germany",
      cuisine: "Bavarian",
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("Wirtshaus in der Au");
    expect(result.text).toContain("4.6");
    expect(result.text).toContain("3210");
    expect(result.text).toContain("Lilienstraße 51, 81669 München");
    expect(result.text).toContain("Augustiner-Keller");
    expect(result.text).toContain("Arnulfstraße 52, 80335 München");
    expect(placesCalls).toHaveLength(1);
  });
});

describe("9. unauthenticated request", () => {
  it("POST /agent/chat with no session returns 401", async () => {
    currentSession = null;

    const { status, body } = await postChat({
      agentId: "muse-spark",
      tripId: 7,
      messages: [{ role: "user", content: "hello" }],
    });

    expect(status).toBe(401);
    expect(String(body?.error)).toMatch(/not authenticated/i);
    expect(modelRequests).toHaveLength(0);
  });
});

describe("10. non-participant access", () => {
  it("user 99 (not on trip 7) gets 403", async () => {
    currentSession = { userId: 99, role: "traveler" };
    enqueue([{ id: 7 }]); // trip exists
    enqueue([]); // not a participant

    const { status, body } = await postChat({
      agentId: "muse-spark",
      tripId: 7,
      messages: [{ role: "user", content: "what are my dinner reservations?" }],
    });

    expect(status).toBe(403);
    expect(String(body?.error)).toMatch(/access/i);
    expect(modelRequests).toHaveLength(0);
  });
});

describe("11. invalid body", () => {
  it("missing tripId returns 400", async () => {
    const { status, body } = await postChat({
      agentId: "muse-spark",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(status).toBe(400);
    expect(String(body?.error)).toMatch(/invalid body/i);
    expect(modelRequests).toHaveLength(0);
  });
});

describe("12. tool-loop exhaustion", () => {
  it("stops after the max iterations with a graceful message instead of hanging", async () => {
    enqueueTrip7RouteContext();
    // The stubbed model returns tool_calls forever; the loop must cap itself.
    for (let i = 0; i < 10; i++) {
      modelScript.push(toolCallPayload("get_reservations", { tripId: 7 }, `call_${i}`));
      enqueueLoopToolCall(reservations7);
    }

    const { status, body } = await postChat({
      agentId: "muse-spark",
      tripId: 7,
      messages: [{ role: "user", content: "what are my dinner reservations?" }],
    });

    expect(status).toBe(200);
    expect(modelRequests).toHaveLength(6); // MAX_TOOL_ITERATIONS
    expect(String(body?.reply)).toMatch(/kept looping/i);
  });
});

describe("mock fallback", () => {
  it("returns a labeled [mock] reply without touching the model API when the key is unset", async () => {
    delete process.env.MUSE_SPARK_API_KEY;

    const { status, body } = await postChat({
      agentId: "muse-spark",
      tripId: 7,
      messages: [{ role: "user", content: "hello marco" }],
    });

    expect(status).toBe(200);
    expect(body?.mock).toBe(true);
    expect(String(body?.reply)).toMatch(/^\[mock Marco/);
    expect(modelRequests).toHaveLength(0);
  });
});
