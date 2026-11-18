/**
 * Voice Gateway — HTTP surface (architecture-north-star §2.4).
 *
 * The voice channel adapter over the one Marco conversation engine.
 * A voice session is transport state only (see lib/voiceSession.ts);
 * every turn runs through routes/agent's runChatTurn — the same code
 * path as POST /agent/chat — so voice and text are one conversation.
 *
 * Transport (spike): the server's established streaming idiom is HTTP
 * + SSE (see /agent/chat/stream); there is no WebSocket library in
 * this stack, so the session protocol is:
 *
 *   POST /agent/voice/sessions                  create a session on a
 *                                               trip or intake scope
 *   GET  /agent/voice/sessions/:id              session view
 *   POST /agent/voice/sessions/:id/turns        one traveler turn:
 *                                               { text } at the seam, or
 *                                               { audioBase64, audioContentType }
 *   POST /agent/voice/sessions/:id/interrupt    barge-in: stop speech
 *   POST /agent/voice/sessions/:id/speech-ack   client finished playing
 *   POST /agent/voice/sessions/:id/confirm      SCREEN confirmation of a
 *                                               pending booking { attemptId }
 *   GET  /agent/voice/sessions/:id/events       SSE: session events
 *                                               (replay with ?since=seq)
 *   GET  /agent/voice/sessions/:id/utterances/:utteranceId/audio
 *                                               synthesized reply audio
 *   DELETE /agent/voice/sessions/:id            close the session
 *
 * The protocol shapes (turn in → reply text + speech text + utterance
 * + pending confirmations out; events for speech lifecycle and
 * confirmation updates) are transport-shaped on purpose: a WebSocket
 * or Capacitor-native transport can carry the same messages later
 * without touching the session service or the engine.
 *
 * Unconfigured speech providers refuse PLAINLY: with no STT and no
 * TTS keys the session endpoint answers 503 and says text chat works
 * as usual. Nothing is ever faked — no invented transcripts, no
 * silent audio. Live provider verification awaits the API keys.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { db, tripsTable } from "@workspace/db";
import { requireAuth, getAuthUserId, getAuthRole } from "../middlewares/auth";
import { logger } from "../lib/logger";
import {
  VoiceSessionService,
  VoiceSessionError,
  createBookingGateVoicePort,
  loadConversationLanguage,
  type VoiceScope,
  type VoiceSession,
  type VoiceUtterance,
} from "../lib/voiceSession";
import { getVoiceProviders } from "../lib/voiceProviders";
import {
  BookingAccessDenied,
  BookingNotFound,
} from "../lib/bookingGate";
import {
  runChatTurn,
  assertTripAccess,
  ChatContextError,
  type ChatScope,
} from "./agent";
import { assertIntakeAccess, loadIntakeSession } from "../lib/intake";

// ─── Service assembly (the route layer wires the real engine in) ─────────────

let defaultService: VoiceSessionService | null = null;
let testService: VoiceSessionService | null | undefined;

function getVoiceSessionService(): VoiceSessionService {
  if (testService !== undefined) {
    if (!testService) throw new Error("voice session service disabled in tests");
    return testService;
  }
  if (!defaultService) {
    defaultService = new VoiceSessionService({
      // A thunk, so the providers test seam applies without rebuilding
      // the service.
      providers: () => getVoiceProviders(),
      runTurn: (input) =>
        runChatTurn({
          userId: input.userId,
          role: input.role,
          agentId: input.agentId,
          scope: input.scope as ChatScope,
          userText: input.userText,
          channel: "voice",
          ...(input.asrConfidence !== undefined
            ? { asrConfidence: input.asrConfidence }
            : {}),
        }),
      gate: createBookingGateVoicePort(),
    });
  }
  return defaultService;
}

/** Test seam: swap the session service (null restores the default). */
export function setVoiceSessionServiceForTests(service: VoiceSessionService | null): void {
  testService = service === null ? undefined : service;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VOICE_UNCONFIGURED_MESSAGE =
  "Voice isn't configured on this server yet — no speech providers are set up. " +
  "Text chat works exactly the same; use that for now.";

function utteranceView(session: VoiceSession, u: VoiceUtterance) {
  return {
    id: u.id,
    state: u.state,
    text: u.text,
    audioUrl:
      u.audio !== null
        ? `/api/agent/voice/sessions/${session.id}/utterances/${u.id}/audio`
        : null,
    audioContentType: u.audioContentType,
  };
}

function sessionView(session: VoiceSession) {
  return {
    sessionId: session.id,
    scope: session.scope,
    language: session.language,
    createdAt: session.createdAt.toISOString(),
    utterances: session.utterances.map((u) => utteranceView(session, u)),
  };
}

/** Load a session and enforce ownership (owner or super_admin). */
function loadOwnedSession(
  req: Request,
  res: Response,
): { session: VoiceSession; userId: number; role: string } | null {
  const userId = getAuthUserId(req, res);
  const role = getAuthRole(req, res) ?? "";
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  const session = getVoiceSessionService().getSession(String(req.params.id));
  if (!session) {
    res.status(404).json({ error: `Voice session ${req.params.id} not found` });
    return null;
  }
  if (session.userId !== userId && role !== "super_admin") {
    res.status(403).json({ error: "That voice session belongs to another traveler" });
    return null;
  }
  return { session, userId, role };
}

function sendServiceError(res: Response, err: unknown): void {
  if (err instanceof VoiceSessionError) {
    const status =
      err.code === "session_not_found" || err.code === "utterance_not_found"
        ? 404
        : err.code === "stt_unconfigured"
          ? 503
          : err.code === "stt_failed"
            ? 502
            : err.code === "no_pending_confirmation"
              ? 409
              : 400;
    res.status(status).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof ChatContextError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof BookingNotFound) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof BookingAccessDenied) {
    res.status(403).json({ error: err.message });
    return;
  }
  logger.error({ err }, "[Voice] request failed");
  res.status(502).json({
    error: "Voice request failed",
    detail: err instanceof Error ? err.message : String(err),
  });
}

// ─── Router ──────────────────────────────────────────────────────────────────

const router: IRouter = Router();

/** Create a voice session on a trip or intake scope. Auth required;
 * the caller must be a trip participant / the intake owner. */
router.post("/agent/voice/sessions", requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req, res);
  const role = getAuthRole(req, res) ?? "";
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const body = (req.body ?? {}) as {
    tripId?: unknown;
    intakeSessionId?: unknown;
    agentId?: unknown;
  };
  const hasTrip = typeof body.tripId === "number" && Number.isInteger(body.tripId) && body.tripId > 0;
  const hasIntake =
    typeof body.intakeSessionId === "number" &&
    Number.isInteger(body.intakeSessionId) &&
    body.intakeSessionId > 0;
  if (hasTrip === hasIntake) {
    res.status(400).json({
      error: "Invalid body: expected exactly one of { tripId } or { intakeSessionId }",
    });
    return;
  }

  const service = getVoiceSessionService();
  if (service.isUnconfigured()) {
    res.status(503).json({ error: VOICE_UNCONFIGURED_MESSAGE });
    return;
  }

  const scope: VoiceScope = hasTrip
    ? { kind: "trip", tripId: body.tripId as number }
    : { kind: "intake", intakeSessionId: body.intakeSessionId as number };

  try {
    if (scope.kind === "trip") {
      const [trip] = await db
        .select({ id: tripsTable.id })
        .from(tripsTable)
        .where(eq(tripsTable.id, scope.tripId));
      if (!trip) {
        res.status(404).json({ error: `Trip ${scope.tripId} not found` });
        return;
      }
      await assertTripAccess(userId, role, scope.tripId);
    } else {
      const view = await loadIntakeSession(scope.intakeSessionId);
      if (!view) {
        res.status(404).json({ error: `Intake session ${scope.intakeSessionId} not found` });
        return;
      }
      await assertIntakeAccess(userId, role, scope.intakeSessionId);
    }
  } catch (err) {
    if (err instanceof Error && (err.name === "TripAccessDenied" || err.name === "IntakeAccessDenied")) {
      res.status(403).json({ error: err.message });
      return;
    }
    logger.error({ userId, err }, "[Voice] session scope check failed");
    res.status(500).json({ error: "Failed to start voice session" });
    return;
  }

  let language: string | null = null;
  try {
    language = await loadConversationLanguage(userId);
  } catch (err) {
    // Language is a posture, not a gate: a failed read leaves the
    // session language unset (provider defaults), never blocks voice.
    logger.warn({ userId, err }, "[Voice] conversation language load failed — continuing unset");
  }

  const session = service.createSession({
    userId,
    role,
    agentId: typeof body.agentId === "string" ? body.agentId : undefined,
    scope,
    language,
  });
  res.status(201).json({
    ...sessionView(session),
    capabilities: service.capabilities(),
  });
});

/** Session view (scope, language, speech queue). */
router.get("/agent/voice/sessions/:id", requireAuth, (req: Request, res: Response) => {
  const owned = loadOwnedSession(req, res);
  if (!owned) return;
  res.json({
    ...sessionView(owned.session),
    capabilities: getVoiceSessionService().capabilities(),
  });
});

/** Close a session (transport state only — the conversation persists). */
router.delete("/agent/voice/sessions/:id", requireAuth, (req: Request, res: Response) => {
  const owned = loadOwnedSession(req, res);
  if (!owned) return;
  getVoiceSessionService().closeSession(owned.session.id);
  res.status(204).end();
});

/**
 * One traveler turn. Body: { text } (transcribed-turn payload at the
 * seam) or { audioBase64, audioContentType? }. A new turn supersedes
 * any in-flight speech (barge-in).
 */
router.post("/agent/voice/sessions/:id/turns", requireAuth, async (req: Request, res: Response) => {
  const owned = loadOwnedSession(req, res);
  if (!owned) return;
  const body = (req.body ?? {}) as {
    text?: unknown;
    audioBase64?: unknown;
    audioContentType?: unknown;
  };
  const hasText = typeof body.text === "string" && (body.text as string).trim().length > 0;
  const hasAudio = typeof body.audioBase64 === "string" && (body.audioBase64 as string).length > 0;
  if (hasText === hasAudio) {
    res.status(400).json({
      error: "Invalid body: provide exactly one of { text } or { audioBase64, audioContentType? }",
    });
    return;
  }
  try {
    const result = await getVoiceSessionService().submitTurn(owned.session.id, {
      ...(hasText ? { text: body.text as string } : {}),
      ...(hasAudio
        ? {
            audioBase64: body.audioBase64 as string,
            ...(typeof body.audioContentType === "string"
              ? { audioContentType: body.audioContentType }
              : {}),
          }
        : {}),
    });
    res.json({
      heardText: result.heardText,
      needsRetry: result.needsRetry,
      message: result.message,
      reply: result.replyText,
      speechText: result.speechText,
      utterance: result.utterance ? utteranceView(owned.session, result.utterance) : null,
      pendingConfirmations: result.pendingConfirmations,
      scope: result.scope,
      events: result.events,
    });
  } catch (err) {
    sendServiceError(res, err);
  }
});

/** Barge-in: stop any in-flight speech and listen. */
router.post("/agent/voice/sessions/:id/interrupt", requireAuth, (req: Request, res: Response) => {
  const owned = loadOwnedSession(req, res);
  if (!owned) return;
  try {
    const { cancelled } = getVoiceSessionService().interrupt(owned.session.id);
    res.json({ cancelledUtteranceIds: cancelled.map((u) => u.id) });
  } catch (err) {
    sendServiceError(res, err);
  }
});

/** The client finished playing an utterance. */
router.post("/agent/voice/sessions/:id/speech-ack", requireAuth, (req: Request, res: Response) => {
  const owned = loadOwnedSession(req, res);
  if (!owned) return;
  const utteranceId = (req.body as { utteranceId?: unknown })?.utteranceId;
  if (typeof utteranceId !== "string" || utteranceId.length === 0) {
    res.status(400).json({ error: "Invalid body: expected { utteranceId }" });
    return;
  }
  try {
    const utterance = getVoiceSessionService().ackSpeech(owned.session.id, utteranceId);
    res.json({ utteranceId: utterance.id, state: utterance.state });
  } catch (err) {
    sendServiceError(res, err);
  }
});

/**
 * SCREEN confirmation of a pending booking. This is the confirmation
 * act the money discipline hangs on (§5.2): it calls the Booking
 * Gate's existing confirm path as a screen act. Voice turns never
 * reach this handler — a spoken "yes" goes through the agent loop,
 * where the gate refuses voice-channel confirmations.
 */
router.post("/agent/voice/sessions/:id/confirm", requireAuth, async (req: Request, res: Response) => {
  const owned = loadOwnedSession(req, res);
  if (!owned) return;
  const attemptId = (req.body as { attemptId?: unknown })?.attemptId;
  if (typeof attemptId !== "number" || !Number.isInteger(attemptId) || attemptId <= 0) {
    res.status(400).json({ error: "Invalid body: expected { attemptId: <positive int> }" });
    return;
  }
  try {
    const { result, pendingConfirmations } = await getVoiceSessionService().confirmOnScreen(
      owned.session.id,
      attemptId,
    );
    res.json({
      confirmed: result.confirmed,
      reason: result.reason,
      attemptId: result.attempt.id,
      state: result.attempt.state,
      pendingConfirmations,
    });
  } catch (err) {
    sendServiceError(res, err);
  }
});

/**
 * Session events over SSE: replay from ?since=<seq> (default 0), then
 * live as they happen. Carries speech lifecycle (speech_started /
 * speech_cancelled / speech_finished), pending_confirmation, and
 * confirmation_updated — the events a voice client renders from.
 */
router.get("/agent/voice/sessions/:id/events", requireAuth, (req: Request, res: Response) => {
  const owned = loadOwnedSession(req, res);
  if (!owned) return;
  const service = getVoiceSessionService();
  const sinceRaw = Number(req.query.since);
  const since = Number.isInteger(sinceRaw) && sinceRaw > 0 ? sinceRaw : 0;

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (event: { seq: number; type: string; data: unknown }) => {
    if (res.writableEnded) return;
    res.write(`event: ${event.type}\ndata: ${JSON.stringify({ seq: event.seq, ...((event.data as Record<string, unknown>) ?? {}) })}\n\n`);
  };
  for (const event of service.eventsSince(owned.session, since)) send(event);
  const unsubscribe = service.subscribe(owned.session.id, send);
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: ping\n\n`);
  }, 25_000);
  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

/** The synthesized audio for one utterance. */
router.get(
  "/agent/voice/sessions/:id/utterances/:utteranceId/audio",
  requireAuth,
  (req: Request, res: Response) => {
    const owned = loadOwnedSession(req, res);
    if (!owned) return;
    const utterance = getVoiceSessionService().getUtterance(
      owned.session.id,
      String(req.params.utteranceId),
    );
    if (!utterance || utterance.audio === null) {
      res.status(404).json({ error: "No audio for that utterance" });
      return;
    }
    res.setHeader("Content-Type", utterance.audioContentType ?? "audio/mpeg");
    res.setHeader("Content-Length", String(utterance.audio.length));
    res.send(utterance.audio);
  },
);

export default router;
