/**
 * SPIKE — Muse Spark agent route for Wander.
 *
 * Demonstrates how Wander's Express api-server could expose a selectable
 * AI agent powered by Muse Spark MODELS via the Meta Model API
 * (https://dev.meta.ai — OpenAI-compatible chat completions endpoint).
 *
 * This is NOT the user's personal Muse agent — it is a new agent that lives
 * inside Wander, built on the same model family. The API key never leaves
 * the server: the frontend only ever talks to this route.
 *
 * To wire into the real server (spike only — do not commit as-is):
 *   1. Copy this file to artifacts/api-server/src/routes/agent.ts
 *   2. In artifacts/api-server/src/routes/index.ts add:
 *        import agentRouter from "./agent";
 *        router.use(agentRouter);
 *      (app.ts already mounts `router` at /api, so this becomes POST /api/agent/chat)
 *   3. Set MUSE_SPARK_API_KEY in the api-server environment (Replit Secrets).
 */

import { Router, type IRouter, type Request, type Response } from "express";

// ---------------------------------------------------------------------------
// Agent registry — the list a user picks from at login.
// ---------------------------------------------------------------------------

export interface AgentDefinition {
  /** Stable id the frontend sends as `agentId`. */
  id: string;
  /** Display name shown in the picker. */
  name: string;
  /** Meta Model API model id (only used for the muse-spark agent). */
  model: string;
  /** System prompt that defines the agent's role for every request. */
  systemPrompt: string;
}

export const AGENTS: AgentDefinition[] = [
  {
    id: "wander",
    name: "Wander Assistant",
    model: "builtin",
    systemPrompt:
      "You are the Wander trip-planning assistant. Help with itineraries, " +
      "reservations, and travel logistics. Be concise and practical.",
  },
  {
    id: "muse-spark",
    name: "Marco (Polo)",
    // Model ids are documented at https://dev.meta.ai/docs/models.md
    // (e.g. muse-spark-1.1, muse-spark-1.2, muse-spark-1.3).
    // Overridable via env so the model can be bumped without a code change.
    model: process.env.MUSE_SPARK_MODEL ?? "muse-spark-1.1",
    systemPrompt:
      "You are Marco (Polo), an AI travel agent inside the Wander app. " +
      "You help travelers with trip updates, schedule changes, and planning. " +
      "Use the trip context provided (itinerary, reservations, dates) to give " +
      "specific, actionable answers. If a schedule conflict appears, flag it " +
      "and suggest alternatives. Be warm, direct, and concise.",
  },
];

function getAgent(agentId: unknown): AgentDefinition {
  const found = AGENTS.find((a) => a.id === agentId);
  return found ?? AGENTS[0]; // default: Wander Assistant
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

interface ChatRequestBody {
  agentId?: string;
  messages?: ChatMessage[];
  /** Optional trip snapshot (itinerary, reservations) injected as context. */
  tripContext?: Record<string, unknown>;
}

function isValidBody(body: unknown): body is ChatRequestBody & { messages: ChatMessage[] } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  return (
    Array.isArray(b.messages) &&
    b.messages.every(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        ["user", "assistant", "system"].includes((m as ChatMessage).role) &&
        typeof (m as ChatMessage).content === "string",
    )
  );
}

/** Render tripContext as a compact system message so the model can use it. */
function buildTripContextMessage(tripContext: Record<string, unknown>): ChatMessage {
  const summary = JSON.stringify(tripContext).slice(0, 4000); // keep prompt bounded
  return {
    role: "system",
    content:
      "Current trip context (itinerary, reservations, dates) as JSON. " +
      "Ground your answers in it; do not invent bookings or times.\n" +
      summary,
  };
}

// ---------------------------------------------------------------------------
// Meta Model API call (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

const MODEL_API_BASE_URL =
  process.env.MUSE_SPARK_BASE_URL ?? "https://api.ai.meta.com/v1";

async function callModelApi(
  model: string,
  messages: ChatMessage[],
): Promise<string> {
  const apiKey = process.env.MUSE_SPARK_API_KEY;
  if (!apiKey) {
    throw new Error("MUSE_SPARK_API_KEY is not set");
  }

  const res = await fetch(`${MODEL_API_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 1024,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Model API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Model API returned an empty response");
  return content;
}

// ---------------------------------------------------------------------------
// Mock fallback — lets the spike run locally with no credentials.
// ---------------------------------------------------------------------------

function mockReply(agent: AgentDefinition, body: ChatRequestBody): string {
  const lastUser = [...(body.messages ?? [])]
    .reverse()
    .find((m) => m.role === "user")?.content;
  const hasTrip = body.tripContext ? " (trip context attached)" : "";
  return (
    `[mock ${agent.name} — no MUSE_SPARK_API_KEY set] ` +
    `You said: "${(lastUser ?? "").slice(0, 120)}"${hasTrip}. ` +
    `Set MUSE_SPARK_API_KEY from dev.meta.ai to get live model responses.`
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router: IRouter = Router();

/** List selectable agents (drives the login picker). */
router.get("/agent/agents", (_req: Request, res: Response) => {
  res.json({
    agents: AGENTS.map(({ id, name }) => ({ id, name })),
  });
});

/** Chat with the selected agent. */
router.post("/agent/chat", async (req: Request, res: Response) => {
  if (!isValidBody(req.body)) {
    res.status(400).json({
      error: "Invalid body: expected { agentId?, messages: [{role, content}], tripContext? }",
    });
    return;
  }

  const agent = getAgent(req.body.agentId);

  // The "wander" agent has no external model in this spike — mock only.
  // In production it would point at whatever Wander uses today.
  if (agent.id === "wander" || !process.env.MUSE_SPARK_API_KEY) {
    res.json({ agentId: agent.id, reply: mockReply(agent, req.body), mock: true });
    return;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
  ];
  if (req.body.tripContext) {
    messages.push(buildTripContextMessage(req.body.tripContext));
  }
  messages.push(...req.body.messages);

  try {
    const reply = await callModelApi(agent.model, messages);
    res.json({ agentId: agent.id, reply, mock: false });
  } catch (err) {
    // 502: our server is fine, the upstream model call failed.
    res.status(502).json({
      error: "Agent request failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
