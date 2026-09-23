/**
 * Marco conversation memory.
 *
 * The chat endpoints were stateless: the model only saw whatever history the
 * client sent, so a page reload wiped Marco's memory of the conversation.
 * This module persists every user/assistant turn per (trip, user) and merges
 * the persisted log with the client-sent session history on each request.
 *
 * Merge algorithm: find the largest k such that the last k persisted
 * messages equal the first k client-sent messages (role + trimmed content).
 * The client's messages after that overlap are new — they get persisted —
 * and the model context is (persisted ++ new), tail-capped. This handles:
 *   - continuing session: client history overlaps the persisted tail;
 *   - fresh session (reload): no overlap, persisted log supplies the past;
 *   - anything in between without ever double-storing a turn.
 */

import { and, desc, eq, notInArray } from "drizzle-orm";
import { db, marcoMessagesTable } from "@workspace/db";
import { logger } from "./logger";

export interface MemoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** How many persisted messages are consulted when building model context. */
export const MEMORY_CONTEXT_LIMIT = 30;
/** Rows retained per (trip, user) — older turns are pruned. */
export const MEMORY_RETAIN_LIMIT = 100;
/** Messages returned by GET /agent/history for display. */
export const MEMORY_HISTORY_LIMIT = 50;
/** Stored content cap, matching the chat context cap. */
export const MEMORY_CONTENT_CHARS = 8000;

function sameTurn(a: MemoryMessage, b: MemoryMessage): boolean {
  return a.role === b.role && a.content.trim() === b.content.trim();
}

/**
 * Largest k in [0, min(persisted.length, client.length)] such that
 * persisted.slice(-k) equals client.slice(0, k) turn by turn.
 * Pure — unit-testable.
 */
export function findHistoryOverlap(
  persisted: MemoryMessage[],
  client: MemoryMessage[],
): number {
  const max = Math.min(persisted.length, client.length);
  for (let k = max; k > 0; k--) {
    let ok = true;
    for (let i = 0; i < k; i++) {
      if (!sameTurn(persisted[persisted.length - k + i], client[i])) {
        ok = false;
        break;
      }
    }
    if (ok) return k;
  }
  return 0;
}

export interface MergedHistory {
  /** Model-ready history: persisted ++ fresh, tail-capped at `limit`. */
  history: MemoryMessage[];
  /** Client-sent turns not yet persisted (persist these after the reply). */
  fresh: MemoryMessage[];
}

/**
 * Merge the persisted log with the client-sent session history.
 * Pure — unit-testable.
 */
export function mergeHistories(
  persisted: MemoryMessage[],
  client: MemoryMessage[],
  limit: number,
): MergedHistory {
  const overlap = findHistoryOverlap(persisted, client);
  const fresh = client.slice(overlap);
  const history = [...persisted, ...fresh].slice(-limit);
  return { history, fresh };
}

/** Load the recent persisted turns for a (trip, user), oldest first. */
export async function loadMarcoHistory(
  tripId: number,
  userId: number,
  limit: number = MEMORY_CONTEXT_LIMIT,
): Promise<MemoryMessage[]> {
  const rows = await db
    .select({ role: marcoMessagesTable.role, content: marcoMessagesTable.content })
    .from(marcoMessagesTable)
    .where(and(eq(marcoMessagesTable.tripId, tripId), eq(marcoMessagesTable.userId, userId)))
    .orderBy(desc(marcoMessagesTable.id))
    .limit(limit);
  const out: MemoryMessage[] = [];
  for (const row of rows.reverse()) {
    if (row.role === "user" || row.role === "assistant") {
      out.push({ role: row.role, content: row.content });
    }
  }
  return out;
}

/**
 * Persist the fresh turns of a completed chat turn (user message + assistant
 * reply), then prune the log to the retention window. Best-effort: callers
 * must not fail the chat when this throws.
 */
export async function persistMarcoTurn(
  tripId: number,
  userId: number,
  messages: MemoryMessage[],
): Promise<void> {
  const rows = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      tripId,
      userId,
      role: m.role as "user" | "assistant",
      content: m.content.slice(0, MEMORY_CONTENT_CHARS),
    }));
  if (rows.length === 0) return;

  await db.insert(marcoMessagesTable).values(rows);

  // Prune to the retention window, oldest first.
  const keep = await db
    .select({ id: marcoMessagesTable.id })
    .from(marcoMessagesTable)
    .where(and(eq(marcoMessagesTable.tripId, tripId), eq(marcoMessagesTable.userId, userId)))
    .orderBy(desc(marcoMessagesTable.id))
    .limit(MEMORY_RETAIN_LIMIT);
  const keepIds = keep.map((r) => r.id);
  if (keepIds.length > 0) {
    await db
      .delete(marcoMessagesTable)
      .where(
        and(
          eq(marcoMessagesTable.tripId, tripId),
          eq(marcoMessagesTable.userId, userId),
          notInArray(marcoMessagesTable.id, keepIds),
        ),
      );
  }

  // Privacy-safe: counts only, never message content.
  logger.info(
    { userId, tripId, persisted: rows.length },
    "[Marco] conversation turn persisted",
  );
}
