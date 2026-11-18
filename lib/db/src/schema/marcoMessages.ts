import { pgTable, serial, text, timestamp, integer, index, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { tripsTable } from "./trips";
import { usersTable } from "./users";
import { intakeSessionsTable } from "./intakeSessions";

/**
 * Marco conversation memory: one row per user/assistant turn, scoped to a
 * single trip and a single user. The agent loads the recent tail as
 * conversation context, so Marco remembers earlier sessions — not just the
 * current page view. Rows are pruned to a bounded window per (trip, user).
 *
 * Only plain text turns are stored (role "user" | "assistant"); tool-call
 * transcripts are deliberately excluded — fresh trip data comes via tools.
 *
 * ADR-3 (north-star architecture §2.3): pre-trip intake conversations are
 * first-class. A row is scoped to exactly one of `tripId` (a materialized
 * trip) or `intakeSessionId` (a planner intake session) — enforced by the
 * check constraint below. At materialization the session's rows are
 * re-keyed to the new trip (tripId set, intakeSessionId cleared), so the
 * conversation continues seamlessly into per-trip planning.
 */
export const marcoMessagesTable = pgTable("marco_messages", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").references(() => tripsTable.id, { onDelete: "cascade" }),
  intakeSessionId: integer("intake_session_id").references(() => intakeSessionsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("marco_messages_trip_user_id_idx").on(t.tripId, t.userId, t.id),
  index("marco_messages_intake_user_id_idx").on(t.intakeSessionId, t.userId, t.id),
  check(
    "marco_messages_exactly_one_scope",
    sql`(${t.tripId} is not null and ${t.intakeSessionId} is null) or (${t.tripId} is null and ${t.intakeSessionId} is not null)`,
  ),
]);

export type MarcoMessage = typeof marcoMessagesTable.$inferSelect;
