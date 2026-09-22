import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { tripsTable } from "./trips";
import { usersTable } from "./users";

/**
 * Marco conversation memory: one row per user/assistant turn, scoped to a
 * single trip and a single user. The agent loads the recent tail as
 * conversation context, so Marco remembers earlier sessions — not just the
 * current page view. Rows are pruned to a bounded window per (trip, user).
 *
 * Only plain text turns are stored (role "user" | "assistant"); tool-call
 * transcripts are deliberately excluded — fresh trip data comes via tools.
 */
export const marcoMessagesTable = pgTable("marco_messages", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("marco_messages_trip_user_id_idx").on(t.tripId, t.userId, t.id),
]);

export type MarcoMessage = typeof marcoMessagesTable.$inferSelect;
