import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { tripRosterEntriesTable } from "./tripRosterEntries";

/**
 * Traveler invite tokens — the credential behind the account-wall-free
 * setup link (architecture-north-star §3.4, Stories 4.1/4.3).
 *
 * Shape copied from `password_reset_tokens`, with one deliberate
 * improvement: only the SHA-256 hash of the raw token is stored (the
 * reset-token precedent stores raw). The raw token exists only in the
 * emailed link (and in a share link the organizer explicitly requests).
 *
 * Lifecycle: issued on organizer-confirmed invite send (never before);
 * single-use — the setup submission consumes it (`used_at`); reissuing
 * (resend / new reminder link) deletes prior unused rows for the entry,
 * which is what invalidates the old link; expiry is in days, not hours
 * (travelers don't respond in an hour — exact TTL is config, see
 * OUTREACH_CONFIG in the api-server's outreachLogic).
 */
export const travelerInviteTokensTable = pgTable("traveler_invite_tokens", {
  id: serial("id").primaryKey(),
  rosterEntryId: integer("roster_entry_id")
    .notNull()
    .references(() => tripRosterEntriesTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  index("traveler_invite_tokens_roster_entry_id_idx").on(t.rosterEntryId),
]);

export type TravelerInviteToken = typeof travelerInviteTokensTable.$inferSelect;
