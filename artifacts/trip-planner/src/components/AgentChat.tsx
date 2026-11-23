/**
 * AgentChat for Wander.
 *
 * Chat panel wired to the Marco agent endpoints. Sends the selected agentId
 * (from AgentPicker / localStorage) plus the tripId — the server loads the
 * trip context itself (Stage 1: client no longer sends trip data).
 *
 * True token streaming via POST /api/agent/chat/stream (SSE), with a
 * one-shot fallback to POST /api/agent/chat. Conversation memory: on load,
 * the panel seeds its message list from GET /api/agent/history so Marco
 * remembers earlier sessions; the server merges that with the live session
 * and persists every turn.
 *
 * Production placement: artifacts/trip-planner/src/components/AgentChat.tsx
 * (mount inside a trip detail page or a global chat drawer).
 */

import { Fragment, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AGENT_OPTIONS, getSelectedAgentId } from "./AgentPicker";
import MarcoAvatar from "./MarcoAvatar";
import BookingReviewCard from "./BookingReviewCard";
import { extractReviewAttemptIds } from "@/lib/booking-review";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface AgentChatProps {
  /** Scope agent selection to a trip (per-trip choice from settings). */
  tripId?: string | number;
  /**
   * Intake scope (ADR-3): chat against a planner intake session instead
   * of a trip. The server accepts tripId XOR intakeSessionId; when this
   * is set it wins and no tripId is sent.
   */
  intakeSessionId?: number;
  /** Override the agent; defaults to the picker's localStorage selection. */
  agentId?: string;
  /**
   * Seed a first message (e.g. typed in the overview header). Sent once on
   * arrival, then the parent should clear it via onInitialMessageConsumed.
   */
  initialMessage?: string | null;
  onInitialMessageConsumed?: () => void;
  /**
   * Bare mode: no outer card chrome or header — for embedding inside a
   * parent that provides its own (e.g. MarcoBar's expanding panel).
   */
  bare?: boolean;
  /** Called when the conversation transitions between empty and non-empty. */
  onEmptyChange?: (isEmpty: boolean) => void;
  /** Called after each completed send attempt (success or failure). */
  onTurnComplete?: () => void;
  /**
   * Marco speaks first (design Decision 2): an opening line rendered as
   * Marco's first message while the conversation is still empty — on the
   * intake page this is the session view's actual nextAsk question
   * ("Ok, where are we going?"), supplied by the parent from server
   * state. It is a view-layer prologue only: it is never added to the
   * message list, never sent to the server, and disappears the moment a
   * real message exists (so it can never duplicate a persisted reply).
   */
  openingMessage?: string | null;
}

/** The scope fields a chat body carries: exactly one of the two. */
interface ChatScope {
  tripId?: string | number;
  intakeSessionId?: number;
}

function scopeBody(scope: ChatScope): Record<string, unknown> {
  if (scope.intakeSessionId != null) return { intakeSessionId: scope.intakeSessionId };
  if (scope.tripId != null) return { tripId: scope.tripId };
  return {};
}

/** Resolve the non-streaming endpoint (fallback if the SSE stream fails). */
async function postChat(
  agentId: string,
  messages: Message[],
  scope: ChatScope,
): Promise<string> {
  const res = await fetch("/api/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include", // session cookie, like the rest of Wander's API
    body: JSON.stringify({ agentId, messages, ...scopeBody(scope) }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const body = data as { error?: string; detail?: string };
    throw new Error(
      body.detail
        ? `${body.error ?? "Chat failed"}: ${body.detail}`
        : (body.error ?? `Chat failed (${res.status})`),
    );
  }
  return (data as { reply: string }).reply ?? "";
}

interface StreamHandlers {
  onToken: (delta: string) => void;
  onStatus: (text: string) => void;
  /** Streamed text so far was narration, not the answer — clear it. */
  onSupersede: () => void;
}

/**
 * POST /api/agent/chat/stream — true token streaming via SSE.
 * Resolves with the authoritative full reply from the `done` event.
 * Event types: status {text}, token {delta}, supersede {}, done {reply},
 * error {error, detail}.
 */
async function streamChat(
  agentId: string,
  messages: Message[],
  scope: ChatScope,
  handlers: StreamHandlers,
): Promise<string> {
  const res = await fetch("/api/agent/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ agentId, messages, ...scopeBody(scope) }),
  });
  if (!res.ok) {
    // Auth/validation failures still come back as JSON (before SSE headers).
    const data = await res.json().catch(() => ({}));
    const body = data as { error?: string; detail?: string };
    throw new Error(
      body.detail
        ? `${body.error ?? "Chat failed"}: ${body.detail}`
        : (body.error ?? `Chat failed (${res.status})`),
    );
  }
  if (!res.body) throw new Error("Streaming not supported by this browser");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullReply = "";

  const handleEvent = (type: string, rawData: string) => {
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(rawData) as Record<string, unknown>;
    } catch {
      return; // malformed data line — skip it
    }
    if (type === "token" && typeof payload.delta === "string") {
      fullReply += payload.delta;
      handlers.onToken(payload.delta);
    } else if (type === "status" && typeof payload.text === "string") {
      handlers.onStatus(payload.text);
    } else if (type === "supersede") {
      fullReply = "";
      handlers.onSupersede();
    } else if (type === "done") {
      if (typeof payload.reply === "string") fullReply = payload.reply;
    } else if (type === "error") {
      const detail = payload.detail as string | undefined;
      const error = payload.error as string | undefined;
      throw new Error(
        detail ? `${error ?? "Stream failed"}: ${detail}` : (error ?? "Stream failed"),
      );
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE frames are separated by a blank line.
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        let type = "message";
        const dataParts: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) dataParts.push(line.slice(5).trimStart());
          // ": comment" heartbeats are ignored.
        }
        if (dataParts.length > 0) handleEvent(type, dataParts.join("\n"));
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  // A stream that ended without `done` still yields whatever arrived.
  return fullReply;
}

/**
 * One assistant message with Marco's identity on it (design Decision 7):
 * avatar + name above the bubble, so a traveler always knows who is
 * talking. Used for real messages, the opening prologue, and the
 * thinking indicator alike.
 */
function AssistantMessage({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="mr-auto max-w-[80%]">
      <div className="mb-1 flex items-center gap-1.5 pl-0.5">
        <MarcoAvatar className="h-5 w-5" />
        <span className="text-xs font-medium text-muted-foreground">{name}</span>
      </div>
      <div className="rounded-lg bg-muted px-3 py-2">{children}</div>
    </div>
  );
}

function AssistantBubble({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words text-sm dark:prose-invert prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5 prose-headings:mb-1 prose-headings:mt-3 prose-a:text-primary prose-a:underline prose-code:rounded prose-code:bg-background/60 prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Open links in a new tab — model output can include source URLs.
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export default function AgentChat({ tripId, intakeSessionId, agentId, initialMessage, onInitialMessageConsumed, bare, onEmptyChange, onTurnComplete, openingMessage }: AgentChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamingId, setStreamingId] = useState<number | null>(null);
  /** Live progress line from the SSE stream ("Checking your reservations…"). */
  const [statusText, setStatusText] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Let the parent (e.g. MarcoBar) size the panel to the conversation:
  // compact while empty, full height once messages exist.
  useEffect(() => {
    onEmptyChange?.(messages.length === 0);
  }, [messages, onEmptyChange]);

  const resolvedAgentId = agentId ?? getSelectedAgentId(tripId);
  const agentName =
    AGENT_OPTIONS.find((o) => o.id === resolvedAgentId)?.name ?? resolvedAgentId;

  // Conversation memory: seed the message list from the persisted log so
  // Marco remembers earlier sessions. Only fills an empty list — never
  // clobbers a live conversation (e.g. a seeded initialMessage in flight).
  // Intake scope reads the intake conversation's history the same way
  // (GET /agent/history?intakeSessionId=N, ADR-3).
  const historySeededRef = useRef(false);
  // True once the history read has settled (or there is no history to
  // read) — the opening prologue waits for this so a resumed session's
  // real history is never preceded by a "first message" that isn't.
  const [historySettled, setHistorySettled] = useState(false);
  const scopeKey =
    intakeSessionId != null ? `intake:${intakeSessionId}` : tripId != null ? `trip:${tripId}` : null;
  useEffect(() => {
    if (scopeKey == null) {
      setHistorySettled(true);
      return;
    }
    if (historySeededRef.current) return;
    historySeededRef.current = true;
    const historyUrl =
      intakeSessionId != null
        ? `/api/agent/history?intakeSessionId=${encodeURIComponent(String(intakeSessionId))}`
        : `/api/agent/history?tripId=${encodeURIComponent(String(tripId))}`;
    fetch(historyUrl, {
      credentials: "include",
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const seeded: Message[] = ((data?.messages ?? []) as Message[]).filter(
          (m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
        );
        if (seeded.length > 0) {
          setMessages((prev) => (prev.length === 0 ? seeded : prev));
        }
      })
      .catch(() => {
        // History is a nice-to-have: an empty chat still works.
      })
      .finally(() => setHistorySettled(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKey]);

  // Keep the newest message visible by scrolling the chat's own message
  // list — never the page. (scrollIntoView would yank the whole window.)
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  // Send a seeded message once (e.g. typed in the overview header bar).
  const initialSentRef = useRef(false);
  useEffect(() => {
    if (initialMessage && !initialSentRef.current) {
      initialSentRef.current = true;
      void sendText(initialMessage);
      onInitialMessageConsumed?.();
    }
    // Consume-once semantics: parent clears initialMessage after consumption.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialMessage]);

  async function send() {
    const text = input.trim();
    if (!text || sending) return;
    setInput("");
    await sendText(text);
  }

  async function sendText(text: string) {
    if (!text || sending) return;
    setError(null);
    const next: Message[] = [...messages, { role: "user" as const, content: text }];
    // Reserve the assistant bubble up front so streamed tokens have a home.
    const assistantIndex = next.length;
    setMessages([...next, { role: "assistant" as const, content: "" }]);
    setStreamingId(assistantIndex);
    setStatusText(null);
    setSending(true);
    const patchAssistant = (content: string) =>
      setMessages((prev) =>
        prev.map((m, i) => (i === assistantIndex ? { ...m, content } : m)),
      );
    try {
      const reply = await streamChat(resolvedAgentId, next, { tripId, intakeSessionId }, {
        onToken: (delta) =>
          setMessages((prev) =>
            prev.map((m, i) =>
              i === assistantIndex ? { ...m, content: m.content + delta } : m,
            ),
          ),
        onStatus: (t) => setStatusText(t),
        onSupersede: () => patchAssistant(""),
      });
      // Authoritative final text — covers any delta lost in transit.
      patchAssistant(reply);
    } catch (err) {
      // The stream failed: fall back to the non-streaming endpoint once,
      // then surface the error. Drop the empty reserved bubble on failure.
      try {
        const reply = await postChat(resolvedAgentId, next, { tripId, intakeSessionId });
        patchAssistant(reply);
      } catch (fallbackErr) {
        setMessages((prev) => prev.filter((_, i) => i !== assistantIndex));
        setError(fallbackErr instanceof Error ? fallbackErr.message : "Something went wrong");
      }
    } finally {
      setStreamingId(null);
      setStatusText(null);
      setSending(false);
      onTurnComplete?.();
    }
  }

  // While the answer is still being assembled (no tokens yet), show live
  // progress instead of a static spinner. Once tokens arrive, the bubble
  // itself is the progress indicator.
  const showProgress =
    sending &&
    (streamingId === null || (messages[streamingId]?.content ?? "") === "");

  return (
    <div className={bare ? "flex h-full flex-col" : "flex h-full flex-col rounded-lg border"}>
      {!bare && (
        <div className="border-b px-4 py-2 text-sm font-medium">
          Chatting with {agentName}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 && !openingMessage && (
          <p className="text-sm text-muted-foreground">
            {intakeSessionId != null
              ? "Tell Marco where you'd like to go — he'll ask a few questions and build the trip with you."
              : "Ask about your trip — schedule changes, what's next, or help re-planning a day."}
          </p>
        )}
        {/* Marco speaks first (Decision 2): the opening prologue, shown
            only while the conversation is genuinely empty and history
            has settled. Not part of `messages` — see the prop docs. */}
        {messages.length === 0 && historySettled && openingMessage && (
          <AssistantMessage name={agentName}>
            <AssistantBubble content={openingMessage} />
          </AssistantMessage>
        )}
        {messages.map((m, i) => {
          // The reserved streaming bubble is still empty — the progress
          // indicator below stands in for it until the first token lands.
          if (m.role === "assistant" && m.content === "" && i === streamingId) return null;
          if (m.role === "user") {
            return (
              <div key={i} className="ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                {m.content}
              </div>
            );
          }
          // A booking_review tool result in the text is the trigger
          // for the on-screen confirmation card (decision 6): chat
          // messages carry text only, so the attempt id in the
          // review text is the minimal reliable hook. Trip scope
          // only — attempts belong to trips.
          const numericTripId =
            tripId != null && Number.isFinite(Number(tripId)) ? Number(tripId) : null;
          const reviewAttemptIds =
            numericTripId != null ? extractReviewAttemptIds(m.content) : [];
          return (
            <Fragment key={i}>
              <AssistantMessage name={agentName}>
                <AssistantBubble content={m.content} />
              </AssistantMessage>
              {numericTripId != null &&
                reviewAttemptIds.map((attemptId) => (
                  <BookingReviewCard key={attemptId} tripId={numericTripId} attemptId={attemptId} />
                ))}
            </Fragment>
          );
        })}
        {showProgress && (
          <AssistantMessage name={agentName}>
            <p className="text-sm text-muted-foreground">
              {statusText ?? `${agentName} is thinking…`}
            </p>
          </AssistantMessage>
        )}
        {error && (
          <div className="rounded-lg border border-destructive/50 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t p-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={`Message ${agentName}…`}
          className="flex-1 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          disabled={sending}
        />
        <button
          onClick={() => void send()}
          disabled={sending || !input.trim()}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
