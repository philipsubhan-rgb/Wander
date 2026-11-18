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
import { flightsTable } from "./flights";
import { tripsTable } from "./trips";

/**
 * Watching / advisory pipeline store (architecture-north-star §6,
 * international-foundation §4).
 *
 * `flight_watches` — one row per legacy flight leg under watch. In the
 * full design a watch is registered at BOOKED against a Booking Ledger
 * record; in this spike it keys on the legacy `flights` table, which is
 * what exists. The watch carries the resolved FlightAware ident, the
 * AeroAPI alert registration id, and the `last_status_snapshot` every
 * incoming status is deduplicated against (§6.1) — the same delay
 * reported three times is one advisory.
 *
 * `advisories` — first-class advisory records (§6.2). An advisory never
 * books, moves, or charges anything; fixes are proposals through the
 * Booking Gate, priced when presented, not when detected (§8.3.3) —
 * which is why `proposal_payload` stores an option-set REFERENCE, never
 * priced options. Dismissal is remembered: `situation` records the
 * signature + metric of the situation the advisory fired for, and a new
 * advisory for the same flight + kind is issued only when the situation
 * worsens against it.
 */

export const flightWatchStateValues = ["active", "completed"] as const;
export type FlightWatchState = (typeof flightWatchStateValues)[number];

/**
 * The normalized status snapshot stored on a watch. Produced by the
 * AeroAPI normalization layer (api-server lib/flightaware.ts) from a
 * documented AeroAPI flight object; every dedupe/materiality comparison
 * runs against this shape, never against raw provider payloads. Times
 * are ISO 8601 instants (provider offsets preserved).
 */
export interface FlightStatusSnapshot {
  faFlightId: string | null;
  status: string | null;
  cancelled: boolean;
  diverted: boolean;
  scheduledOut: string | null;
  estimatedOut: string | null;
  actualOut: string | null;
  scheduledIn: string | null;
  estimatedIn: string | null;
  actualIn: string | null;
  gateOrigin: string | null;
  gateDestination: string | null;
  terminalOrigin: string | null;
  terminalDestination: string | null;
  /** estimatedIn (or actualIn) minus scheduledIn, minutes; null when unknown. */
  arrivalDelayMinutes: number | null;
  /** estimatedOut (or actualOut) minus scheduledOut, minutes; null when unknown. */
  departureDelayMinutes: number | null;
  /** Where this snapshot came from: a pushed alert or the T-24h lookup. */
  source: "alert" | "lookup";
  observedAt: string;
}

export const flightWatchesTable = pgTable(
  "flight_watches",
  {
    id: serial("id").primaryKey(),
    flightId: integer("flight_id")
      .notNull()
      .references(() => flightsTable.id, { onDelete: "cascade" }),
    tripId: integer("trip_id")
      .notNull()
      .references(() => tripsTable.id, { onDelete: "cascade" }),
    /** Resolved FlightAware ident (IATA designator, e.g. "UA30"). */
    ident: text("ident").notNull(),
    /** Departure date at the origin airport, "YYYY-MM-DD" — an ident is
     * reused across dates, so the date is part of the watch's identity. */
    departureDate: text("departure_date").notNull(),
    /** Learned from the first status payload; the stable per-operation id. */
    faFlightId: text("fa_flight_id"),
    /** AeroAPI alert registration id (opaque provider id, stored as text).
     * Null when FlightAware is not configured — the watch still exists
     * locally as the dedupe/snapshot store. */
    alertId: text("alert_id"),
    state: text("state").$type<FlightWatchState>().notNull().default("active"),
    lastStatusSnapshot: jsonb("last_status_snapshot").$type<FlightStatusSnapshot>(),
    snapshotAt: timestamp("snapshot_at"),
    /** The single T-24h pre-departure lookup (§8.3.1) — set once it has
     * run, so the batch can never become a polling loop. */
    predepartureCheckedAt: timestamp("predeparture_checked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("flight_watches_flight_id_unique").on(t.flightId),
    index("flight_watches_state_idx").on(t.state, t.departureDate),
  ],
);

export type FlightWatch = typeof flightWatchesTable.$inferSelect;

export const advisoryKindValues = [
  "cancellation",
  "diversion",
  "arrival_delay",
  "schedule_change",
  "gate_change",
] as const;
export type AdvisoryKind = (typeof advisoryKindValues)[number];

export const advisorySeverityValues = ["critical", "high", "medium", "low"] as const;
export type AdvisorySeverity = (typeof advisorySeverityValues)[number];

export const advisoryStateValues = ["open", "acknowledged", "acted", "dismissed"] as const;
export type AdvisoryState = (typeof advisoryStateValues)[number];

/** One downstream effect found by the impact walk (§6.2). */
export interface AdvisoryImpact {
  type:
    | "connection_risk"
    | "connection_missed"
    | "checkin_at_risk"
    | "late_arrival"
    | "reservation_at_risk"
    | "group_coherence";
  /** Plain-language line, named items included (Story 5.1/5.3/5.4). */
  detail: string;
}

/** The situation an advisory fired for — worsening is judged against it. */
export interface AdvisorySituation {
  /** Stable string identifying the situation (per kind; see watchingLogic). */
  signature: string;
  /** Comparable badness within the kind (delay minutes, shift minutes…). */
  metric: number;
}

export const advisoriesTable = pgTable(
  "advisories",
  {
    id: serial("id").primaryKey(),
    flightWatchId: integer("flight_watch_id")
      .notNull()
      .references(() => flightWatchesTable.id, { onDelete: "cascade" }),
    flightId: integer("flight_id")
      .notNull()
      .references(() => flightsTable.id, { onDelete: "cascade" }),
    tripId: integer("trip_id")
      .notNull()
      .references(() => tripsTable.id, { onDelete: "cascade" }),
    kind: text("kind").$type<AdvisoryKind>().notNull(),
    severity: text("severity").$type<AdvisorySeverity>().notNull(),
    /** What changed, in plain language. */
    summary: text("summary").notNull(),
    /** Knock-on effects in plain language; states "no downstream impact"
     * explicitly when the walk found none (international §4.2.4). */
    impactSummary: text("impact_summary").notNull(),
    impacts: jsonb("impacts").$type<AdvisoryImpact[]>().notNull().default([]),
    situation: jsonb("situation").$type<AdvisorySituation>().notNull(),
    /** Option-set REFERENCE for the fix (e.g. a rebooking search spec) —
     * priced when the traveler opens the advisory, never at detection. */
    proposalPayload: jsonb("proposal_payload").$type<Record<string, unknown>>(),
    state: text("state").$type<AdvisoryState>().notNull().default("open"),
    notifiedAt: timestamp("notified_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("advisories_trip_id_idx").on(t.tripId, t.id),
    index("advisories_watch_kind_idx").on(t.flightWatchId, t.kind, t.id),
  ],
);

export type Advisory = typeof advisoriesTable.$inferSelect;
