/**
 * Marco — selectable AI agent route for Wander (Stage 1 backend).
 *
 * The agent runs on Muse Spark models via the Meta Model API
 * (https://api.ai.meta.com/v1 — OpenAI-compatible chat completions).
 * The API key never leaves the server: the frontend only talks to this route.
 *
 * What this route does:
 *   - GET  /agent/agents  — list selectable agents (auth required).
 *   - POST /agent/chat    — chat with tools. Body: { agentId?, tripId, messages }.
 *     Auth is required; the trip must exist; the caller must be a trip
 *     participant (or super_admin). Trip data comes server-side: a lean
 *     snapshot is injected as a system message, and the model calls read-only
 *     trip tools + Google Places research tools through a bounded loop.
 *
 * Mock fallback: when MUSE_SPARK_API_KEY is unset (or the mock-only "wander"
 * agent is selected), returns a labeled mock reply. The mock path requires
 * auth but performs no trip access check and no DB access.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { eq, and } from "drizzle-orm";
import { db, tripsTable, tripParticipantsTable } from "@workspace/db";
import {
  requireAuth,
  getAuthUserId,
  getAuthRole,
} from "../middlewares/auth";
import { logger } from "../lib/logger";
import { loadTripSnapshot, buildSnapshotSystemMessage } from "../lib/agentSnapshot";
import {
  AGENT_TOOLS,
  getToolDefinition,
  type ToolContext,
} from "../lib/agentTools";
import { AGENT_RESEARCH_TOOLS } from "../lib/agentResearch";

// ---------------------------------------------------------------------------
// Agent registry
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
    name: "Marco",
    // Model ids are documented at https://dev.meta.ai/docs/models.md
    // (e.g. muse-spark-1.1, muse-spark-1.2, muse-spark-1.3).
    // Overridable via env so the model can be bumped without a code change.
    model: process.env.MUSE_SPARK_MODEL ?? "muse-spark-1.1",
    systemPrompt:
      "You are Marco, an AI travel agent inside the Wander app. " +
      "You help travelers with trip updates, schedule changes, and planning. " +
      "Be warm, direct, and concise.\n\n" +
      "You have tools. USE them for any trip-specific question — reservations, " +
      "times, flights, stays, activities, and schedule conflicts. A trip context " +
      "summary is provided as a system message, but it is only an orientation: " +
      "before answering anything specific, query the relevant tool to get the " +
      "current data.\n\n" +
      "Never invent bookings, times, confirmation codes, or prices. If the tools " +
      "return nothing for an item, say plainly that the trip has no such item " +
      "rather than guessing. When a tool reports it is unavailable (for example " +
      "research tools without an API key), tell the user that directly instead " +
      "of fabricating results.\n\n" +
      "The tripId for every tool call is the trip you are discussing — pass it " +
      "exactly as given; do not ask the user for it and do not use another trip's id.\n\n" +
      "Once the tools have given you what you need, answer the user right away — " +
      "do not keep calling more tools.",
  },
];

function getAgent(agentId: unknown): AgentDefinition {
  const found = AGENTS.find((a) => a.id === agentId);
  return found ?? AGENTS[0]; // default: Wander Assistant
}

// ---------------------------------------------------------------------------
// Trip access guard (assertTripAccess idiom from src/mcp/tools.ts)
// ---------------------------------------------------------------------------

async function assertTripAccess(userId: number, role: string, tripId: number): Promise<void> {
  if (role === "super_admin") return;

  const [participant] = await db
    .select()
    .from(tripParticipantsTable)
    .where(
      and(
        eq(tripParticipantsTable.tripId, tripId),
        eq(tripParticipantsTable.userId, userId),
      ),
    );

  if (!participant) {
    const err = new Error(`Not a participant of trip ${tripId}.`);
    err.name = "TripAccessDenied";
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Body validation (isValidBody style)
// ---------------------------------------------------------------------------

type Role = "user" | "assistant" | "system" | "tool";

interface ChatMessage {
  role: Role;
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface ChatRequestBody {
  agentId?: string;
  /** The trip under discussion. Required: all trip data is loaded server-side. */
  tripId?: number;
  messages?: ChatMessage[];
}

const MAX_MESSAGES = 30;
const MAX_CONTENT_CHARS = 8000;

function isValidBody(body: unknown): body is ChatRequestBody & { messages: ChatMessage[]; tripId: number } {
  if (typeof body !== "object" || body === null) return false;
  const b = body as Record<string, unknown>;
  if (typeof b.tripId !== "number" || !Number.isInteger(b.tripId) || b.tripId <= 0) return false;
  return (
    Array.isArray(b.messages) &&
    b.messages.length > 0 &&
    b.messages.every(
      (m) =>
        typeof m === "object" &&
        m !== null &&
        ["user", "assistant", "system"].includes((m as ChatMessage).role) &&
        typeof (m as ChatMessage).content === "string",
    )
  );
}

// ---------------------------------------------------------------------------
// Meta Model API call (OpenAI-compatible chat completions, with tools)
// ---------------------------------------------------------------------------

const MODEL_API_BASE_URL =
  process.env.MUSE_SPARK_BASE_URL ?? "https://api.ai.meta.com/v1";

const MAX_TOOL_ITERATIONS = 10;

interface ModelApiResult {
  content: string | null;
  toolCalls: ToolCall[];
}

async function callModelApi(
  model: string,
  messages: ChatMessage[],
  tools: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>,
): Promise<ModelApiResult> {
  const apiKey = process.env.MUSE_SPARK_API_KEY;
  if (!apiKey) {
    throw new Error("MUSE_SPARK_API_KEY is not set");
  }

  // Bound each upstream call: a hung model API must not hang the chat forever.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  let res: Response;
  try {
    res = await fetch(`${MODEL_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: "auto",
        // Muse Spark spends a large share of the token budget on hidden
        // reasoning (~600-1000 tokens/call). A 1024 cap starves the actual
        // response: finish_reason=length, truncated text, no tool calls.
        max_tokens: 4096,
        // "minimal" is the lowest valid effort ("none" 400s). Proven in
        // harness testing: same answer quality, ~4x faster per call.
        reasoning_effort: "minimal",
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error("Model API timed out after 45s");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Model API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: ToolCall[] };
    }>;
  };
  const message = data.choices?.[0]?.message;
  return {
    content: message?.content?.trim() || null,
    toolCalls: message?.tool_calls ?? [],
  };
}

// ---------------------------------------------------------------------------
// Tool-calling loop
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [...AGENT_TOOLS, ...AGENT_RESEARCH_TOOLS];

async function runAgentLoop(
  agent: AgentDefinition,
  ctx: ToolContext,
  tripId: number,
  messages: ChatMessage[],
): Promise<string> {
  const tools = TOOL_DEFINITIONS.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  let lastText: string | null = null;

  // Stuck-loop detector: if the model repeats an identical tool call it has
  // already made, it is going in circles — stop burning iterations and force
  // the final answer from whatever tool data was gathered.
  const seenToolCalls = new Set<string>();

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    let result: ModelApiResult;
    try {
      result = await callModelApi(agent.model, messages, tools);
    } catch (err) {
      // Model API failure: surface the best text we have, else throw for a 502.
      if (lastText) return lastText;
      throw err;
    }

    if (result.content) lastText = result.content;

    if (result.toolCalls.length === 0) {
      break; // final answer
    }

    messages.push({
      role: "assistant",
      content: result.content ?? "",
      tool_calls: result.toolCalls,
    });

    // Stuck-loop check: if the model repeats an identical tool call it has
    // already made, it is going in circles — stop burning iterations and
    // force the final answer from the tool data gathered so far.
    const signatures = result.toolCalls.map((call) => {
      const name = call.function?.name ?? "";
      return `${name}(${call.function?.arguments ?? ""})`;
    });
    const repeatedSig = signatures.find((s) => seenToolCalls.has(s));
    if (repeatedSig) {
      logger.warn(
        { tool: repeatedSig, userId: ctx.userId, tripId, iteration: i + 1 },
        "[Agent] stuck loop detected: identical tool call repeated — forcing final answer",
      );
      break;
    }
    signatures.forEach((s) => seenToolCalls.add(s));

    // Performance: execute this iteration's tool calls concurrently, then
    // append their results in call order so the transcript stays stable.
    const outcomes = await Promise.all(
      result.toolCalls.map(async (call) => {
        const name = call.function?.name ?? "";
        logger.info(
          { tool: name, userId: ctx.userId, tripId, iteration: i + 1 },
          "[Agent] tool call",
        );

        let parsedArgs: unknown = {};
        try {
          parsedArgs = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          // fall through to the zod validation below, which will reject it
        }

        const def = getToolDefinition(name) ?? AGENT_RESEARCH_TOOLS.find((t) => t.name === name);

        let toolResult: { ok: boolean; text: string; data?: unknown };
        if (!def) {
          toolResult = { ok: false, text: `Unknown tool "${name}".` };
        } else {
          const parsed = def.input.safeParse(parsedArgs);
          if (!parsed.success) {
            toolResult = { ok: false, text: `Invalid arguments for ${name}: ${parsed.error.issues[0]?.message ?? "validation failed"}` };
          } else {
            try {
              // Defense in depth: re-assert access to the chat's trip on every
              // tool call, even though each trip tool asserts its own tripId arg.
              await assertTripAccess(ctx.userId, ctx.role, tripId);
              toolResult = await def.run(ctx, parsed.data as never);
            } catch (err) {
              // Tool failures go back to the model as error results — never a 500.
              logger.error({ tool: name, userId: ctx.userId, tripId, err }, "[Agent] tool error");
              toolResult = {
                ok: false,
                text: err instanceof Error && err.name === "TripAccessDenied"
                  ? err.message
                  : `Tool ${name} failed: internal error.`,
              };
            }
          }
        }

        logger.info(
          { tool: name, userId: ctx.userId, tripId, outcome: toolResult.ok ? "ok" : "error" },
          "[Agent] tool result",
        );
        return { call, toolResult };
      }),
    );

    for (const { call, toolResult } of outcomes) {
      messages.push({
        role: "tool",
        content: JSON.stringify(toolResult).slice(0, 8000),
        tool_call_id: call.id,
      });
    }
  }

  if (!lastText) {
    // Safety net: the model gathered tool data but never wrote an answer.
    // Force one final text-only response from the accumulated tool results.
    // Retry once — a single transient model failure shouldn't surface as a
    // "looping" message when we actually have tool data to answer from.
    const safetyPrompt =
      "Answer the user's original question now, using only the information " +
      "from the tool results above. Write the answer directly — do not call any tools.";
    for (let attempt = 1; attempt <= 2 && !lastText; attempt++) {
      try {
        const final = await callModelApi(
          agent.model,
          [...messages, { role: "user", content: safetyPrompt }],
          [],
        );
        if (final.content) lastText = final.content;
      } catch (err) {
        logger.error(
          { userId: ctx.userId, tripId, attempt, err },
          "[Agent] safety-net final answer failed",
        );
      }
    }
    if (!lastText) {
      logger.error(
        { userId: ctx.userId, tripId },
        "[Agent] safety net exhausted — returning looping fallback",
      );
    }
  }

  return (
    lastText ??
    "I couldn't complete that request — the planning steps kept looping without a final answer. Please try rephrasing."
  );
}

// ---------------------------------------------------------------------------
// Mock fallback — runs with no credentials, auth still required.
// ---------------------------------------------------------------------------

function mockReply(agent: AgentDefinition, tripId: number, messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content;
  return (
    `[mock ${agent.name} — no MUSE_SPARK_API_KEY set] ` +
    `You said: "${(lastUser ?? "").slice(0, 120)}" (trip ${tripId}). ` +
    `Set MUSE_SPARK_API_KEY from dev.meta.ai to get live model responses.`
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const router: IRouter = Router();

/** List selectable agents (drives the login picker). Auth required. */
router.get("/agent/agents", requireAuth, (_req: Request, res: Response) => {
  res.json({
    agents: AGENTS.map(({ id, name }) => ({ id, name })),
  });
});

/** Chat with the selected agent. Auth + trip membership required. */
router.post("/agent/chat", requireAuth, async (req: Request, res: Response) => {
  if (!isValidBody(req.body)) {
    res.status(400).json({
      error:
        "Invalid body: expected { agentId?, tripId: <positive int>, messages: [{role, content}] } with at least one message",
    });
    return;
  }

  const { tripId } = req.body;
  const agent = getAgent(req.body.agentId);

  // The "wander" agent has no external model — mock only.
  // The mock path requires auth (requireAuth above) but performs no trip
  // access check and no DB access.
  if (agent.id === "wander" || !process.env.MUSE_SPARK_API_KEY) {
    res.json({ agentId: agent.id, reply: mockReply(agent, tripId, req.body.messages), mock: true });
    return;
  }

  const userId = getAuthUserId(req, res);
  const role = getAuthRole(req, res) ?? "";
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  // 404 if the trip doesn't exist, 403 if the caller isn't a participant.
  const [trip] = await db.select({ id: tripsTable.id }).from(tripsTable).where(eq(tripsTable.id, tripId));
  if (!trip) {
    res.status(404).json({ error: `Trip ${tripId} not found` });
    return;
  }
  try {
    await assertTripAccess(userId, role, tripId);
  } catch {
    res.status(403).json({ error: `Trip access required for trip ${tripId}` });
    return;
  }

  // Keep only the tail of the conversation and cap message sizes to bound the
  // prompt. Snapshot stays lean — full detail comes via tools.
  const history = req.body.messages.slice(-MAX_MESSAGES).map((m) => ({
    role: m.role,
    content: m.content.slice(0, MAX_CONTENT_CHARS),
  }));

  let snapshotMessage: { role: "system"; content: string };
  try {
    const snapshot = await loadTripSnapshot(tripId);
    snapshotMessage = buildSnapshotSystemMessage(snapshot);
  } catch (err) {
    logger.error({ tripId, userId, err }, "[Agent] snapshot load failed");
    res.status(500).json({ error: "Failed to load trip context" });
    return;
  }

  const messages: ChatMessage[] = [
    { role: "system", content: agent.systemPrompt },
    snapshotMessage,
    ...history,
  ];

  try {
    const reply = await runAgentLoop(agent, { userId, role }, tripId, messages);
    res.json({ agentId: agent.id, reply, mock: false });
  } catch (err) {
    // 502: our server is fine, the upstream model call failed.
    logger.error({ err, userId, tripId }, "[Agent] chat failed");
    res.status(502).json({
      error: "Agent request failed",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

export default router;
