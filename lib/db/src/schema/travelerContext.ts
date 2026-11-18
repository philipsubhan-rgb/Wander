import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  boolean,
  doublePrecision,
  index,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Context layer store (architecture-north-star §4.1, Stories 6.1/6.3/6.4).
 *
 * Everything Wander knows about a traveler that is NOT passport-class
 * vault data: where they live and fly from, their hard rules and tastes,
 * and who they travel with. Owned by the Context/Profile service
 * (lib/travelerContext.ts in the api-server) — the only module that
 * reads these tables, exactly like the vault discipline in §3.3.
 *
 * Learned values (source = 'learned') carry a `confirmed` flag: a
 * learned home base/airports set is PROPOSED to the traveler and only
 * becomes the default on confirmation (Story 6.1). Explicit values are
 * born confirmed.
 */

export const contextSourceValues = ["explicit", "learned"] as const;
export type ContextSource = (typeof contextSourceValues)[number];

export const travelerContextTable = pgTable("traveler_context", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  homeBase: text("home_base"),
  homeBaseLat: doublePrecision("home_base_lat"),
  homeBaseLon: doublePrecision("home_base_lon"),
  homeBaseSource: text("home_base_source"),
  homeBaseConfirmed: boolean("home_base_confirmed").notNull().default(false),
  /** Ordered IATA codes, most-preferred first (Story 6.1). */
  homeAirports: jsonb("home_airports").$type<string[]>().notNull().default([]),
  homeAirportsSource: text("home_airports_source"),
  homeAirportsConfirmed: boolean("home_airports_confirmed").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TravelerContext = typeof travelerContextTable.$inferSelect;

/**
 * Traveler rules — the heart of §4.2. `class` decides the MECHANISM,
 * not just the label: hard rules compile to deterministic filter
 * predicates; preferences compile to ranking weights. They are never
 * stored as free text — a rule is a typed `rule_type` + jsonb `params`,
 * extended by adding a type and a predicate, never by prose.
 *
 * `scope` binds a rule to trip kind (TC-5's Egencia/Uber-Business rules
 * are work-scoped); `source` marks learned rules, which stay
 * confirmable/removable by the traveler (Story 6.4).
 */
export const ruleClassValues = ["hard", "preference"] as const;
export type RuleClass = (typeof ruleClassValues)[number];

export const ruleTypeValues = [
  "fare_class_ban",
  "changeability_required",
  "connection_airport_ban",
  "booking_channel_required",
  "rideshare_profile",
  "budget_cap",
  "stay_style",
  "seat_preference",
] as const;
export type RuleType = (typeof ruleTypeValues)[number];

export const ruleScopeValues = ["all", "work", "personal"] as const;
export type RuleScope = (typeof ruleScopeValues)[number];

export const travelerRulesTable = pgTable("traveler_rules", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  ruleClass: text("rule_class").notNull(),
  ruleType: text("rule_type").notNull(),
  params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
  scope: text("scope").notNull().default("all"),
  source: text("source").notNull().default("explicit"),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("traveler_rules_user_id_idx").on(t.userId, t.id),
]);

export type TravelerRule = typeof travelerRulesTable.$inferSelect;

/**
 * Companions — who the organizer travels with (Story 6.3). A companion
 * row stores ONLY what the organizer provided (name, email) plus, when
 * that email belongs to a Wander user, a link to their user record.
 * Never their private data — the vault is theirs alone (§3.3).
 */
export const travelerCompanionsTable = pgTable("traveler_companions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email"),
  linkedUserId: integer("linked_user_id").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("traveler_companions_user_id_idx").on(t.userId, t.id),
]);

export type TravelerCompanion = typeof travelerCompanionsTable.$inferSelect;

/**
 * Saved groups — named sets of companion references ("Munich guys").
 * Membership is by companion id so a companion edited once updates
 * every group they belong to.
 */
export const savedGroupsTable = pgTable("saved_groups", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  memberCompanionIds: jsonb("member_companion_ids").$type<number[]>().notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => [
  index("saved_groups_user_id_idx").on(t.userId, t.id),
]);

export type SavedGroup = typeof savedGroupsTable.$inferSelect;
