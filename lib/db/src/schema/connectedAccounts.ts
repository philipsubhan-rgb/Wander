import { pgTable, serial, text, timestamp, integer, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tripsTable } from "./trips";
import { usersTable } from "./users";

/**
 * Connected email accounts for reservation ingestion. A user can connect
 * multiple accounts (not everyone has Google); each account is scanned for
 * booking confirmations which become reservation proposals.
 *
 * OAuth tokens are stored encrypted (AES-256-GCM, KEK from CREDENTIALS_KEK).
 * Never store plaintext tokens here.
 */
export const connectedAccountsTable = pgTable("connected_accounts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().default("google"),
  email: text("email").notNull(),
  encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
  scopes: text("scopes"),
  lastHistoryId: text("last_history_id"),
  lastScanAt: timestamp("last_scan_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("connected_accounts_user_email_idx").on(t.userId, t.provider, t.email),
  index("connected_accounts_user_id_idx").on(t.userId),
]);

export type ConnectedAccount = typeof connectedAccountsTable.$inferSelect;

export const proposalStatusEnum = ["pending", "accepted", "rejected"] as const;

/**
 * Reservation proposals parsed from booking-confirmation emails.
 * Propose-first: nothing lands in `reservations` until the user accepts.
 * tripId is null when the dates don't match exactly one of the user's trips —
 * the user picks the trip at accept time.
 */
export const reservationProposalsTable = pgTable("reservation_proposals", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  accountId: integer("account_id").references(() => connectedAccountsTable.id, { onDelete: "set null" }),
  tripId: integer("trip_id").references(() => tripsTable.id, { onDelete: "cascade" }),
  messageId: text("message_id").notNull(),
  subject: text("subject"),
  sender: text("sender"),
  receivedAt: timestamp("received_at"),
  parsed: jsonb("parsed").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("reservation_proposals_account_message_idx").on(t.accountId, t.messageId),
  index("reservation_proposals_user_status_idx").on(t.userId, t.status),
]);

export type ReservationProposal = typeof reservationProposalsTable.$inferSelect;

/** Shape of the `parsed` JSON blob (see reservationParser). */
export interface ParsedReservation {
  type: "restaurant" | "attraction" | "tour" | "transport" | "event" | "spa" | "other";
  title: string;
  venue?: string;
  date?: string;
  time?: string;
  endTime?: string;
  confirmationCode?: string;
  numberOfPeople?: number;
  price?: string;
  url?: string;
  notes?: string;
  confidence: "high" | "medium" | "low";
  source: string;
}
