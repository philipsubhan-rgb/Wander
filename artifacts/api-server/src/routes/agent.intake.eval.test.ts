/**
 * Marco planner intake — rung 1 eval suite (architecture §2, ADR-3).
 *
 * Same harness as agent.eval.test.ts: chainable @workspace/db mock with a
 * single FIFO result queue, the agent router on a minimal Express app,
 * and a scripted model API. What this suite asserts is the intake
 * MACHINERY around the model:
 *   - intent → the machine's opening question is what Marco is told to
 *     ask ("Ok, where are we going?"), with only intake_* tools offered;
 *   - a destination stated inside the intent is recorded via
 *     intake_set_destination and NOT re-asked — the machine's next ask
 *     becomes the party question;
 *   - a mid-intake correction rewrites the party slot in place — the
 *     machine stays in DATES, no restart;
 *   - intake_confirm materializes the draft trip transactionally and the
 *     chat response carries the new tripId;
 *   - session ownership is enforced at the route (403 for non-owners);
 *   - the intake-session endpoints create/read machine state.
 *
 * DB-hit counting: the queue is global FIFO, so each scenario enqueues
 * exactly the rows its code path consumes, in order. The counts are
 * documented per scenario; if the route's query order changes, these
 * fixtures must change with it (same contract as agent.eval.test.ts).
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Chainable DB mock (agent.eval.test.ts pattern + transaction) ─────────────

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

  return { resultQueue, enqueue, makeChain, fakeTable, db };
});

const { enqueue } = dbMock;

vi.mock("@workspace/db", () => ({
  db: dbMock.db,
  tripsTable: dbMock.fakeTable,
  tripParticipantsTable: dbMock.fakeTable,
  itineraryDaysTable: dbMock.fakeTable,
  reservationsTable: dbMock.fakeTable,
  flightsTable: dbMock.fakeTable,
  accommodationsTable: dbMock.fakeTable,
  activitiesTable: dbMock.fakeTable,
  carRentalsTable: dbMock.fakeTable,
  usersTable: dbMock.fakeTable,
  intakeSessionsTable: dbMock.fakeTable,
  tripRosterEntriesTable: dbMock.fakeTable,
  marcoMessagesTable: dbMock.fakeTable,
  travelerContextTable: dbMock.fakeTable,
  travelerRulesTable: dbMock.fakeTable,
  travelerCompanionsTable: dbMock.fakeTable,
  savedGroupsTable: dbMock.fakeTable,
  pool: { query: vi.fn(), end: vi.fn() },
}));

// Avoid loading the real auth router (it pulls in nodemailer via lib/email).
vi.mock("../routes/auth", () => ({
  verifyAuthToken: vi.fn(() => null),
  signAuthToken: vi.fn(() => "test-token"),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const userRow = {
  id: 42,
  name: "Phil",
  locale: "en-US",
  homeCurrency: "USD",
  timezone: "America/New_York",
  conversationLanguage: "en",
};

const destSlot = { value: { kind: "place", text: "Munich" }, provenance: "stated" };
const partySlot2 = {
  value: {
    solo: false,
    travelers: [
      { name: "Kurt", email: "kurt@example.com" },
      { name: "Pradip", email: "pradip@example.com" },
    ],
  },
  provenance: "asked",
};
const partySlot3 = {
  value: {
    solo: false,
    travelers: [
      { name: "Kurt", email: "kurt@example.com" },
      { name: "Pradip", email: "pradip@example.com" },
      { name: "Manish", email: "manish@example.com" },
    ],
  },
  provenance: "stated",
};
const datesSlot = { value: { startDate: "2026-09-24", endDate: "2026-09-28" }, provenance: "asked" };
const styleSlot = { value: { text: "guys' trip" }, provenance: "asked" };

function intakeRow(slots: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 5,
    userId: 42,
    state: "OPENING",
    slots,
    openItems: [],
    draftTripId: null,
    channel: "text",
    questionsAsked: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const openingRow = () => intakeRow({ intentCaptured: false });
const intentRow = () => intakeRow({ intentCaptured: true });
const destinationRow = () => intakeRow({ intentCaptured: true, destination: destSlot });
const datesStateRow = () => intakeRow({ intentCaptured: true, destination: destSlot, party: partySlot2 });
const datesStateRow3 = () => intakeRow({ intentCaptured: true, destination: destSlot, party: partySlot3 });
const reviewRow = () =>
  intakeRow({ intentCaptured: true, destination: destSlot, party: partySlot2, dates: datesSlot, style: styleSlot });
const materializedRow = () =>
  intakeRow(
    { intentCaptured: true, destination: destSlot, party: partySlot2, dates: datesSlot, style: styleSlot },
    { draftTripId: 77, state: "MATERIALIZED" },
  );

/**
 * Pre-loop DB hits for an intake chat turn:
 *   1. loadIntakeSession (session row)
 *   2. assertIntakeAccess (session row again)
 *   3-4. markIntakeIntent select + update — ONLY when the session is OPENING
 *   then: persisted-history select (marco_messages), planner user select,
 *   and the planner snapshot v2 context digest (context layer §4.3):
 *   traveler_context, traveler_rules, traveler_companions ×2 (digest +
 *   saved-groups member resolution), saved_groups, past-trips select.
 *   These fixtures carry NO context — the traveler is new, the digest is
 *   empty, and the snapshot renders no context lines.
 */
function enqueueIntakePreamble(row: () => Record<string, unknown>, opening: boolean) {
  enqueue([row()]); // 1 session load
  enqueue([row()]); // 2 access check
  if (opening) {
    enqueue([row()]); // 3 intent-mark load
    enqueue([]); // 4 intent-mark update (fallback row is used)
  }
  enqueue([]); // history: no persisted turns
  enqueue([userRow]); // planner snapshot user row
  enqueue([]); // digest: traveler_context — none
  enqueue([]); // digest: traveler_rules — none
  enqueue([]); // digest: traveler_companions — none
  enqueue([]); // digest: companions again (saved-group resolution)
  enqueue([]); // digest: saved_groups — none
  enqueue([]); // digest: past trips (destination suggestions) — none
}

/**
 * Post-loop DB hits (finishIntakeTurn), not materialized:
 *   load session → persist insert → prune select → ask-accounting load →
 *   ask-accounting update (question states only) → final load.
 */
function enqueueIntakeFinish(row: () => Record<string, unknown>, countsAsk: boolean) {
  enqueue([row()]); // finish: load session
  enqueue([]); // finish: persist insert
  enqueue([]); // finish: prune select (nothing to prune)
  enqueue([row()]); // ask accounting: load
  if (countsAsk) enqueue([]); // ask accounting: update
  enqueue([row()]); // finish: final load
}

// ── Scripted model API (agent.eval.test.ts pattern) ───────────────────────────

interface ModelApiMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

interface ModelRequestBody {
  model: string;
  messages: ModelApiMessage[];
  tools: Array<{ type: string; function: { name: string } }>;
}

const modelScript: unknown[] = [];
const modelRequests: ModelRequestBody[] = [];

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
    if (payload instanceof Error) throw payload;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as unknown as Response;
  }
  return realFetch(input as string, init);
}

// ── Test app & session control ────────────────────────────────────────────────

let currentSession: { userId: number; role: string } | null = { userId: 42, role: "traveler" };
let server: http.Server;
let baseUrl: string;

const ORIG_SPARK_KEY = process.env.MUSE_SPARK_API_KEY;

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
});

beforeEach(() => {
  dbMock.resultQueue.length = 0;
  modelScript.length = 0;
  modelRequests.length = 0;
  currentSession = { userId: 42, role: "traveler" };
  process.env.MUSE_SPARK_API_KEY = "test-spark-key";
});

async function postChat(body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

function toolMessagesOf(requestIndex: number): string[] {
  return modelRequests[requestIndex].messages
    .filter((m) => m.role === "tool")
    .map((m) => m.content);
}

// ── Evals ─────────────────────────────────────────────────────────────────────

describe("intake rung 1 — conversational planner intake", () => {
  it("1. intent → Marco is told to ask the opening question, intake tools only", async () => {
    enqueueIntakePreamble(openingRow, true);
    enqueueIntakeFinish(intentRow, true);
    modelScript.push(finalModelPayload("Ok, where are we going?"));

    const { status, body } = await postChat({
      agentId: "muse-spark",
      intakeSessionId: 5,
      messages: [{ role: "user", content: "I want to plan a trip" }],
    });

    expect(status).toBe(200);
    expect(body?.reply).toBe("Ok, where are we going?");
    expect(body?.intakeSessionId).toBe(5);
    expect(body?.intakeState).toBe("DESTINATION");
    expect(body?.tripId).toBeUndefined();

    // The planner snapshot handed the model the machine state + next ask.
    const snapshot = modelRequests[0].messages[1];
    expect(snapshot.content).toContain("Planner intake context");
    expect(snapshot.content).toContain("Intake state: DESTINATION");
    expect(snapshot.content).toContain('"Ok, where are we going?"');
    // Intake scope offers the intake tools plus the context tools (the
    // traveler can teach Wander mid-intake, §4) and the options tools
    // (a leg can be priced mid-intake, §5.1) — never trip tools.
    const toolNames = modelRequests[0].tools.map((t) => t.function.name);
    expect(toolNames.length).toBeGreaterThan(0);
    expect(
      toolNames.every(
        (n) => n.startsWith("intake_") || n.startsWith("context_") || n.startsWith("options_"),
      ),
    ).toBe(true);
  });

  it("2. destination stated in the intent is recorded and NOT re-asked", async () => {
    enqueueIntakePreamble(openingRow, true);
    // Loop iteration 1: access re-assert + tool's session load + tool update.
    enqueue([openingRow()]);
    enqueue([destinationRow()]);
    enqueue([]);
    enqueueIntakeFinish(destinationRow, true);
    modelScript.push(
      toolCallPayload("intake_set_destination", { text: "Munich", kind: "place", provenance: "stated" }),
      finalModelPayload("Munich — love it. Who's going?"),
    );

    const { status, body } = await postChat({
      agentId: "muse-spark",
      intakeSessionId: 5,
      messages: [{ role: "user", content: "I want to plan a trip to Munich" }],
    });

    expect(status).toBe(200);
    expect(body?.reply).toBe("Munich — love it. Who's going?");
    expect(body?.intakeState).toBe("PARTY");
    // The tool result told the model the destination landed and the next
    // ask is the party question — the destination is never re-asked.
    const toolTexts = toolMessagesOf(1);
    expect(toolTexts).toHaveLength(1);
    expect(toolTexts[0]).toContain("Destination recorded: Munich");
    expect(toolTexts[0]).toContain("Intake state: PARTY");
    expect(toolTexts[0]).toContain("Who's going?");
    expect((body?.reply as string).toLowerCase()).not.toContain("where are we going");
  });

  it("3. mid-intake correction rewrites the party in place — no restart", async () => {
    enqueueIntakePreamble(datesStateRow, false);
    // Loop iteration 1: access re-assert + tool's session load + tool update.
    enqueue([datesStateRow()]);
    enqueue([datesStateRow()]);
    enqueue([]);
    enqueueIntakeFinish(datesStateRow3, true);
    modelScript.push(
      toolCallPayload("intake_set_party", {
        solo: false,
        travelers: [
          { name: "Kurt", email: "kurt@example.com" },
          { name: "Pradip", email: "pradip@example.com" },
          { name: "Manish", email: "manish@example.com" },
        ],
        provenance: "stated",
      }),
      finalModelPayload("Added Manish. When are you thinking of going?"),
    );

    const { status, body } = await postChat({
      agentId: "muse-spark",
      intakeSessionId: 5,
      messages: [{ role: "user", content: "Actually, Manish is coming too — manish@example.com" }],
    });

    expect(status).toBe(200);
    expect(body?.intakeState).toBe("DATES");
    const toolTexts = toolMessagesOf(1);
    expect(toolTexts[0]).toContain("Party recorded: Kurt, Pradip, Manish");
    // The machine stayed in DATES — the correction did not restart intake.
    expect(toolTexts[0]).toContain("Intake state: DATES");
  });

  it("4. intake_confirm materializes the draft trip and the response carries its id", async () => {
    enqueueIntakePreamble(reviewRow, false);
    // Loop iteration 1: access re-assert, then materializeIntake:
    //   load → tx: insert trips (returns the new id), insert participant,
    //   insert roster, re-key messages update, session update → post-tx load.
    enqueue([reviewRow()]);
    enqueue([reviewRow()]);
    enqueue([{ id: 77 }]);
    enqueue([]);
    enqueue([]);
    enqueue([]);
    enqueue([]);
    enqueue([materializedRow()]);
    // finishIntakeTurn on a materialized session: load → persist insert
    // (trip scope) → prune select → ask load (no update at MATERIALIZED)
    // → final load.
    enqueue([materializedRow()]);
    enqueue([]);
    enqueue([]);
    enqueue([materializedRow()]);
    enqueue([materializedRow()]);
    modelScript.push(
      toolCallPayload("intake_confirm", {}),
      finalModelPayload("Your Munich trip is created — let's keep planning it here."),
    );

    const { status, body } = await postChat({
      agentId: "muse-spark",
      intakeSessionId: 5,
      messages: [{ role: "user", content: "Looks good — create it" }],
    });

    expect(status).toBe(200);
    expect(body?.tripId).toBe(77);
    expect(body?.intakeState).toBe("MATERIALIZED");
    const toolTexts = toolMessagesOf(1);
    expect(toolTexts[0]).toContain("Trip created: draft trip 77");
  });

  it("5. a non-owner gets 403 and the model is never called", async () => {
    const foreignRow = () => intakeRow({ intentCaptured: true }, { userId: 99 });
    enqueue([foreignRow()]); // session load
    enqueue([foreignRow()]); // access check load → denied

    const { status } = await postChat({
      agentId: "muse-spark",
      intakeSessionId: 5,
      messages: [{ role: "user", content: "I want to plan a trip" }],
    });

    expect(status).toBe(403);
    expect(modelRequests).toHaveLength(0);
  });

  it("6. intake-session endpoints create and read machine state", async () => {
    enqueue([openingRow()]); // create: insert returning the row
    const created = await fetch(`${baseUrl}/agent/intake-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Record<string, unknown>;
    expect(createdBody.state).toBe("OPENING");
    expect((createdBody.nextAsk as { question: string }).question).toBe("Ok, where are we going?");

    enqueue([openingRow()]); // read: existence load
    enqueue([openingRow()]); // read: access load
    const read = await fetch(`${baseUrl}/agent/intake-sessions/5`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as Record<string, unknown>;
    expect(readBody.id).toBe(5);
    expect(readBody.state).toBe("OPENING");
  });
});
