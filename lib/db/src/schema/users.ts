import { pgTable, serial, text, timestamp, pgEnum, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userRoleEnum = pgEnum("user_role", ["super_admin", "admin", "traveler"]);

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  role: userRoleEnum("role").notNull().default("traveler"),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  // International foundation (international-foundation §5): traveler profile
  // locale fields. All nullable — locale resolves profile → device → trip →
  // English (§1.2); without a home_currency no converted figure is shown
  // (charge currency only, §2.2). The columns exist BEFORE the profile UI
  // so no feature bakes in a monolingual / single-currency assumption.
  locale: text("locale"), // BCP 47, e.g. "es", "de-DE" — UI language
  homeCurrency: text("home_currency"), // ISO 4217, e.g. "EUR" — display currency for converted figures
  timezone: text("timezone"), // IANA, e.g. "America/New_York" — the traveler's own zone (NOT event zones)
  conversationLanguage: text("conversation_language"), // BCP 47 — Marco's language with this traveler; may differ from UI locale
  // Notification preferences (Story 5.1 thresholds are per-traveler):
  // channel list (e.g. ["push", "email"]) + quiet hours in the traveler's
  // own timezone above, stored as local "HH:MM" wall-clock strings.
  notificationChannels: jsonb("notification_channels").$type<string[]>(),
  quietHoursStart: text("quiet_hours_start"),
  quietHoursEnd: text("quiet_hours_end"),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
