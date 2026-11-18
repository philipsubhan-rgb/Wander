/**
 * Voice Session Service — channel-adapter tests with fake providers,
 * a fake turn runner, and a fake gate port. The engine behind the
 * runner is the real shared loop (covered by the route-level suite);
 * here the contract under test is the adapter's own:
 *
 *  - turns (audio via STT, or text at the seam) reach the SAME runner
 *    with the session's scope and identity — one conversation;
 *  - replies come back as text + speech-rendered text + an utterance
 *    carrying the synthesized audio;
 *  - barge-in: a new turn (or an explicit interrupt) cancels in-flight
 *    speech, with speech_cancelled on the event log;
 *  - a booking left in REVIEW by a turn surfaces as a
 *    pending-confirmation record; the screen-confirm path calls the
 *    gate's confirm for THIS session's trip only;
 *  - unconfigured STT refuses plainly; an empty transcript runs no
 *    turn and persists nothing;
 *  - the session language flows to both providers on every call;
 *  - intake materialization moves the session to the new trip scope.
 */

import { describe, it, expect, vi } from "vitest";

// voiceSession.ts imports @workspace/db at load (default gate port +
// language loader) — substitute the chainable mock so the suite runs
// without a database. All gate/provider/runner behavior in this suite
// comes from injected fakes; the mock only satisfies module load.
vi.mock("@workspace/db", () => {
  const makeChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown) => Promise.resolve([]).then(res),
    };
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "limit", "set", "values", "returning"]) {
      chain[m] = () => chain;
    }
    return chain;
  };
  const fakeTable = new Proxy({}, { get: (_t, p) => p });
  const tableNames = [
    "bookingAttemptsTable", "bookingAttemptTravelersTable", "bookingsTable",
    "bookingTravelersTable", "bookingSplitsTable", "commissionRecordsTable",
    "flightsTable", "tripsTable", "tripParticipantsTable", "usersTable",
    "accommodationsTable", "activitiesTable", "itineraryDaysTable",
    "carRentalsTable", "reservationsTable", "advisoriesTable",
    "flightWatchesTable", "travelerProfilesTable", "profileAccessLogTable",
    "tripRosterEntriesTable", "travelerRulesTable", "travelerContextTable",
    "travelerCompanionsTable", "savedGroupsTable", "marcoMessagesTable",
    "intakeSessionsTable", "fxRateSnapshotsTable",
  ];
  const tables: Record<string, unknown> = {};
  for (const name of tableNames) tables[name] = fakeTable;
  return {
    db: {
      select: vi.fn(() => makeChain()),
      insert: vi.fn(() => makeChain()),
      update: vi.fn(() => makeChain()),
      delete: vi.fn(() => makeChain()),
      transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
    },
    ...tables,
    pool: { query: vi.fn(), end: vi.fn() },
  };
});

import {
  VoiceSessionService,
  VoiceSessionError,
  STT_UNCONFIGURED_MESSAGE,
  type PendingConfirmation,
  type VoiceGatePort,
  type VoiceTurnRunner,
} from "./voiceSession";
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
  VoiceProviders,
} from "./voiceProviders";
import type { ConfirmResult } from "./bookingGate";
import type { BookingAttempt } from "@workspace/db";

// ─── Fakes ───────────────────────────────────────────────────────────────────

function fakeStt(transcript = "I want to plan a trip") {
  const calls: Array<{ audio: Buffer; language?: string }> = [];
  const provider: SpeechToTextProvider = {
    id: "fake-stt",
    transcribe: vi.fn(async (audio: Buffer, opts: { language?: string }) => {
      calls.push({ audio, language: opts.language });
      return { text: transcript, confidence: 0.97 };
    }),
  };
  return { provider, calls };
}

function fakeTts() {
  const calls: Array<{ text: string; language?: string }> = [];
  const provider: TextToSpeechProvider = {
    id: "fake-tts",
    synthesize: vi.fn(async (text: string, opts: { language?: string }) => {
      calls.push({ text, language: opts.language });
      return { audio: Buffer.from(`AUDIO:${text}`), contentType: "audio/mpeg" };
    }),
  };
  return { provider, calls };
}

function fakeRunner(reply = "Ok, where are we going?") {
  const calls: Array<{ userId: number; scope: unknown; userText: string }> = [];
  const runTurn: VoiceTurnRunner = async (input) => {
    calls.push({ userId: input.userId, scope: input.scope, userText: input.userText });
    return { reply };
  };
  return { runTurn, calls };
}

const PENDING: PendingConfirmation = {
  attemptId: 42,
  tripId: 3,
  supplier: "United",
  kind: "flight",
  total: { amountMinor: 61200, currency: "USD" },
  reviewText: "Booking review — United (flight), attempt #42:\n   Total to be charged: $612.00",
};

function fakeGate(pending: PendingConfirmation[] = []) {
  const confirmCalls: Array<{ attemptId: number; userId: number }> = [];
  let currentPending = pending;
  const port: VoiceGatePort = {
    findPendingConfirmations: vi.fn(async () => currentPending),
    confirm: vi.fn(async (attemptId: number, actor: { userId: number }) => {
      confirmCalls.push({ attemptId, userId: actor.userId });
      currentPending = [];
      return {
        confirmed: true,
        reason: "Confirmed.",
        attempt: { id: attemptId, state: "confirmed" } as unknown as BookingAttempt,
        coverage: [],
      } as ConfirmResult;
    }),
  };
  return { port, confirmCalls };
}

function makeService(overrides: {
  providers?: VoiceProviders;
  runTurn?: VoiceTurnRunner;
  gate?: VoiceGatePort;
} = {}) {
  const stt = fakeStt();
  const tts = fakeTts();
  const runner = fakeRunner();
  const gate = fakeGate();
  let seq = 0;
  const service = new VoiceSessionService({
    providers: overrides.providers ?? { stt: stt.provider, tts: tts.provider },
    runTurn: overrides.runTurn ?? runner.runTurn,
    gate: overrides.gate ?? gate.port,
    newId: () => `id-${++seq}`,
  });
  return { service, stt, tts, runner, gate };
}

const TRIP_SCOPE = { kind: "trip", tripId: 3 } as const;

function makeSession(
  service: VoiceSessionService,
  overrides: { language?: string | null; scope?: typeof TRIP_SCOPE } = {},
) {
  return service.createSession({
    userId: 7,
    role: "traveler",
    scope: overrides.scope ?? TRIP_SCOPE,
    language: overrides.language === undefined ? "en-US" : overrides.language,
  });
}

// ─── Turns through the shared engine ─────────────────────────────────────────

describe("voice turns", () => {
  it("an audio turn is transcribed, run through the engine, and spoken back", async () => {
    const { service, stt, tts, runner } = makeService();
    const session = makeSession(service);

    const result = await service.submitTurn(session.id, {
      audioBase64: Buffer.from("raw-audio").toString("base64"),
      audioContentType: "audio/webm",
    });

    expect(stt.calls).toHaveLength(1);
    expect(stt.calls[0].audio.toString()).toBe("raw-audio");
    expect(result.heardText).toBe("I want to plan a trip");
    // The runner is the shared engine: same identity, same scope.
    expect(runner.calls).toEqual([
      { userId: 7, scope: { kind: "trip", tripId: 3 }, userText: "I want to plan a trip" },
    ]);
    expect(result.replyText).toBe("Ok, where are we going?");
    expect(result.speechText).toBe("Ok, where are we going?");
    expect(result.utterance?.state).toBe("speaking");
    expect(result.utterance?.audio?.toString()).toBe("AUDIO:Ok, where are we going?");
    expect(tts.calls[0].text).toBe("Ok, where are we going?");
    const types = result.events.map((e) => e.type);
    expect(types).toContain("turn_started");
    expect(types).toContain("speech_started");
    expect(types).toContain("turn_completed");
  });

  it("a text turn at the seam runs the same engine without touching STT", async () => {
    const { service, stt, runner } = makeService();
    const session = makeSession(service);
    const result = await service.submitTurn(session.id, { text: "Munich, in September" });
    expect(stt.calls).toHaveLength(0);
    expect(runner.calls[0].userText).toBe("Munich, in September");
    expect(result.heardText).toBe("Munich, in September");
  });

  it("voice and text turns share one conversation: same session, same scope, ordered history of events", async () => {
    const { service, runner } = makeService();
    const session = makeSession(service);
    await service.submitTurn(session.id, { audioBase64: Buffer.from("a").toString("base64") });
    await service.submitTurn(session.id, { text: "typed follow-up" });
    expect(runner.calls.map((c) => c.userText)).toEqual([
      "I want to plan a trip",
      "typed follow-up",
    ]);
    expect(runner.calls.every((c) => c.userId === 7)).toBe(true);
    // Both turns live in the one session log, in order.
    const started = session.events.filter((e) => e.type === "turn_started");
    expect(started.map((e) => e.data.heardText)).toEqual([
      "I want to plan a trip",
      "typed follow-up",
    ]);
  });

  it("an empty transcript runs NO turn and persists nothing — just a retry", async () => {
    const stt = fakeStt("   ");
    const { service, runner } = makeService({
      providers: { stt: stt.provider, tts: fakeTts().provider },
    });
    const session = makeSession(service);
    const result = await service.submitTurn(session.id, {
      audioBase64: Buffer.from("silence").toString("base64"),
    });
    expect(result.needsRetry).toBe(true);
    expect(result.message).toContain("didn't catch that");
    expect(result.replyText).toBeNull();
    expect(runner.calls).toHaveLength(0);
    expect(session.events.map((e) => e.type)).toContain("turn_retry");
  });

  it("an audio turn with STT unconfigured refuses plainly and runs no turn", async () => {
    const { service, runner } = makeService({ providers: { stt: null, tts: fakeTts().provider } });
    const session = makeSession(service);
    await expect(
      service.submitTurn(session.id, { audioBase64: Buffer.from("a").toString("base64") }),
    ).rejects.toMatchObject({ code: "stt_unconfigured", message: STT_UNCONFIGURED_MESSAGE });
    expect(runner.calls).toHaveLength(0);
  });

  it("with TTS unconfigured the reply still arrives — as text, with the gap on the record", async () => {
    const { service } = makeService({ providers: { stt: fakeStt().provider, tts: null } });
    const session = makeSession(service);
    const result = await service.submitTurn(session.id, { text: "hello" });
    expect(result.replyText).toBe("Ok, where are we going?");
    expect(result.utterance?.audio).toBeNull();
    expect(result.events.map((e) => e.type)).toContain("speech_unavailable");
  });

  it("isUnconfigured is true only when neither provider exists", () => {
    const { service } = makeService({ providers: { stt: null, tts: null } });
    expect(service.isUnconfigured()).toBe(true);
    const { service: partial } = makeService({
      providers: { stt: fakeStt().provider, tts: null },
    });
    expect(partial.isUnconfigured()).toBe(false);
    expect(partial.capabilities()).toEqual({ speechToText: true, textToSpeech: false });
  });
});

// ─── Language plumbing ───────────────────────────────────────────────────────

describe("language posture", () => {
  it("the session language flows to STT and TTS on every call", async () => {
    const { service, stt, tts } = makeService();
    const session = makeSession(service, { language: "de-DE" });
    await service.submitTurn(session.id, { audioBase64: Buffer.from("a").toString("base64") });
    expect(stt.calls[0].language).toBe("de-DE");
    expect(tts.calls[0].language).toBe("de-DE");
  });

  it("an unset session language passes undefined — providers use their own defaults", async () => {
    const { service, stt, tts } = makeService();
    const session = makeSession(service, { language: null });
    await service.submitTurn(session.id, { audioBase64: Buffer.from("a").toString("base64") });
    expect(stt.calls[0].language).toBeUndefined();
    expect(tts.calls[0].language).toBeUndefined();
  });
});

// ─── Barge-in ────────────────────────────────────────────────────────────────

describe("barge-in", () => {
  it("a new turn supersedes in-flight speech: the old utterance is cancelled first", async () => {
    const { service } = makeService();
    const session = makeSession(service);
    const first = await service.submitTurn(session.id, { text: "first" });
    const firstUtterance = first.utterance!;
    expect(firstUtterance.state).toBe("speaking");

    const second = await service.submitTurn(session.id, { text: "second" });
    expect(firstUtterance.state).toBe("cancelled");
    const cancelEvent = second.events.find((e) => e.type === "speech_cancelled");
    expect(cancelEvent?.data.utteranceId).toBe(firstUtterance.id);
    // Cancellation precedes the new turn's start in the log.
    const types = session.events.map((e) => e.type);
    expect(types.indexOf("speech_cancelled")).toBeLessThan(
      types.lastIndexOf("turn_started"),
    );
    expect(second.utterance?.state).toBe("speaking");
  });

  it("an explicit interrupt cancels in-flight speech; ack marks playback done", async () => {
    const { service } = makeService();
    const session = makeSession(service);
    const first = await service.submitTurn(session.id, { text: "first" });
    const { cancelled } = service.interrupt(session.id);
    expect(cancelled.map((u) => u.id)).toEqual([first.utterance!.id]);

    const second = await service.submitTurn(session.id, { text: "second" });
    const acked = service.ackSpeech(session.id, second.utterance!.id);
    expect(acked.state).toBe("done");
    // Nothing left in flight: a further interrupt cancels nothing.
    expect(service.interrupt(session.id).cancelled).toHaveLength(0);
  });
});

// ─── Pending confirmations + screen confirm ──────────────────────────────────

describe("pending confirmations (voice proposes, screen confirms)", () => {
  it("a turn that leaves a booking in REVIEW surfaces the pending-confirmation record", async () => {
    const gate = fakeGate([PENDING]);
    const { service } = makeService({ gate: gate.port });
    const session = makeSession(service);
    const result = await service.submitTurn(session.id, { text: "book the first one" });
    expect(result.pendingConfirmations).toEqual([PENDING]);
    const event = result.events.find((e) => e.type === "pending_confirmation");
    expect(event?.data.confirmations).toEqual([PENDING]);
  });

  it("no pending confirmations → no event, empty list (no noise)", async () => {
    const { service } = makeService();
    const session = makeSession(service);
    const result = await service.submitTurn(session.id, { text: "hello" });
    expect(result.pendingConfirmations).toEqual([]);
    expect(result.events.map((e) => e.type)).not.toContain("pending_confirmation");
  });

  it("confirmOnScreen calls the gate's confirm path for the session's own actor and reports the outcome", async () => {
    const gate = fakeGate([PENDING]);
    const { service } = makeService({ gate: gate.port });
    const session = makeSession(service);
    const { result, pendingConfirmations, events } = await service.confirmOnScreen(session.id, 42);
    expect(gate.confirmCalls).toEqual([{ attemptId: 42, userId: 7 }]);
    expect(result.confirmed).toBe(true);
    expect(result.attempt.state).toBe("confirmed");
    expect(pendingConfirmations).toEqual([]);
    expect(events.map((e) => e.type)).toContain("confirmation_updated");
  });

  it("confirmOnScreen refuses an attempt that is not pending on this session's trip", async () => {
    const gate = fakeGate([PENDING]);
    const { service } = makeService({ gate: gate.port });
    const session = makeSession(service);
    await expect(service.confirmOnScreen(session.id, 999)).rejects.toBeInstanceOf(
      VoiceSessionError,
    );
    expect(gate.confirmCalls).toHaveLength(0);
  });
});

// ─── Scope continuity ────────────────────────────────────────────────────────

describe("scope continuity", () => {
  it("intake materialization moves the session to the new trip scope", async () => {
    const runner: VoiceTurnRunner = async () => ({ reply: "Your trip is on the board.", tripId: 11 });
    const { service } = makeService({ runTurn: runner });
    const session = service.createSession({
      userId: 7,
      role: "traveler",
      scope: { kind: "intake", intakeSessionId: 5 },
      language: null,
    });
    const result = await service.submitTurn(session.id, { text: "that's everything" });
    expect(session.scope).toEqual({ kind: "trip", tripId: 11 });
    expect(result.scope).toEqual({ kind: "trip", tripId: 11 });
    expect(result.events.map((e) => e.type)).toContain("scope_changed");
  });
});
