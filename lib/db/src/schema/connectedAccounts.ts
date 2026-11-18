import { pgTable, serial, text, timestamp, integer, jsonb, boolean, index, uniqueIndex } from "drizzle-orm/pg-core";
import { tripsTable } from "./trips";
import { usersTable } from "./users";
import { reservationsTable } from "./reservations";
import { flightsTable } from "./flights";
import { accommodationsTable } from "./accommodations";
import { carRentalsTable } from "./carRentals";

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
  // Calendar write-back (Google Calendar): per-account opt-in toggle. Only
  // meaningful once the account has granted the calendar.events scope.
  calendarWritebackEnabled: boolean("calendar_writeback_enabled").notNull().default(false),
  // The dedicated "Wander" calendar's Google calendar ID for this account
  // (created lazily on first sync). Null until then.
  calendarId: text("calendar_id"),
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

/** The itinerary item kinds calendar write-back covers (§6/§9 extension). */
export const calendarItemTypeValues = ["reservation", "flight", "accommodation", "car_rental"] as const;
export type CalendarItemType = (typeof calendarItemTypeValues)[number];

/**
 * Links between Wander itinerary items and the Google Calendar events
 * created for them by write-back. One link per (account, item): each
 * traveler with write-back enabled gets their own event on their own
 * "Wander" calendar. Storing the Google event ID + a hash of the
 * last-pushed payload makes sync idempotent — re-accepting or
 * re-syncing updates the existing event instead of creating a
 * duplicate, and deleting the item deletes its events.
 *
 * Originally reservation-only (migration 0005); migration 0016 widened
 * the table to every itinerary item kind. Exactly one of the four item
 * FK columns is set per row, matching `item_type` (enforced by a CHECK
 * in the migration; the sync layer only ever writes one). The legacy
 * `reservation_id` column stays for reservation links.
 */
export const calendarEventLinksTable = pgTable("calendar_event_links", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  accountId: integer("account_id").notNull().references(() => connectedAccountsTable.id, { onDelete: "cascade" }),
  itemType: text("item_type").$type<CalendarItemType>().notNull().default("reservation"),
  reservationId: integer("reservation_id").references(() => reservationsTable.id, { onDelete: "cascade" }),
  flightId: integer("flight_id").references(() => flightsTable.id, { onDelete: "cascade" }),
  accommodationId: integer("accommodation_id").references(() => accommodationsTable.id, { onDelete: "cascade" }),
  carRentalId: integer("car_rental_id").references(() => carRentalsTable.id, { onDelete: "cascade" }),
  googleCalendarId: text("google_calendar_id").notNull(),
  googleEventId: text("google_event_id").notNull(),
  lastSyncedHash: text("last_synced_hash").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  uniqueIndex("calendar_event_links_account_reservation_idx").on(t.accountId, t.reservationId),
  uniqueIndex("calendar_event_links_account_flight_idx").on(t.accountId, t.flightId),
  uniqueIndex("calendar_event_links_account_accommodation_idx").on(t.accountId, t.accommodationId),
  uniqueIndex("calendar_event_links_account_car_rental_idx").on(t.accountId, t.carRentalId),
  index("calendar_event_links_reservation_idx").on(t.reservationId),
  index("calendar_event_links_flight_idx").on(t.flightId),
  index("calendar_event_links_accommodation_idx").on(t.accommodationId),
  index("calendar_event_links_car_rental_idx").on(t.carRentalId),
  index("calendar_event_links_user_idx").on(t.userId),
]);

export type CalendarEventLink = typeof calendarEventLinksTable.$inferSelect;

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
