import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tripsTable } from "./trips";

/**
 * Extras suggestions store (architecture-north-star §7 — the extras pass
 * fires at every tier; GOAL.md "Extras thinking"; test-cases TC-8).
 *
 * Every generated itinerary gets an extras pass keyed to the trip's
 * character (golf, ski, beach, family, international, festival…): the
 * ancillary logistics a human planner would raise — club shipping, lift
 * passes, eSIMs, cribs — surfaced as priced suggestions, NEVER silently
 * booked. This table is the pass's memory:
 *
 * - One row per (trip, item_key). The unique index is the idempotency
 *   and dismissal-memory mechanism: re-running a pass inserts only item
 *   keys the trip has never seen, so a dismissed item can never
 *   re-suggest and an accepted item is never duplicated.
 * - Prices follow the international money discipline (§5.1): integer
 *   minor units + ISO currency, and a `price_nature` that is always
 *   explicit when a price exists. A suggestion may carry a price ONLY
 *   from a real source — an Options Service rail, or a labeled estimate
 *   computed from the named rate assumptions in the extras engine
 *   (detail_data carries the assumption names + inputs). Quote-only
 *   items carry `price_nature = 'quote'` and NO amount; note-only items
 *   (a check Wander runs, e.g. entry requirements) carry neither. An
 *   invented firm price is a defect (QA asserts this over fixtures).
 * - `state` is the traveler's word on the suggestion: suggested →
 *   accepted | dismissed. Accepted means "yes, I want this arranged" —
 *   the actual arranging rides the January Booking Gate / Concierge
 *   (§5/§6.5); this build never books anything.
 */

export const extrasPackValues = [
  "golf",
  "ski",
  "beach",
  "family",
  "international",
  "festival",
] as const;
export type ExtrasPack = (typeof extrasPackValues)[number];

export const extrasPriceNatureValues = ["firm", "estimate", "quote"] as const;
export type ExtrasPriceNature = (typeof extrasPriceNatureValues)[number];

export const extrasSuggestionStateValues = ["suggested", "accepted", "dismissed"] as const;
export type ExtrasSuggestionState = (typeof extrasSuggestionStateValues)[number];

/** What caused the pass that first surfaced this suggestion. */
export const extrasTriggerValues = [
  "intake_materialization",
  "flight_added",
  "stay_added",
  "on_demand",
] as const;
export type ExtrasTrigger = (typeof extrasTriggerValues)[number];

/**
 * Structured detail behind a suggestion: the generator's inputs and,
 * for computed estimates, the math — assumption names, per-unit rates,
 * quantities — so the rendered `detail` text is auditable back to the
 * labeled assumptions it came from, never a bare number.
 */
export interface ExtrasSuggestionDetailData {
  /** Rate-assumption keys (extrasLogic RATE_ASSUMPTIONS) used, if any. */
  assumptions?: string[];
  /** The three-way (or two-way) comparison lines for math items. */
  math?: Array<{
    label: string;
    /** Total in minor units; a range when the assumption is a range. */
    totalMinor: number;
    rangeMinor?: { min: number; max: number };
    currency: string;
    note?: string;
  }>;
  /** Free-form generator facts (days, golfers, stay type…). */
  facts?: Record<string, string | number | boolean>;
  [key: string]: unknown;
}

export const extrasSuggestionsTable = pgTable(
  "extras_suggestions",
  {
    id: serial("id").primaryKey(),
    tripId: integer("trip_id")
      .notNull()
      .references(() => tripsTable.id, { onDelete: "cascade" }),
    pack: text("pack").$type<ExtrasPack>().notNull(),
    /** Stable per-pack item identifier, e.g. "club_shipping". Unique per trip. */
    itemKey: text("item_key").notNull(),
    title: text("title").notNull(),
    /** Human-readable detail, including the math where the item has any. */
    detail: text("detail").notNull(),
    detailData: jsonb("detail_data").$type<ExtrasSuggestionDetailData>().notNull().default({}),
    /** Integer minor units (international money type). Null when the item
     * carries no number (quote-only or note-only). For range estimates
     * this is the range midpoint — detail_data.math carries the range. */
    priceAmountMinor: integer("price_amount_minor"),
    priceCurrency: text("price_currency"),
    /** firm | estimate | quote. Null only when there is no price at all.
     * A non-null priceAmountMinor ALWAYS has a nature — enforced in the
     * extras engine and asserted by tests. */
    priceNature: text("price_nature").$type<ExtrasPriceNature>(),
    state: text("state").$type<ExtrasSuggestionState>().notNull().default("suggested"),
    /** The pass trigger that first surfaced this item. */
    trigger: text("trigger").$type<ExtrasTrigger>().notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("extras_suggestions_trip_item_unique").on(t.tripId, t.itemKey),
    index("extras_suggestions_trip_state_idx").on(t.tripId, t.state),
  ],
);

export type ExtrasSuggestion = typeof extrasSuggestionsTable.$inferSelect;
