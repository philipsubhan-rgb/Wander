/**
 * Asks-less EVAL — the context layer's §4.4 metric, made executable
 * (Story 6.5): the SAME traveler planning a second trip is asked
 * strictly fewer slot questions than on their first, because context
 * (a saved group, known rules, a known home) settles slots without
 * asking. Harness: agent.intake.eval.test.ts, extended with real
 * context fixtures in the planner-snapshot digest.
 *
 *  - Scenario A — brand-new traveler, empty digest: Wander asks
 *    destination, party, dates, style (4 slot questions).
 *  - Scenario B — repeat traveler: confirmed home base + airports, a
 *    no-Basic-Economy hard rule, three companions and the saved group
 *    "Munich guys", a past Munich trip. ONE user turn ("another Munich
 *    trip with the guys") settles destination AND party — the party
 *    lands from the saved group with provenance from_context — so
 *    Wander asks only dates and style (2 slot questions).
 *
 * "Questions asked" is measured from the machine's own outputs: the
 * intakeState each turn ends in, and the "Intake state:" line of the
 * last tool result in each turn (the slot Marco is now asking about).
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Chainable FIFO DB mock (agent.eval.test.ts pattern) ──────────────────────

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
    for (const m of ["from", "where", "orderBy", "limit", "offset", "set", "values", "returning", "onConflictDoUpdate", "onConflictDoNothing", "groupBy", "innerJoin", "leftJoin"]) {
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
  usersTable: dbMock.fakeTable,
  tripsTable: dbMock.fakeTable,
  tripParticipantsTable: dbMock.fakeTable,
  marcoMessagesTable: dbMock.fakeTable,
  intakeSessionsTable: dbMock.fakeTable,
  tripRosterEntriesTable: dbMock.fakeTable,
  // Context-layer tables (planner snapshot digest).
  travelerContextTable: dbMock.fakeTable,
  travelerRulesTable: dbMock.fakeTable,
  travelerCompanionsTable: dbMock.fakeTable,
  savedGroupsTable: dbMock.fakeTable,
  pool: { query: vi.fn(), end: vi.fn() },
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const userRow = { id: 42, name: "Phil", email: "phil@example.com", role: "traveler" };

function intakeRow(slots: Record<string, unknown>) {
  return {
    id: 5, userId: 42, state: "OPENING", slots, openItems: [], draftTripId: null,
    channel: "text", questionsAsked: 0, createdAt: new Date(), updatedAt: new Date(),
  };
}

const destSlot = { value: { kind: "place", text: "Munich" }, provenance: "stated" };
const partySlotAsked = {
  value: {
    solo: false,
    travelers: [
      { name: "Kurt", email: "kurt@example.com" },
      { name: "Pradip", email: "pradip@example.com" },
    ],
  },
  provenance: "asked",
};
const partySlotFromContext = {
  value: {
    solo: false,
    travelers: [
      { name: "Kurt", email: "kurt@example.com" },
      { name: "Pradip", email: "pradip@example.com" },
      { name: "Manish", email: "manish@example.com" },
    ],
  },
  provenance: "from_context",
};
const datesSlot = { value: { startDate: "2026-09-24", endDate: "2026-09-28" }, provenance: "asked" };
const styleSlot = { value: { text: "guys' trip" }, provenance: "asked" };

const openingRow = () => intakeRow({ intentCaptured: false });
const intentRow = () => intakeRow({ intentCaptured: true });
const destRow = () => intakeRow({ intentCaptured: true, destination: destSlot });
const partyRowA = () => intakeRow({ intentCaptured: true, destination: destSlot, party: partySlotAsked });
const partyRowB = () => intakeRow({ intentCaptured: true, destination: destSlot, party: partySlotFromContext });
const datesRowA = () => intakeRow({ intentCaptured: true, destination: destSlot, party: partySlotAsked, dates: datesSlot });
const datesRowB = () => intakeRow({ intentCaptured: true, destination: destSlot, party: partySlotFromContext, dates: datesSlot });
const reviewRowA = () => intakeRow({ intentCaptured: true, destination: destSlot, party: partySlotAsked, dates: datesSlot, style: styleSlot });
const reviewRowB = () => intakeRow({ intentCaptured: true, destination: destSlot, party: partySlotFromContext, dates: datesSlot, style: styleSlot });

// Repeat-traveler context fixtures.
const ctxRow = {
  userId: 42,
  homeBase: "Lawrenceville, NJ", homeBaseLat: null, homeBaseLon: null,
  homeBaseSource: "explicit", homeBaseConfirmed: true,
  homeAirports: ["EWR", "PHL"], homeAirportsSource: "explicit", homeAirportsConfirmed: true,
  createdAt: new Date(), updatedAt: new Date(),
};
const noBasicRuleRow = {
  id: 1, userId: 42, ruleClass: "hard", ruleType: "fare_class_ban",
  params: { banned: ["Basic Economy"] }, scope: "all", source: "explicit", active: true,
  createdAt: new Date(), updatedAt: new Date(),
};
const companionRows = [
  { id: 1, userId: 42, name: "Kurt", email: "kurt@example.com", linkedUserId: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 2, userId: 42, name: "Pradip", email: "pradip@example.com", linkedUserId: null, createdAt: new Date(), updatedAt: new Date() },
  { id: 3, userId: 42, name: "Manish", email: "manish@example.com", linkedUserId: null, createdAt: new Date(), updatedAt: new Date() },
];
const groupRow = {
  id: 7, userId: 42, name: "Munich guys", memberCompanionIds: [1, 2, 3],
  createdAt: new Date(), updatedAt: new Date(),
};
const pastTripRows = [{ destination: "Munich", startDate: "2026-09-24" }];

// ── Choreography (mirrors agent.intake.eval.test.ts) ─────────────────────────

/**
 * Pre-loop hits: session load → access check → [intent-mark load +
 * update, OPENING sessions only] → history → snapshot user row →
 * digest selects in shift order: traveler_context, traveler_rules,
 * traveler_companions ×2 (digest + saved-group member resolution),
 * saved_groups, past trips.
 */
function enqueuePreamble(row: () => Record<string, unknown>, opening: boolean, repeatTraveler: boolean) {
  enqueue([row()]);
  enqueue([row()]);
  if (opening) {
    enqueue([row()]);
    enqueue([]);
  }
  enqueue([]); // history
  enqueue([userRow]); // snapshot user row
  if (repeatTraveler) {
    // Order note (probe-verified): inside listSavedGroups, the directly
    // awaited companion read shifts BEFORE the Promise.all-assimilated
    // groups read — companions land twice before the group row.
    enqueue([ctxRow], [noBasicRuleRow], companionRows, companionRows, [groupRow], pastTripRows);
  } else {
    enqueue([], [], [], [], [], []);
  }
}

/** One plain tool iteration: access re-assert + session load + write. */
function enqueueToolIteration(row: () => Record<string, unknown>) {
  enqueue([row()]);
  enqueue([row()]);
  enqueue([]);
}

/** The group-fill iteration: + saved group + its companion rows. */
function enqueueGroupIteration(row: () => Record<string, unknown>) {
  enqueue([row()]);
  enqueue([row()]);
  enqueue([groupRow]);
  enqueue(companionRows);
  enqueue([]);
}

/** finishIntakeTurn: load → persist → prune → ask load → [ask update] → final load. */
function enqueueFinish(row: () => Record<string, unknown>, countsAsk: boolean) {
  enqueue([row()]);
  enqueue([]);
  enqueue([]);
  enqueue([row()]);
  if (countsAsk) enqueue([]);
  enqueue([row()]);
}

// ── Scripted model API (agent.intake.eval.test.ts pattern) ───────────────────

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

// ── Test app ──────────────────────────────────────────────────────────────────

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
}, 60000);

afterAll(() => {
  server?.close();
  vi.unstubAllGlobals();
  if (ORIG_SPARK_KEY === undefined) delete process.env.MUSE_SPARK_API_KEY;
  else process.env.MUSE_SPARK_API_KEY = ORIG_SPARK_KEY;
});

beforeEach(() => {
  dbMock.resultQueue.length = 0;
  modelScript.length = 0;
  modelRequests.length = 0;
  currentSession = { userId: 42, role: "traveler" };
  process.env.MUSE_SPARK_API_KEY = "sk-scripted-eval";
});

async function postChat(content: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${baseUrl}/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentId: "muse-spark",
      intakeSessionId: 5,
      messages: [{ role: "user", content }],
    }),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

function toolMessagesOf(requestIndex: number): string[] {
  return modelRequests[requestIndex].messages
    .filter((m) => m.role === "tool")
    .map((m) => m.content);
}

function systemTextOf(requestIndex: number): string {
  // Several system messages ride in one request (loop prompt + planner
  // snapshot); join them all, as agent.eval.test.ts does.
  return modelRequests[requestIndex].messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

const STATE_TO_ASK: Record<string, string> = {
  DESTINATION: "destination",
  PARTY: "party",
  DATES: "dates",
  STYLE: "style",
};

/** The ask a turn ends on, read from the last tool result's state line. */
function finalAskOfTurn(requestIndex: number): string | null {
  const texts = toolMessagesOf(requestIndex);
  let ask: string | null = null;
  for (const t of texts) {
    const m = /Intake state: (\w+)/.exec(t);
    if (m && STATE_TO_ASK[m[1]]) ask = STATE_TO_ASK[m[1]];
  }
  return ask;
}

// ── The eval ──────────────────────────────────────────────────────────────────

describe("asks-less eval — context makes the second intake shorter (§4.4)", () => {
  it("Scenario A: a brand-new traveler is asked destination, party, dates, style", async () => {
    // Turn 1 — intent only; the opening ask is the destination question.
    enqueuePreamble(openingRow, true, false);
    enqueueFinish(intentRow, true);
    modelScript.push(finalModelPayload("Ok, where are we going?"));
    const a1 = await postChat("I want to plan a trip");
    expect(a1.status).toBe(200);
    expect(a1.body?.intakeState).toBe("DESTINATION");
    // No context exists yet — the snapshot carries none.
    expect(systemTextOf(0)).not.toContain("Home base:");
    expect(systemTextOf(0)).not.toContain("Saved groups:");

    // Turn 2 — destination → party ask.
    enqueuePreamble(intentRow, false, false);
    enqueueToolIteration(intentRow);
    enqueueFinish(destRow, true);
    modelScript.push(
      toolCallPayload("intake_set_destination", { text: "Munich", kind: "place", provenance: "stated" }),
      finalModelPayload("Munich — love it. Who's going?"),
    );
    const a2 = await postChat("Munich");
    expect(a2.body?.intakeState).toBe("PARTY");
    expect(finalAskOfTurn(2)).toBe("party");

    // Turn 3 — party (asked, with emails) → dates ask.
    enqueuePreamble(destRow, false, false);
    enqueueToolIteration(destRow);
    enqueueFinish(partyRowA, true);
    modelScript.push(
      toolCallPayload("intake_set_party", {
        solo: false,
        travelers: [
          { name: "Kurt", email: "kurt@example.com" },
          { name: "Pradip", email: "pradip@example.com" },
        ],
        provenance: "asked",
      }),
      finalModelPayload("Great crew. When are you thinking of going?"),
    );
    const a3 = await postChat("Kurt and Pradip — kurt@example.com, pradip@example.com");
    expect(a3.body?.intakeState).toBe("DATES");
    expect(finalAskOfTurn(4)).toBe("dates");

    // Turn 4 — dates → style ask.
    enqueuePreamble(partyRowA, false, false);
    enqueueToolIteration(partyRowA);
    enqueueFinish(datesRowA, true);
    modelScript.push(
      toolCallPayload("intake_set_dates", { startDate: "2026-09-24", endDate: "2026-09-28", provenance: "asked" }),
      finalModelPayload("Locked in. What kind of trip is this?"),
    );
    const a4 = await postChat("Sep 24 to 28");
    expect(a4.body?.intakeState).toBe("STYLE");
    expect(finalAskOfTurn(6)).toBe("style");

    // Turn 5 — style → REVIEW (no further ask; finish counts nothing).
    enqueuePreamble(datesRowA, false, false);
    enqueueToolIteration(datesRowA);
    enqueueFinish(reviewRowA, false);
    modelScript.push(
      toolCallPayload("intake_set_style", { text: "guys' trip", provenance: "asked" }),
      finalModelPayload("Here's the shape of it…"),
    );
    const a5 = await postChat("A guys' trip");
    expect(a5.body?.intakeState).toBe("REVIEW");

    const questionsA = [a1, a2, a3, a4, a5]
      .map((r) => r.body?.intakeState as string)
      .filter((s) => s !== "REVIEW");
    expect(questionsA).toEqual(["DESTINATION", "PARTY", "DATES", "STYLE"]);
    (globalThis as Record<string, unknown>).__questionsA = questionsA;
  });

  it("Scenario B: the repeat traveler is asked ONLY dates and style — strictly fewer", async () => {
    // Turn 1 — ONE message settles destination AND party (saved group).
    enqueuePreamble(openingRow, true, true);
    enqueueToolIteration(intentRow); // set_destination
    enqueueGroupIteration(destRow); // set_party_from_group
    enqueueFinish(partyRowB, true);
    modelScript.push(
      toolCallPayload("intake_set_destination", { text: "Munich", kind: "place", provenance: "stated" }, "call_1"),
      toolCallPayload("intake_set_party_from_group", { groupId: 7 }, "call_2"),
      finalModelPayload("The guys, Munich — when are we going?"),
    );
    const b1 = await postChat("Another Munich trip with the guys");
    expect(b1.status).toBe(200);
    // Party never became a question: the turn ends at DATES.
    expect(b1.body?.intakeState).toBe("DATES");
    // The snapshot carried the context that made this possible.
    expect(systemTextOf(0)).toContain("Home base: Lawrenceville, NJ");
    expect(systemTextOf(0)).toContain("Never Basic Economy");
    expect(systemTextOf(0)).toContain('"Munich guys" (group 7)');
    // The group fill reported itself, and the turn's final ask is dates.
    const turn1Tools = toolMessagesOf(2).join("\n");
    expect(turn1Tools).toContain("Party filled from the saved group: Kurt, Pradip, Manish");
    expect(finalAskOfTurn(2)).toBe("dates");

    // Turn 2 — dates → style ask.
    enqueuePreamble(partyRowB, false, true);
    enqueueToolIteration(partyRowB);
    enqueueFinish(datesRowB, true);
    modelScript.push(
      toolCallPayload("intake_set_dates", { startDate: "2026-09-24", endDate: "2026-09-28", provenance: "asked" }),
      finalModelPayload("And what kind of trip is this one?"),
    );
    const b2 = await postChat("Sep 24 to 28");
    expect(b2.body?.intakeState).toBe("STYLE");
    expect(finalAskOfTurn(4)).toBe("style");

    // Turn 3 — style → REVIEW; the party's provenance is on the record.
    enqueuePreamble(datesRowB, false, true);
    enqueueToolIteration(datesRowB);
    enqueueFinish(reviewRowB, false);
    modelScript.push(
      toolCallPayload("intake_set_style", { text: "guys' trip", provenance: "asked" }),
      finalModelPayload("Here's the shape of it…"),
    );
    const b3 = await postChat("A guys' trip");
    expect(b3.body?.intakeState).toBe("REVIEW");
    const reviewTools = toolMessagesOf(6).join("\n");
    expect(reviewTools).toContain("(from your profile");

    const questionsB = [b1, b2, b3]
      .map((r) => r.body?.intakeState as string)
      .filter((s) => s !== "REVIEW");
    const questionsA = (globalThis as Record<string, unknown>).__questionsA as string[];
    expect(questionsB).toEqual(["DATES", "STYLE"]);
    // The headline metric (§4.4): strictly fewer questions, a strict subset.
    expect(questionsB.length).toBeLessThan(questionsA.length);
    expect(questionsB.every((q) => questionsA.includes(q))).toBe(true);
  });
});
