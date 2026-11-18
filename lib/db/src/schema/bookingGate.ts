import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { tripsTable } from "./trips";
import { usersTable } from "./users";
import { tripRosterEntriesTable } from "./tripRosterEntries";
import { flightsTable } from "./flights";
import { accommodationsTable } from "./accommodations";
import { reservationsTable } from "./reservations";
import { carRentalsTable } from "./carRentals";

/**
 * Booking Gate + Booking Ledger (architecture-north-star §5.2–§5.4,
 * Stories 3.1–3.3, 7.1/7.2/7.4).
 *
 * Every booking in Wander passes through ONE gate state machine
 * (`booking_attempts`): PRESENTED → REVERIFYING → REVIEW → CONFIRMED →
 * EXECUTING → BOOKED | FAILED. There is no execution path that skips
 * confirmation — the gate service is the only writer of these tables,
 * and its transitions are typed, never ad-hoc status strings.
 *
 * `bookings` is the LEDGER: the canonical record of money that moved.
 * Legacy itinerary rows (flights / accommodations / reservations /
 * car_rentals) are PROJECTIONS written from the ledger on success —
 * the ledger is the fact, the itinerary is its display. All money is
 * the international type: integer minor units + ISO currency, charge
 * currency stored untouched; a home equivalent exists only with an
 * FX snapshot behind it.
 *
 * Coverage lives in two parallel tables on purpose: the gate tracks
 * per-traveler confirmations on the ATTEMPT (`booking_attempt_travelers`)
 * before any money exists; on BOOKED the coverage is copied to the
 * ledger (`booking_travelers`), which is what itinerary attribution
 * and per-traveler calendar write-back read.
 *
 * Visibility: gate-created itinerary items carry a visibility flag
 * (shared | private) on the attempt AND the ledger row — concierge-
 * category items default to private (QA flag: the flag lands when
 * items become itinerary items). The legacy itinerary tables have no
 * visibility column; the ledger row every gate-created item points
 * back to is where the flag is canonical.
 */

// ─── Value sets ──────────────────────────────────────────────────────────────

export const bookingGateStateValues = [
  "presented",
  "reverifying",
  "review",
  "confirmed",
  "executing",
  "booked",
  "failed",
] as const;
export type BookingGateState = (typeof bookingGateStateValues)[number];

export const bookingStatusValues = [
  "confirmed",
  /** Provider accepted the create (HTTP 202) but has not confirmed yet. */
  "pending",
  "changed",
  "cancelled",
  "failed",
] as const;
export type BookingStatus = (typeof bookingStatusValues)[number];

export const bookingSourceValues = ["api_rail", "phone", "ingested", "quote_flow"] as const;
export type BookingSource = (typeof bookingSourceValues)[number];

export const bookingVisibilityValues = ["shared", "private"] as const;
export type BookingVisibility = (typeof bookingVisibilityValues)[number];

/** Why this option — recorded at presentation time, from fit inputs only (§5.5). */
export const whyThisOptionValues = [
  "best_price",
  "best_schedule",
  "only_option",
  "traveler_chose",
] as const;
export type WhyThisOption = (typeof whyThisOptionValues)[number];

export const commissionStatusValues = [
  "expected",
  "confirmed",
  "paid",
  "clawed_back",
  /** No rail exists for this booking — recorded explicitly, never a null (Story 7.2). */
  "no_rail",
] as const;
export type CommissionStatus = (typeof commissionStatusValues)[number];

export const commissionBasisValues = ["rate", "flat"] as const;
export type CommissionBasis = (typeof commissionBasisValues)[number];

/**
 * The option exactly as presented (§5.2): the normalized WanderOption
 * JSON from the Options Service, snapshotted so the review surface and
 * the ledger describe what the traveler actually saw — not whatever
 * the provider would say later.
 */
export interface BookingOptionSnapshot {
  option: Record<string, unknown>;
  /** The presented set's size and this option's fit position, when known. */
  setSize?: number;
  /** Fit reasons as voiced at presentation (fit inputs only, §5.5). */
  fitReasons?: string[];
}

// ─── booking_attempts — the gate ─────────────────────────────────────────────

export const bookingAttemptsTable = pgTable(
  "booking_attempts",
  {
    id: serial("id").primaryKey(),
    tripId: integer("trip_id")
      .notNull()
      .references(() => tripsTable.id, { onDelete: "cascade" }),
    /** flight | stay | rail | car | activity | charter | transfer (OptionKind). */
    kind: text("kind").notNull(),
    /** Which adapter produced the option ("duffel"); null for phone-only items. */
    adapter: text("adapter"),
    supplier: text("supplier").notNull(),
    /** Adapter-scoped option id (e.g. the Duffel offer id) — the re-quote handle. */
    optionId: text("option_id").notNull(),
    optionSnapshot: jsonb("option_snapshot").$type<BookingOptionSnapshot>().notNull(),
    state: text("state").$type<BookingGateState>().notNull().default("presented"),
    /** shared | private — concierge categories default to private. */
    visibility: text("visibility").$type<BookingVisibility>().notNull().default("shared"),
    /** Concierge category when the item came through the concierge catalog. */
    category: text("category"),
    /** The total as PRESENTED (charge currency, supplier-quoted, untouched). */
    presentedAmountMinor: integer("presented_amount_minor").notNull(),
    presentedCurrency: text("presented_currency").notNull(),
    /** The total as last RE-VERIFIED — the only total a confirmation binds to. */
    reviewedAmountMinor: integer("reviewed_amount_minor"),
    reviewedCurrency: text("reviewed_currency"),
    /** Bumps every time re-verification changes the reviewed total. */
    reviewVersion: integer("review_version").notNull().default(0),
    /** Home-currency display equivalent of the reviewed total, snapshot-backed only. */
    homeEquivalentMinor: integer("home_equivalent_minor"),
    homeCurrency: text("home_currency"),
    fxSnapshotId: integer("fx_snapshot_id"),
    /** Terms as presented at REVIEW, in plain language (§5.2). */
    changeTerms: text("change_terms"),
    cancelTerms: text("cancel_terms"),
    whyThisOption: text("why_this_option").$type<WhyThisOption>().notNull().default("traveler_chose"),
    /** The why in traveler words, generated from fit inputs only (§5.5). */
    whyThisOptionText: text("why_this_option_text"),
    /** Hash of the ranking inputs — enough to reproduce why this option ranked (§5.4). */
    rankingInputsHash: text("ranking_inputs_hash"),
    /** The channel execution would run through ("duffel", "egencia", "phone"…). */
    executionChannel: text("execution_channel"),
    confirmedByUserId: integer("confirmed_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at"),
    /** Plain-language failure reason when state = failed (Story 3.3). */
    failureReason: text("failure_reason"),
    /**
     * The ledger booking this attempt produced. Plain integer, no FK
     * (the profile_access_log.booking_id precedent): the attempt is
     * written before the booking exists.
     */
    bookingId: integer("booking_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("booking_attempts_trip_state_idx").on(t.tripId, t.state),
    index("booking_attempts_booking_idx").on(t.bookingId),
  ],
);

export type BookingAttempt = typeof bookingAttemptsTable.$inferSelect;

// ─── booking_attempt_travelers — coverage + confirmation tracking ────────────

export const bookingAttemptTravelersTable = pgTable(
  "booking_attempt_travelers",
  {
    id: serial("id").primaryKey(),
    attemptId: integer("attempt_id")
      .notNull()
      .references(() => bookingAttemptsTable.id, { onDelete: "cascade" }),
    /** Set when the covered traveler is a claimed roster entry / user. */
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    /** Set when the covered traveler is still a roster entry (§3.2). */
    rosterEntryId: integer("roster_entry_id").references(() => tripRosterEntriesTable.id, {
      onDelete: "set null",
    }),
    isPayer: boolean("is_payer").notNull().default(false),
    /** When THIS traveler confirmed their own coverage — per-traveler
     * tracking: partial states are visible, never assumed (§5.3). */
    confirmedAt: timestamp("confirmed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("booking_attempt_travelers_attempt_idx").on(t.attemptId)],
);

export type BookingAttemptTraveler = typeof bookingAttemptTravelersTable.$inferSelect;

// ─── bookings — the ledger ───────────────────────────────────────────────────

/** Per-booking cost attribution beyond the headline columns (ROI §7). */
export interface BookingCostAttribution {
  /** Duffel searches consumed by the session that produced this booking. */
  duffelSearchesAttributed?: number;
  flightawareAlertsDelivered?: number;
  flightawareLookups?: number;
  /** Searches-to-booking ratio headroom note, when computed. */
  [key: string]: unknown;
}

export const bookingsTable = pgTable(
  "bookings",
  {
    id: serial("id").primaryKey(),
    attemptId: integer("attempt_id").references(() => bookingAttemptsTable.id, {
      onDelete: "set null",
    }),
    tripId: integer("trip_id")
      .notNull()
      .references(() => tripsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    supplier: text("supplier").notNull(),
    confirmationCode: text("confirmation_code"),
    status: text("status").$type<BookingStatus>().notNull().default("confirmed"),
    source: text("source").$type<BookingSource>().notNull().default("api_rail"),
    /** Charge currency totals — the money the traveler actually committed. */
    chargeAmountMinor: integer("charge_amount_minor").notNull(),
    chargeCurrency: text("charge_currency").notNull(),
    /** What the provider reports as actually charged; null until known. */
    amountActuallyChargedMinor: integer("amount_actually_charged_minor"),
    homeEquivalentMinor: integer("home_equivalent_minor"),
    homeCurrency: text("home_currency"),
    fxSnapshotId: integer("fx_snapshot_id"),
    merchantOfRecord: text("merchant_of_record").notNull(),
    changeTerms: text("change_terms"),
    cancelTerms: text("cancel_terms"),
    whyThisOption: text("why_this_option").$type<WhyThisOption>().notNull().default("traveler_chose"),
    whyThisOptionText: text("why_this_option_text"),
    rankingInputsHash: text("ranking_inputs_hash"),
    visibility: text("visibility").$type<BookingVisibility>().notNull().default("shared"),
    /** Cost attribution (ROI §7): what the rail charged Wander. */
    railProvider: text("rail_provider"),
    railOrderFeeMinor: integer("rail_order_fee_minor"),
    railPctFeeMinor: integer("rail_pct_fee_minor"),
    railFeeCurrency: text("rail_fee_currency"),
    /** Set only when Wander is merchant of record; null on rail bookings. */
    processingFeeMinor: integer("processing_fee_minor"),
    costAttribution: jsonb("cost_attribution").$type<BookingCostAttribution>().notNull().default({}),
    /** The provider's own order id (e.g. Duffel order id). */
    providerOrderId: text("provider_order_id"),
    // Projection links — the legacy itinerary rows this booking produced.
    flightId: integer("flight_id").references(() => flightsTable.id, { onDelete: "set null" }),
    accommodationId: integer("accommodation_id").references(() => accommodationsTable.id, {
      onDelete: "set null",
    }),
    reservationId: integer("reservation_id").references(() => reservationsTable.id, {
      onDelete: "set null",
    }),
    carRentalId: integer("car_rental_id").references(() => carRentalsTable.id, {
      onDelete: "set null",
    }),
    /** Every projected legacy row id, for multi-row projections (round trips). */
    projection: jsonb("projection").$type<Record<string, unknown>>().notNull().default({}),
    /** Watching (§5.4): the FlightAware ident + alert registration, when registered. */
    flightawareIdent: text("flightaware_ident"),
    alertRegistrationId: text("alert_registration_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("bookings_trip_idx").on(t.tripId),
    index("bookings_attempt_idx").on(t.attemptId),
  ],
);

export type Booking = typeof bookingsTable.$inferSelect;

// ─── booking_travelers — ledger coverage (Story 3.2 attribution) ─────────────

export const bookingTravelersTable = pgTable(
  "booking_travelers",
  {
    id: serial("id").primaryKey(),
    bookingId: integer("booking_id")
      .notNull()
      .references(() => bookingsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    rosterEntryId: integer("roster_entry_id").references(() => tripRosterEntriesTable.id, {
      onDelete: "set null",
    }),
    isPayer: boolean("is_payer").notNull().default(false),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("booking_travelers_booking_idx").on(t.bookingId)],
);

export type BookingTraveler = typeof bookingTravelersTable.$inferSelect;

// ─── booking_splits — charge-currency cost shares (§5.4) ─────────────────────

export const bookingSplitsTable = pgTable(
  "booking_splits",
  {
    id: serial("id").primaryKey(),
    bookingId: integer("booking_id")
      .notNull()
      .references(() => bookingsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    rosterEntryId: integer("roster_entry_id").references(() => tripRosterEntriesTable.id, {
      onDelete: "set null",
    }),
    /** Share in the booking's CHARGE currency; remainder lands on the organizer (§5.4). */
    shareAmountMinor: integer("share_amount_minor").notNull(),
    shareCurrency: text("share_currency").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("booking_splits_booking_idx").on(t.bookingId)],
);

export type BookingSplit = typeof bookingSplitsTable.$inferSelect;

// ─── commission_records — per-booking commission (Story 7.2) ─────────────────

export const commissionRecordsTable = pgTable(
  "commission_records",
  {
    id: serial("id").primaryKey(),
    bookingId: integer("booking_id")
      .notNull()
      .references(() => bookingsTable.id, { onDelete: "cascade" }),
    /** Partner/program name ("duffel", "viator", …) — null only when no rail exists. */
    partnerProgram: text("partner_program"),
    basis: text("basis").$type<CommissionBasis>(),
    /** Rate in basis points when basis = rate. */
    rateBps: integer("rate_bps"),
    expectedAmountMinor: integer("expected_amount_minor"),
    expectedCurrency: text("expected_currency"),
    status: text("status").$type<CommissionStatus>().notNull(),
    /** Machine-readable reason when status = no_rail (Story 7.4 makes the
     * trade-off visible: "traveler_best_no_rail", "no_rail_for_supplier"…). */
    noRailReason: text("no_rail_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [index("commission_records_booking_idx").on(t.bookingId)],
);

export type CommissionRecord = typeof commissionRecordsTable.$inferSelect;
