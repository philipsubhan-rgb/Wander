import { pgTable, serial, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { tripsTable } from "./trips";
import { usersTable } from "./users";

/**
 * Intake sessions — the server-side state machine behind Marco's planner
 * intake (architecture-north-star §2, ADR-2/ADR-3).
 *
 * A session is owned by one authenticated user (the organizer-to-be) and
 * exists BEFORE any trip does: the conversation that creates a trip needs
 * somewhere to live. `slots` holds the captured slot values, each with its
 * provenance (`asked` / `stated` / `from_context` / `inferred`) plus the
 * machine's `intentCaptured` flag — the typed shape lives in the API
 * server's intakeLogic module; here it is deliberately loose JSON so the
 * db package carries no app-logic types.
 *
 * `state` is a stored cache of the state machine's derived state
 * (OPENING → DESTINATION → PARTY → DATES → STYLE → REVIEW → MATERIALIZED),
 * recomputed and persisted on every write. `open_items` lists slots (or
 * sub-items like `party_email:<name>`) the traveler explicitly skipped —
 * a skip marks the item open, never blocks (Story 1.3).
 *
 * At materialization `draft_trip_id` points at the created trip and the
 * session's marco_messages rows are re-keyed to it (ADR-3).
 */
export const intakeSessionsTable = pgTable("intake_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("OPENING"),
  slots: jsonb("slots").$type<Record<string, unknown>>().notNull().default({}),
  openItems: jsonb("open_items").$type<string[]>().notNull().default([]),
  draftTripId: integer("draft_trip_id").references(() => tripsTable.id, { onDelete: "set null" }),
  channel: text("channel").notNull().default("text"),
  questionsAsked: integer("questions_asked").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("intake_sessions_user_id_idx").on(t.userId, t.id),
]);

export type IntakeSession = typeof intakeSessionsTable.$inferSelect;
