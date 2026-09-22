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

/** Reveal text progressively to mimic streaming (spike-only). */
function useTypewriter(fullText: string, active: boolean) {
  const [shown, setShown] = useState("");
  useEffect(() => {
    if (!active) {
      setShown(fullText);
      return;
    }
    setShown("");
    let i = 0;
    const timer = setInterval(() => {
      i += 3; // chars per tick — tune for feel
      setShown(fullText.slice(0, i));
      if (i >= fullText.length) clearInterval(timer);
    }, 16);
    return () => clearInterval(timer);
  }, [fullText, active]);
  return shown;
}

function AssistantBubble({ content, streaming }: { content: string; streaming: boolean }) {
  const shown = useTypewriter(content, streaming);
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
        {shown}
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
    setMessages(next);
    setSending(true);
    try {
      const reply = await postChat(resolvedAgentId, next, tripId);
      setMessages([...next, { role: "assistant", content: reply }]);
      setStreamingId(next.length); // index of the new assistant message
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setSending(false);
    }
  }

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
              <AssistantBubble content={m.content} streaming={streamingId === i} />
            </div>
          ),
        )}
        {sending && (
          <div className="mr-auto rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
            {agentName} is thinking…
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
