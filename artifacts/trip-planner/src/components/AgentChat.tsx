/**
 * SPIKE — AgentChat for Wander.
 *
 * Chat panel wired to POST /api/agent/chat. Sends the selected agentId
 * (from AgentPicker / localStorage) plus the tripId — the server loads the
 * trip context itself (Stage 1: client no longer sends trip data).
 *
 * Streaming-like UX: the spike endpoint is non-streaming, so we reveal the
 * assistant reply with a lightweight typewriter effect instead of true
 * token streaming. Swap for SSE/fetch-streaming when the backend supports it.
 *
 * Production placement: artifacts/trip-planner/src/components/AgentChat.tsx
 * (mount inside a trip detail page or a global chat drawer).
 */

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AGENT_OPTIONS, getSelectedAgentId } from "./AgentPicker";

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface AgentChatProps {
  /** Scope agent selection to a trip (per-trip choice from settings). */
  tripId?: string | number;
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
}

/** Resolve the non-streaming endpoint (fallback if the SSE stream fails). */
async function postChat(
  agentId: string,
  messages: Message[],
  tripId?: string | number,
): Promise<string> {
  const res = await fetch("/api/agent/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include", // session cookie, like the rest of Wander's API
    body: JSON.stringify({ agentId, messages, tripId }),
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
  tripId: string | number | undefined,
  handlers: StreamHandlers,
): Promise<string> {
  const res = await fetch("/api/agent/chat/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ agentId, messages, tripId }),
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

export default function AgentChat({ tripId, agentId, initialMessage, onInitialMessageConsumed, bare, onEmptyChange }: AgentChatProps) {
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
      const reply = await streamChat(resolvedAgentId, next, tripId, {
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
        const reply = await postChat(resolvedAgentId, next, tripId);
        patchAssistant(reply);
      } catch (fallbackErr) {
        setMessages((prev) => prev.filter((_, i) => i !== assistantIndex));
        setError(fallbackErr instanceof Error ? fallbackErr.message : "Something went wrong");
      }
    } finally {
      setStreamingId(null);
      setStatusText(null);
      setSending(false);
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
        {messages.length === 0 && (
          <p className="text-sm text-muted-foreground">
            Ask about your trip — schedule changes, what's next, or help
            re-planning a day.
          </p>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="ml-auto max-w-[80%] rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
              {m.content}
            </div>
          ) : (
            <div key={i} className="mr-auto max-w-[80%] rounded-lg bg-muted px-3 py-2">
              <AssistantBubble content={m.content} />
            </div>
          ),
        )}
        {showProgress && (
          <div className="mr-auto rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
            {statusText ?? `${agentName} is thinking…`}
          </div>
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
