/**
 * Voice Session Service — the Voice Gateway's server-side core
 * (architecture-north-star §2.4; Stories 2.1–2.3).
 *
 * A voice session is a CHANNEL ADAPTER over the one Marco conversation
 * engine, never a second agent: a session holds only transport state
 * (the speech queue, the session's scope and language, an event log).
 * All conversation state — history, intake machine, memory — lives in
 * the shared conversation services behind the injected turn runner
 * (routes/agent's runChatTurn), which is the same code path the text
 * chat endpoints run. A conversation started by voice therefore
 * continues in text with full history, and vice versa, structurally.
 *
 * Sessions are process-local and disposable: if a session dies, the
 * traveler opens a new one on the same scope and loses nothing but
 * the un-played speech queue — the conversation itself is server-side.
 *
 * Money discipline (§2.4, §5.2): voice may present options and totals,
 * but a booking confirmation can never complete on this channel. When
 * a turn leaves a booking attempt in REVIEW, the session surfaces a
 * pending-confirmation record (the exact review text the screen
 * shows) and the client renders it; confirmation happens through
 * confirmOnScreen below, which calls the Booking Gate's existing
 * confirm path as a screen (text-channel) act. Inside the agent loop,
 * the gate itself refuses voice-channel confirmations — see
 * BookingGate.confirmAttempt — so a spoken "yes, book it" changes no
 * gate state even if the model tries to act on it.
 */

import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, bookingAttemptsTable, usersTable } from "@workspace/db";
import { formatReviewText } from "./agentBookingTools";
import {
  getDefaultBookingGate,
  type BookingGate,
  type ConfirmResult,
} from "./bookingGate";
import { renderSpeechText } from "./voiceRendering";
import type { VoiceProviders } from "./voiceProviders";
import { logger } from "./logger";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Conversation scope — the same trip-or-intake union the chat uses. */
export type VoiceScope =
  | { kind: "trip"; tripId: number }
  | { kind: "intake"; intakeSessionId: number };

export interface VoiceTurnRunnerInput {
  userId: number;
  role: string;
  agentId?: string;
  scope: VoiceScope;
  userText: string;
}

/**
 * Runs one conversation turn through the shared engine. The route
 * layer wires this to runChatTurn (routes/agent.ts) with
 * channel: "voice"; tests inject fakes.
 */
export type VoiceTurnRunner = (input: VoiceTurnRunnerInput) => Promise<{
  reply: string;
  /** Intake scope: set when the turn materialized a draft trip. */
  tripId?: number;
}>;

/** A booking awaiting on-screen confirmation, as the client renders it. */
export interface PendingConfirmation {
  attemptId: number;
  tripId: number;
  supplier: string;
  kind: string;
  /** The reviewed total (charge currency) the traveler is confirming. */
  total: { amountMinor: number; currency: string };
  /** The exact review surface text — what the screen shows is what
   * Marco voiced (rendered through the same review formatter). */
  reviewText: string;
}

/**
 * The slice of the Booking Gate the voice channel needs. The default
 * implementation (createBookingGateVoicePort) wraps the real gate;
 * tests inject fakes.
 */
export interface VoiceGatePort {
  findPendingConfirmations(
    actor: { userId: number; role: string },
    tripId: number,
  ): Promise<PendingConfirmation[]>;
  /** The gate's existing confirm path, invoked as a SCREEN act. */
  confirm(
    attemptId: number,
    actor: { userId: number; role: string },
  ): Promise<ConfirmResult>;
}

export type UtteranceState = "speaking" | "queued" | "done" | "cancelled";

export interface VoiceUtterance {
  id: string;
  /** The speech-rendered text that was synthesized. */
  text: string;
  state: UtteranceState;
  /** Synthesized audio (in-memory; served by the utterance endpoint).
   * Null when TTS is unconfigured — the reply still arrived as text. */
  audio: Buffer | null;
  audioContentType: string | null;
  createdAt: Date;
}

export interface VoiceSessionEvent {
  seq: number;
  type: string;
  at: string;
  data: Record<string, unknown>;
}

export interface VoiceSession {
  id: string;
  userId: number;
  role: string;
  agentId?: string;
  scope: VoiceScope;
  /** BCP 47 tag from the traveler's profile (users.conversation_language). */
  language: string | null;
  createdAt: Date;
  utterances: VoiceUtterance[];
  events: VoiceSessionEvent[];
}

export type VoiceSessionEventListener = (event: VoiceSessionEvent) => void;

export class VoiceSessionError extends Error {
  constructor(
    readonly code:
      | "session_not_found"
      | "stt_unconfigured"
      | "stt_failed"
      | "empty_transcript"
      | "no_speech"
      | "utterance_not_found"
      | "no_pending_confirmation",
    message: string,
  ) {
    super(message);
    this.name = "VoiceSessionError";
  }
}

export const STT_UNCONFIGURED_MESSAGE =
  "Voice input isn't configured on this server yet, so audio can't be transcribed. " +
  "Type your message instead — the planning conversation works exactly the same.";

export const TTS_UNAVAILABLE_NOTE =
  "Voice replies aren't configured on this server yet, so this answer is text-only.";

// ─── The service ─────────────────────────────────────────────────────────────

export interface VoiceSessionDeps {
  /** Providers, or a thunk resolving them per call (the route layer
   * passes the env-backed getter so test seams apply live). */
  providers: VoiceProviders | (() => VoiceProviders);
  runTurn: VoiceTurnRunner;
  gate: VoiceGatePort;
  now?: () => Date;
  newId?: () => string;
}

export interface SubmitTurnInput {
  text?: string;
  audioBase64?: string;
  audioContentType?: string;
}

export interface SubmitTurnResult {
  /** What the traveler said, as text (transcribed when audio). */
  heardText: string | null;
  /** True when STT heard nothing intelligible: no agent turn ran,
   * nothing was persisted — the traveler just retries. */
  needsRetry: boolean;
  /** Channel-level copy for the retry case (not a Marco reply). */
  message: string | null;
  replyText: string | null;
  speechText: string | null;
  utterance: VoiceUtterance | null;
  pendingConfirmations: PendingConfirmation[];
  scope: VoiceScope;
  /** Events this call emitted (also in the session log / SSE stream). */
  events: VoiceSessionEvent[];
}

export class VoiceSessionService {
  private readonly deps: VoiceSessionDeps;
  private readonly sessions = new Map<string, VoiceSession>();
  private readonly listeners = new Map<string, Set<VoiceSessionEventListener>>();
  /** Per-session turn serialization: one agent turn at a time. */
  private readonly turnChains = new Map<string, Promise<unknown>>();

  constructor(deps: VoiceSessionDeps) {
    this.deps = deps;
  }

  private providers(): VoiceProviders {
    return typeof this.deps.providers === "function"
      ? (this.deps.providers as () => VoiceProviders)()
      : this.deps.providers;
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  private newId(): string {
    return this.deps.newId ? this.deps.newId() : randomUUID();
  }

  // ── Session lifecycle ─────────────────────────────────────────────────────

  createSession(input: {
    userId: number;
    role: string;
    agentId?: string;
    scope: VoiceScope;
    language: string | null;
  }): VoiceSession {
    const session: VoiceSession = {
      id: this.newId(),
      userId: input.userId,
      role: input.role,
      agentId: input.agentId,
      scope: input.scope,
      language: input.language,
      createdAt: this.now(),
      utterances: [],
      events: [],
    };
    this.sessions.set(session.id, session);
    this.emit(session, "session_created", {
      scope: session.scope,
      language: session.language,
      capabilities: this.capabilities(),
    });
    return session;
  }

  getSession(sessionId: string): VoiceSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.listeners.delete(sessionId);
    this.turnChains.delete(sessionId);
  }

  /** Which speech directions are live, from the current providers. */
  capabilities(): { speechToText: boolean; textToSpeech: boolean } {
    const p = this.providers();
    return { speechToText: p.stt !== null, textToSpeech: p.tts !== null };
  }

  /** True when NO speech provider is configured at all. */
  isUnconfigured(): boolean {
    const c = this.capabilities();
    return !c.speechToText && !c.textToSpeech;
  }

  // ── Events ────────────────────────────────────────────────────────────────

  private emit(
    session: VoiceSession,
    type: string,
    data: Record<string, unknown>,
  ): VoiceSessionEvent {
    const event: VoiceSessionEvent = {
      seq: session.events.length + 1,
      type,
      at: this.now().toISOString(),
      data,
    };
    session.events.push(event);
    const subs = this.listeners.get(session.id);
    if (subs) {
      for (const fn of subs) {
        try {
          fn(event);
        } catch {
          // A broken listener never breaks the session.
        }
      }
    }
    return event;
  }

  eventsSince(session: VoiceSession, sinceSeq: number): VoiceSessionEvent[] {
    return session.events.filter((e) => e.seq > sinceSeq);
  }

  subscribe(sessionId: string, fn: VoiceSessionEventListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  // ── Speech queue / barge-in ───────────────────────────────────────────────

  /**
   * Cancel every utterance still in flight (speaking or queued).
   * Barge-in (§2.4 / Story 2.2): the traveler started talking — Marco
   * stops and listens. Returns the cancelled utterances.
   */
  private cancelInFlightSpeech(
    session: VoiceSession,
    collected?: VoiceSessionEvent[],
  ): VoiceUtterance[] {
    const cancelled: VoiceUtterance[] = [];
    for (const u of session.utterances) {
      if (u.state === "speaking" || u.state === "queued") {
        u.state = "cancelled";
        cancelled.push(u);
        const event = this.emit(session, "speech_cancelled", { utteranceId: u.id });
        collected?.push(event);
      }
    }
    return cancelled;
  }

  /** Explicit barge-in from the client (the traveler tapped/started
   * speaking while Marco was mid-reply). */
  interrupt(sessionId: string): { cancelled: VoiceUtterance[]; events: VoiceSessionEvent[] } {
    const session = this.requireSession(sessionId);
    const events: VoiceSessionEvent[] = [];
    const cancelled = this.cancelInFlightSpeech(session, events);
    return { cancelled, events };
  }

  /** The client finished playing an utterance. */
  ackSpeech(sessionId: string, utteranceId: string): VoiceUtterance {
    const session = this.requireSession(sessionId);
    const utterance = session.utterances.find((u) => u.id === utteranceId);
    if (!utterance) {
      throw new VoiceSessionError("utterance_not_found", `No utterance ${utteranceId} in this session.`);
    }
    if (utterance.state === "speaking" || utterance.state === "queued") {
      utterance.state = "done";
      this.emit(session, "speech_finished", { utteranceId });
    }
    return utterance;
  }

  getUtterance(sessionId: string, utteranceId: string): VoiceUtterance | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return session.utterances.find((u) => u.id === utteranceId) ?? null;
  }

  // ── Turns ─────────────────────────────────────────────────────────────────

  private requireSession(sessionId: string): VoiceSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new VoiceSessionError("session_not_found", `Voice session ${sessionId} not found.`);
    }
    return session;
  }

  /**
   * Submit one traveler turn (audio or text at the seam) and run it
   * through the shared conversation engine. Serialized per session.
   */
  async submitTurn(sessionId: string, input: SubmitTurnInput): Promise<SubmitTurnResult> {
    const session = this.requireSession(sessionId);
    const prior = this.turnChains.get(sessionId) ?? Promise.resolve();
    const run = prior.then(() => this.submitTurnInner(session, input));
    // The chain itself must never reject (a failed turn doesn't jam the queue).
    this.turnChains.set(
      sessionId,
      run.catch(() => undefined),
    );
    return run;
  }

  private async submitTurnInner(
    session: VoiceSession,
    input: SubmitTurnInput,
  ): Promise<SubmitTurnResult> {
    const events: VoiceSessionEvent[] = [];
    const collect = (e: VoiceSessionEvent) => {
      events.push(e);
      return e;
    };

    // Barge-in: a new turn supersedes any in-flight speech before
    // anything else happens — Marco stops talking and listens.
    this.cancelInFlightSpeech(session, events);

    // ── Resolve the traveler's words ──────────────────────────────────────
    let heardText: string;
    let heardConfidence: number | undefined;
    if (input.audioBase64 !== undefined) {
      const { stt } = this.providers();
      if (!stt) {
        throw new VoiceSessionError("stt_unconfigured", STT_UNCONFIGURED_MESSAGE);
      }
      const audio = Buffer.from(input.audioBase64, "base64");
      let result;
      try {
        result = await stt.transcribe(audio, {
          language: session.language ?? undefined,
          contentType: input.audioContentType,
        });
      } catch (err) {
        throw new VoiceSessionError(
          "stt_failed",
          `Transcription failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      heardText = result.text;
      heardConfidence = result.confidence;
      if (heardText.trim().length === 0) {
        // Nothing intelligible: no agent turn runs, nothing persists.
        collect(this.emit(session, "turn_retry", { reason: "empty_transcript" }));
        return {
          heardText: null,
          needsRetry: true,
          message: "I didn't catch that — could you say it again?",
          replyText: null,
          speechText: null,
          utterance: null,
          pendingConfirmations: [],
          scope: session.scope,
          events,
        };
      }
    } else if (typeof input.text === "string" && input.text.trim().length > 0) {
      heardText = input.text;
    } else {
      throw new VoiceSessionError(
        "empty_transcript",
        "A voice turn needs audio or text — this one carried neither.",
      );
    }

    collect(
      this.emit(session, "turn_started", {
        heardText,
        ...(heardConfidence !== undefined ? { confidence: heardConfidence } : {}),
      }),
    );

    // ── The shared engine (channel: voice) ────────────────────────────────
    const turn = await this.deps.runTurn({
      userId: session.userId,
      role: session.role,
      agentId: session.agentId,
      scope: session.scope,
      userText: heardText,
    });

    // Intake materialization moves the conversation to the new trip —
    // the session follows it, exactly like the text UI swaps scope.
    if (session.scope.kind === "intake" && typeof turn.tripId === "number") {
      session.scope = { kind: "trip", tripId: turn.tripId };
      collect(this.emit(session, "scope_changed", { scope: session.scope }));
    }

    // ── Speak the reply (same text, speech-rendered) ──────────────────────
    const speechText = renderSpeechText(turn.reply);
    const { tts } = this.providers();
    let audio: Buffer | null = null;
    let audioContentType: string | null = null;
    if (tts) {
      try {
        const synth = await tts.synthesize(speechText, {
          language: session.language ?? undefined,
        });
        audio = synth.audio;
        audioContentType = synth.contentType;
      } catch (err) {
        // A TTS failure must not eat the answer: the reply stands as
        // text and the failure is on the record.
        logger.warn({ sessionId: session.id, err }, "[Voice] TTS failed — reply delivered as text");
        collect(
          this.emit(session, "speech_unavailable", {
            reason: "Synthesis failed; the reply is text-only this turn.",
          }),
        );
      }
    } else {
      collect(this.emit(session, "speech_unavailable", { reason: TTS_UNAVAILABLE_NOTE }));
    }

    const utterance: VoiceUtterance = {
      id: this.newId(),
      text: speechText,
      state: "speaking",
      audio,
      audioContentType,
      createdAt: this.now(),
    };
    session.utterances.push(utterance);
    collect(
      this.emit(session, "speech_started", {
        utteranceId: utterance.id,
        hasAudio: audio !== null,
      }),
    );

    // ── Surface any booking now awaiting on-screen confirmation ──────────
    const pendingConfirmations = await this.refreshPendingConfirmations(session, events);

    collect(
      this.emit(session, "turn_completed", {
        utteranceId: utterance.id,
        replyText: turn.reply,
      }),
    );

    return {
      heardText,
      needsRetry: false,
      message: null,
      replyText: turn.reply,
      speechText,
      utterance,
      pendingConfirmations,
      scope: session.scope,
      events,
    };
  }

  /**
   * Re-read the gate for attempts in REVIEW on the session's trip and,
   * when the set is non-empty, emit the pending_confirmation event the
   * client renders as the on-screen review card. Best-effort: a gate
   * read failure never fails a completed conversation turn.
   */
  private async refreshPendingConfirmations(
    session: VoiceSession,
    collected?: VoiceSessionEvent[],
  ): Promise<PendingConfirmation[]> {
    if (session.scope.kind !== "trip") return [];
    let pending: PendingConfirmation[] = [];
    try {
      pending = await this.deps.gate.findPendingConfirmations(
        { userId: session.userId, role: session.role },
        session.scope.tripId,
      );
    } catch (err) {
      logger.warn({ sessionId: session.id, err }, "[Voice] pending-confirmation lookup failed");
      return [];
    }
    if (pending.length > 0) {
      const event = this.emit(session, "pending_confirmation", {
        confirmations: pending,
      });
      collected?.push(event);
    }
    return pending;
  }

  // ── Screen confirmation ───────────────────────────────────────────────────

  /**
   * The on-screen confirmation act. The traveler tapped Confirm on the
   * review card the client rendered from a pending-confirmation
   * record; this calls the Booking Gate's existing confirm path as a
   * screen act (no voice channel involved) and reports the outcome so
   * the voice conversation can proceed ("it's confirmed — shall I book
   * it?" is now a question the traveler can answer by voice, because
   * execution from CONFIRMED is a separate, re-verified step).
   */
  async confirmOnScreen(
    sessionId: string,
    attemptId: number,
  ): Promise<{ result: ConfirmResult; pendingConfirmations: PendingConfirmation[]; events: VoiceSessionEvent[] }> {
    const session = this.requireSession(sessionId);
    if (session.scope.kind !== "trip") {
      throw new VoiceSessionError(
        "no_pending_confirmation",
        "This conversation has no trip yet, so there is nothing to confirm.",
      );
    }
    // Bind the screen act to THIS session's trip: the attempt must be
    // one of the pending confirmations the session surfaced.
    const pending = await this.deps.gate.findPendingConfirmations(
      { userId: session.userId, role: session.role },
      session.scope.tripId,
    );
    if (!pending.some((p) => p.attemptId === attemptId)) {
      throw new VoiceSessionError(
        "no_pending_confirmation",
        `Booking attempt ${attemptId} is not awaiting confirmation on this trip.`,
      );
    }
    const result = await this.deps.gate.confirm(attemptId, {
      userId: session.userId,
      role: session.role,
    });
    const events: VoiceSessionEvent[] = [
      this.emit(session, "confirmation_updated", {
        attemptId,
        confirmed: result.confirmed,
        reason: result.reason,
        state: result.attempt.state,
      }),
    ];
    const remaining = await this.refreshPendingConfirmations(session, events);
    return { result, pendingConfirmations: remaining, events };
  }
}

// ─── Default gate port (wraps the real Booking Gate) ─────────────────────────

export function createBookingGateVoicePort(
  gate: BookingGate = getDefaultBookingGate(),
): VoiceGatePort {
  return {
    async findPendingConfirmations(actor, tripId) {
      const rows = await db
        .select()
        .from(bookingAttemptsTable)
        .where(
          and(
            eq(bookingAttemptsTable.tripId, tripId),
            eq(bookingAttemptsTable.state, "review"),
          ),
        );
      const out: PendingConfirmation[] = [];
      for (const row of [...rows].sort((a, b) => a.id - b.id)) {
        try {
          // getAttemptView enforces the actor's trip access per attempt.
          const { attempt, coverage } = await gate.getAttemptView(row.id, actor);
          if (attempt.state !== "review") continue;
          out.push({
            attemptId: attempt.id,
            tripId: attempt.tripId,
            supplier: attempt.supplier,
            kind: attempt.kind,
            total: {
              amountMinor: attempt.reviewedAmountMinor ?? attempt.presentedAmountMinor,
              currency: attempt.reviewedCurrency ?? attempt.presentedCurrency,
            },
            reviewText: formatReviewText(attempt, coverage),
          });
        } catch {
          // Not visible to this actor — not their confirmation to make.
        }
      }
      return out;
    },
    async confirm(attemptId, actor) {
      // A screen act: the text/UI trust class. No channel is passed, so
      // the gate's voice refusal does not apply — deliberately.
      return gate.confirmAttempt(attemptId, { ...actor, channel: "text" });
    },
  };
}

// ─── Traveler language ───────────────────────────────────────────────────────

/**
 * The traveler's conversation language (users.conversation_language,
 * BCP 47) — the language Marco speaks with this traveler. Null when
 * unset: providers then fall back to their own defaults and no
 * language is invented.
 */
export async function loadConversationLanguage(userId: number): Promise<string | null> {
  const [row] = await db
    .select({ conversationLanguage: usersTable.conversationLanguage })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return row?.conversationLanguage ?? null;
}
