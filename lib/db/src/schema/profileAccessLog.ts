import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Profile access log (architecture-north-star §3.1, Story 5.2).
 *
 * Every vault DECRYPT writes one row, in the same transaction as the
 * read: who/what accessed the profile, for what purpose, and which field
 * NAMES were accessed — never values. Derived checks (completeness,
 * passport validity) also log, with the field names whose presence or
 * plaintext value was consulted, and the authorized-use read path logs
 * every field it returns a stored value for — plaintext fields included
 * — so the owner's log shows every touch.
 *
 * The owner can read their own full log. Nobody else can read it at all
 * — the log itself would leak trip patterns (§3.1). There is no admin
 * or super_admin read path, by design (§3.3).
 */
export const profileAccessPurposeValues = [
  "owner_view",
  "booking_execution",
  "derived_check",
  "agent_task",
] as const;
export type ProfileAccessPurpose = (typeof profileAccessPurposeValues)[number];

export const profileAccessorKindValues = ["user", "agent", "system"] as const;
export type ProfileAccessorKind = (typeof profileAccessorKindValues)[number];

export const profileAccessLogTable = pgTable("profile_access_log", {
  id: serial("id").primaryKey(),
  /** The profile's owner — the only person who may read these rows. */
  profileUserId: integer("profile_user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  /** "user" | "agent" | "system" — see profileAccessorKindValues. */
  accessorKind: text("accessor_kind").notNull(),
  /** Set only when accessorKind is "user". */
  accessorUserId: integer("accessor_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  /** One of profileAccessPurposeValues. */
  purpose: text("purpose").notNull(),
  /** Field NAMES accessed (e.g. ["passport_number"]) — never values. */
  fieldsAccessed: text("fields_accessed").array().notNull().default([]),
  /**
   * The booking this access served, when applicable. Plain integer, no
   * FK: the Booking Ledger (§5.4) is a later build; the column exists now
   * so access rows written today can be joined once it lands.
   */
  bookingId: integer("booking_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("profile_access_log_profile_user_id_idx").on(t.profileUserId, t.id),
]);

export type ProfileAccessLogEntry = typeof profileAccessLogTable.$inferSelect;
