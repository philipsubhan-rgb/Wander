/**
 * Voice Gateway — route-level tests.
 *
 * Harness follows agent.eval.test.ts: chainable @workspace/db queue
 * mock, the real agent + voice routers on a minimal Express app,
 * session identity injected by middleware, and globalThis.fetch
 * scripted for the model API (everything else passes through).
 * Speech providers are fakes via the providers test seam — no live
 * STT/TTS call exists in this environment (no keys).
 *
 * What this suite proves end-to-end:
 *  - session creation is auth- and access-checked, carries the
 *    traveler's conversation_language, and refuses PLAINLY (503) when
 *    no speech provider is configured;
 *  - a voice (audio) turn runs the SAME engine as text chat: the
 *    turn persists to the shared conversation memory, and a following
 *    TEXT chat turn is answered with the voice turn in its history —
 *    one conversation, two channels (§2.4);
 *  - barge-in over HTTP cancels the in-flight utterance;
 *  - the screen-confirm endpoint drives the real Booking Gate's
 *    confirm path (attempt in REVIEW → CONFIRMED);
 *  - sessions are owner-only.
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Chainable DB mock (agent.eval.test.ts pattern) ────────────────────────────

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
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "set", "values", "returning", "groupBy"]) {
      chain[m] = () => chain;
    }
    return chain;
  }
  const fakeTable = new Proxy({}, { get: (_t, p) => p });
  return { resultQueue, enqueue, makeChain, fakeTable };
});

const { enqueue } = dbMock;

vi.mock("@workspace/db", () => {
  const tableNames = [
    "tripsTable", "tripParticipantsTable", "itineraryDaysTable", "reservationsTable",
    "flightsTable", "accommodationsTable", "activitiesTable", "carRentalsTable",
    "usersTable", "marcoMessagesTable", "intakeSessionsTable", "bookingAttemptsTable",
    "bookingAttemptTravelersTable", "bookingsTable", "bookingTravelersTable",
    "bookingSplitsTable", "commissionRecordsTable", "advisoriesTable",
    "flightWatchesTable", "travelerProfilesTable", "profileAccessLogTable",
    "tripRosterEntriesTable", "travelerRulesTable", "travelerContextTable",
    "travelerCompanionsTable", "savedGroupsTable", "fxRateSnapshotsTable",
    "connectedAccountsTable", "reservationProposalsTable", "calendarEventLinksTable",
    "travelerInviteTokensTable", "extrasSuggestionsTable",
  ];
  const tables: Record<string, unknown> = {};
  for (const name of tableNames) tables[name] = dbMock.fakeTable;
  return {
    db: {
      select: vi.fn(() => dbMock.makeChain()),
      insert: vi.fn(() => dbMock.makeChain()),
      update: vi.fn(() => dbMock.makeChain()),
      delete: vi.fn(() => dbMock.makeChain()),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({
        select: vi.fn(() => dbMock.makeChain()),
        insert: vi.fn(() => dbMock.makeChain()),
        update: vi.fn(() => dbMock.makeChain()),
        delete: vi.fn(() => dbMock.makeChain()),
      })),
    },
    ...tables,
    pool: { query: vi.fn(), end: vi.fn() },
  };
});

// Avoid loading the real auth router (it pulls in nodemailer via lib/email).
vi.mock("./auth", () => ({
  verifyAuthToken: vi.fn(() => null),
  signAuthToken: vi.fn(() => "test-token"),
}));

import agentRouter from "./agent";
import voiceRouter from "./voice";
import { setVoiceProvidersForTests } from "../lib/voiceProviders";
import type { SpeechToTextProvider, TextToSpeechProvider } from "../lib/voiceProviders";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const trip7Row = {
  id: 7,
  title: "Munich Guys' Trip",
  destination: "Munich, Germany",
  startDate: "2026-09-24",
  endDate: "2026-09-27",
  status: "confirmed",
  description: "Oktoberfest long weekend with the guys",
};

const participantRow = { tripId: 7, userId: 42, isTripAdmin: true };

function attemptRow() {
  return {
    id: 42,
    tripId: 7,
    kind: "flight",
    adapter: "duffel",
    supplier: "United",
    optionId: "off_123",
    optionSnapshot: { option: { id: "off_123" } },
    state: "review",
    visibility: "shared",
    category: null,
    presentedAmountMinor: 61200,
    presentedCurrency: "USD",
    reviewedAmountMinor: 61200,
    reviewedCurrency: "USD",
    reviewVersion: 1,
    homeEquivalentMinor: null,
    homeCurrency: null,
    fxSnapshotId: null,
    changeTerms: "Changes are allowed by the fare rules.",
    cancelTerms: "Non-refundable.",
    whyThisOption: "best_price",
    whyThisOptionText: "Cheapest option that fits your rules.",
    rankingInputsHash: "hash",
    executionChannel: "duffel",
    confirmedByUserId: null,
    confirmedAt: null,
    failureReason: null,
    bookingId: null,
    createdAt: new Date("2026-11-18T09:00:00Z"),
    updatedAt: new Date("2026-11-18T09:00:00Z"),
  };
}

const coverageRow = {
  id: 1,
  attemptId: 42,
  userId: 42,
  rosterEntryId: null,
  isPayer: true,
  confirmedAt: null,
  createdAt: new Date("2026-11-18T09:00:00Z"),
};

// ── Scripted model API ────────────────────────────────────────────────────────

interface ModelRequestBody {
  messages: Array<{ role: string; content: string }>;
}
const modelScript: unknown[] = [];
const modelRequests: ModelRequestBody[] = [];

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
  return realFetch(input as string, init);
}

// ── Fake speech providers ─────────────────────────────────────────────────────

const fakeStt: SpeechToTextProvider = {
  id: "fake-stt",
  transcribe: async () => ({ text: "I want to plan a trip to Munich", confidence: 0.97 }),
};
const fakeTts: TextToSpeechProvider = {
  id: "fake-tts",
  synthesize: async (text: string) => ({
    audio: Buffer.from(`AUDIO:${text}`),
    contentType: "audio/mpeg",
  }),
};

// ── Test app & session control ────────────────────────────────────────────────

let server: http.Server;
let baseUrl: string;
let currentSession: { userId: number; role: string } | null = { userId: 42, role: "traveler" };
const ORIG_SPARK_KEY = process.env.MUSE_SPARK_API_KEY;
const ORIG_FETCH = globalThis.fetch;

beforeAll(async () => {
  process.env.MUSE_SPARK_API_KEY = "test-model-key";
  globalThis.fetch = scriptedFetch as typeof fetch;
  const app = express();
  app.use(express.json());
  app.use((req: express.Request, _res, next) => {
    (req as unknown as { session: unknown }).session = currentSession;
    next();
  });
  app.use(agentRouter);
  app.use(voiceRouter);
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, "127.0.0.1", resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  globalThis.fetch = ORIG_FETCH;
  if (ORIG_SPARK_KEY === undefined) delete process.env.MUSE_SPARK_API_KEY;
  else process.env.MUSE_SPARK_API_KEY = ORIG_SPARK_KEY;
  setVoiceProvidersForTests(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  dbMock.resultQueue.length = 0;
  modelScript.length = 0;
  modelRequests.length = 0;
  currentSession = { userId: 42, role: "traveler" };
  setVoiceProvidersForTests({ stt: fakeStt, tts: fakeTts });
});

// ── DB queue helpers ──────────────────────────────────────────────────────────

/** Session create: trip exists → access → language read. */
function enqueueSessionCreate() {
  enqueue([{ id: 7 }]);
  enqueue([participantRow]);
  enqueue([{ conversationLanguage: "en-US" }]);
}

/** One chat-context load (buildChatContext) for trip 7. */
function enqueueChatContext(historyRows: unknown[]) {
  enqueue([{ id: 7 }]); // trip exists
  enqueue([participantRow]); // access
  enqueue(historyRows); // persisted history
  enqueue([trip7Row]); // snapshot: trips
  for (let i = 0; i < 6; i++) enqueue([]); // snapshot: itinerary/reservations/flights/stays/activities/cars
  for (let i = 0; i < 6; i++) enqueue([]); // timeline build
}

/** Turn persistence (insert + prune select) — keep-list empty, no delete. */
function enqueuePersist() {
  enqueue([]);
  enqueue([]);
}

async function createVoiceSession(): Promise<{ sessionId: string }> {
  enqueueSessionCreate();
  const res = await fetch(`${baseUrl}/agent/voice/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tripId: 7, agentId: "muse-spark" }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { sessionId: string };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /agent/voice/sessions", () => {
  it("creates a session carrying the traveler's conversation language and capabilities", async () => {
    enqueueSessionCreate();
    const res = await fetch(`${baseUrl}/agent/voice/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId: 7 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      sessionId: string;
      language: string;
      capabilities: { speechToText: boolean; textToSpeech: boolean };
      scope: unknown;
    };
    expect(body.language).toBe("en-US");
    expect(body.capabilities).toEqual({ speechToText: true, textToSpeech: true });
    expect(body.scope).toEqual({ kind: "trip", tripId: 7 });
  });

  it("refuses PLAINLY when no speech provider is configured — and names the text fallback", async () => {
    setVoiceProvidersForTests({ stt: null, tts: null });
    const res = await fetch(`${baseUrl}/agent/voice/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId: 7 }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Voice isn't configured");
    expect(body.error).toContain("Text chat works exactly the same");
  });

  it("requires auth and exactly one scope", async () => {
    currentSession = null;
    const unauth = await fetch(`${baseUrl}/agent/voice/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId: 7 }),
    });
    expect(unauth.status).toBe(401);

    currentSession = { userId: 42, role: "traveler" };
    const both = await fetch(`${baseUrl}/agent/voice/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId: 7, intakeSessionId: 3 }),
    });
    expect(both.status).toBe(400);
  });

  it("forbids a non-participant (access check is the chat's own)", async () => {
    enqueue([{ id: 7 }]); // trip exists
    enqueue([]); // no participant row
    const res = await fetch(`${baseUrl}/agent/voice/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tripId: 7 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("voice ↔ text continuity (one conversation, two channels)", () => {
  it("a voice turn persists, and the following TEXT turn is answered with it in history", async () => {
    const { sessionId } = await createVoiceSession();

    // Voice turn (audio at the seam → fake STT → shared engine).
    modelScript.push(finalModelPayload("Ok, where are we going?"));
    enqueueChatContext([]);
    enqueuePersist();
    enqueue([]); // pending-confirmation lookup: none
    const voiceRes = await fetch(`${baseUrl}/agent/voice/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        audioBase64: Buffer.from("raw-audio").toString("base64"),
        audioContentType: "audio/webm",
      }),
    });
    expect(voiceRes.status).toBe(200);
    const voiceBody = (await voiceRes.json()) as {
      heardText: string;
      reply: string;
      utterance: { audioUrl: string; state: string } | null;
      pendingConfirmations: unknown[];
    };
    expect(voiceBody.heardText).toBe("I want to plan a trip to Munich");
    expect(voiceBody.reply).toBe("Ok, where are we going?");
    expect(voiceBody.utterance?.state).toBe("speaking");
    expect(voiceBody.utterance?.audioUrl).toContain("/utterances/");
    expect(voiceBody.pendingConfirmations).toEqual([]);

    // The utterance audio is served back. (audioUrl is the production
    // path incl. the /api mount; this harness mounts routers bare.)
    const audioPath = voiceBody.utterance!.audioUrl.replace(/^\/api/, "");
    const audioRes = await fetch(`${baseUrl}${audioPath}`);
    expect(audioRes.status).toBe(200);
    expect(await audioRes.text()).toBe("AUDIO:Ok, where are we going?");

    // TEXT turn on the same trip through the ordinary chat endpoint.
    // Its persisted history now contains the voice turn — the model
    // must be given both sides of it.
    modelScript.push(finalModelPayload("Munich in September — great choice."));
    enqueueChatContext([
      { role: "user", content: "I want to plan a trip to Munich" },
      { role: "assistant", content: "Ok, where are we going?" },
    ]);
    enqueuePersist();
    const textRes = await fetch(`${baseUrl}/agent/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentId: "muse-spark",
        tripId: 7,
        messages: [{ role: "user", content: "Munich, in September" }],
      }),
    });
    expect(textRes.status).toBe(200);
    expect(modelRequests).toHaveLength(2);
    const secondCallMessages = modelRequests[1].messages.map((m) => m.content);
    expect(secondCallMessages).toContain("I want to plan a trip to Munich");
    expect(secondCallMessages).toContain("Ok, where are we going?");
    expect(secondCallMessages).toContain("Munich, in September");
  });
});

describe("barge-in and ownership", () => {
  it("POST interrupt cancels the in-flight utterance", async () => {
    const { sessionId } = await createVoiceSession();
    modelScript.push(finalModelPayload("A long answer about Munich…"));
    enqueueChatContext([]);
    enqueuePersist();
    enqueue([]);
    const turn = await fetch(`${baseUrl}/agent/voice/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Tell me about Munich" }),
    });
    const turnBody = (await turn.json()) as { utterance: { id: string } | null };
    const utteranceId = turnBody.utterance!.id;

    const interruptRes = await fetch(`${baseUrl}/agent/voice/sessions/${sessionId}/interrupt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(interruptRes.status).toBe(200);
    const interruptBody = (await interruptRes.json()) as { cancelledUtteranceIds: string[] };
    expect(interruptBody.cancelledUtteranceIds).toEqual([utteranceId]);

    const viewRes = await fetch(`${baseUrl}/agent/voice/sessions/${sessionId}`);
    const view = (await viewRes.json()) as { utterances: Array<{ id: string; state: string }> };
    expect(view.utterances.find((u) => u.id === utteranceId)?.state).toBe("cancelled");
  });

  it("sessions are owner-only", async () => {
    const { sessionId } = await createVoiceSession();
    currentSession = { userId: 99, role: "traveler" };
    const res = await fetch(`${baseUrl}/agent/voice/sessions/${sessionId}`);
    expect(res.status).toBe(403);
  });
});

describe("screen confirmation over HTTP", () => {
  it("POST confirm drives the real gate: REVIEW → CONFIRMED", async () => {
    const { sessionId } = await createVoiceSession();
    // confirmOnScreen's pending lookup + getAttemptView:
    enqueue([attemptRow()]);
    enqueue([attemptRow()]);
    enqueue([participantRow]);
    enqueue([coverageRow]);
    // gate.confirmAttempt: load, access, coverage, two updates:
    enqueue([attemptRow()]);
    enqueue([participantRow]);
    enqueue([coverageRow]);
    enqueue([]);
    enqueue([]);
    // refresh after confirm: nothing left in review
    enqueue([]);

    const res = await fetch(`${baseUrl}/agent/voice/sessions/${sessionId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: 42 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      confirmed: boolean;
      state: string;
      pendingConfirmations: unknown[];
    };
    expect(body.confirmed).toBe(true);
    expect(body.state).toBe("confirmed");
    expect(body.pendingConfirmations).toEqual([]);
  });

  it("POST confirm for an attempt that is not pending is a 409, not a charge", async () => {
    const { sessionId } = await createVoiceSession();
    enqueue([]); // pending lookup: nothing in review
    const res = await fetch(`${baseUrl}/agent/voice/sessions/${sessionId}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: 42 }),
    });
    expect(res.status).toBe(409);
  });
});
