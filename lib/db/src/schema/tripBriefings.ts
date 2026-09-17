import { pgTable, serial, integer, text, boolean, timestamp, doublePrecision } from "drizzle-orm/pg-core";
import { tripsTable } from "./trips";

export const tripBriefingsTable = pgTable("trip_briefings", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().unique().references(() => tripsTable.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  sendTimeLocal: text("send_time_local").notNull().default("07:00"),
  timezone: text("timezone").notNull().default("America/New_York"),
  extraEmails: text("extra_emails").array().notNull().default([]),
  cachedLat: doublePrecision("cached_lat"),
  cachedLon: doublePrecision("cached_lon"),
  lastSentForDate: text("last_sent_for_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type TripBriefing = typeof tripBriefingsTable.$inferSelect;
export type NewTripBriefing = typeof tripBriefingsTable.$inferInsert;
