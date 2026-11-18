import { pgTable, serial, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { tripsTable } from "./trips";
import { usersTable } from "./users";

/**
 * Trip roster entries — party assembly decoupled from user accounts
 * (architecture-north-star §3.2, ADR-5).
 *
 * `trip_participants.user_id` is NOT NULL and the legacy invite flow creates
 * a full account (with a temp password handed to the trip admin), which is
 * irreconcilable with Stories 4.3/5.1/5.2: a named traveler may not be a
 * Wander user yet, and the organizer must never touch their credentials or
 * profile contents. So a named traveler starts life as a roster entry —
 * the name + email the organizer supplied, and nothing else — and links to
 * a `users` row only when the traveler claims the invite and sets up their
 * own private profile (the outreach step; not built with intake).
 *
 * `status` tracks the organizer-visible projection only:
 * invited → setting_up → ready, plus needs_attention / declined.
 * `missing_fields` holds field NAMES (never values) — it is what chase
 * reminders and the organizer's "waiting on passport details" both read.
 */
export const rosterEntryStatusValues = [
  "invited",
  "setting_up",
  "ready",
  "needs_attention",
  "declined",
] as const;
export type RosterEntryStatus = (typeof rosterEntryStatusValues)[number];

export const tripRosterEntriesTable = pgTable("trip_roster_entries", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  invitedName: text("invited_name").notNull(),
  // Nullable: a traveler can be named before their email is known (the
  // intake PARTY state tracks the missing email as an open item). Outreach
  // can only chase entries that have an email.
  invitedEmail: text("invited_email"),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  status: text("status").notNull().default("invited"),
  requiredFieldsProfile: jsonb("required_fields_profile").$type<string[]>(),
  missingFields: jsonb("missing_fields").$type<string[]>(),
  chaseState: jsonb("chase_state").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("trip_roster_entries_trip_id_idx").on(t.tripId, t.id),
  index("trip_roster_entries_user_id_idx").on(t.userId),
]);

export type TripRosterEntry = typeof tripRosterEntriesTable.$inferSelect;
