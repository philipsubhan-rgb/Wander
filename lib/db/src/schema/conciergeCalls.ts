import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { tripsTable } from "./trips";
import { usersTable } from "./users";
import { extrasSuggestionsTable } from "./extrasSuggestions";

/**
 * Concierge / Call Service (architecture-north-star §6.5; Stories
 * 4.1–4.5). A phone call is an EXECUTION channel — it can commit the
 * traveler's money and plans with a supplier who has no API — so it
 * is built with the Booking Gate's discipline, not beside it:
 *
 * - **Briefs are data, and no call exists without one.** `call_briefs`
 *   is the finalized, stored instruction set for a call: callee, the
 *   exact ask, ranked fallbacks, what the agent may NOT agree to, the
 *   spending authority (a money-typed cap — the call may commit only
 *   within it), and a hard duration cap. Amending the ask creates a
 *   NEW version (the old row is superseded, never silently edited),
 *   so every call is auditable against the brief that authorized it.
 * - **Confirmation before dialing.** A brief that authorizes spend
 *   must be CONFIRMED by the traveler before any call is placed, and —
 *   exactly as in the gate (§2.4) — a spend-authorizing brief cannot
 *   be confirmed on the voice channel. Information-only briefs carry
 *   NO spend authority (`authority_kind = 'info_only'`, cap columns
 *   null): an outcome claiming a booking from an info call is
 *   rejected by the outcome evaluator, never written to the ledger.
 * - **Calls are records.** `call_tasks` is one dial attempt against a
 *   brief: provider ids, transcript turns, the structured outcome
 *   report, duration, and the telephony cost estimate (ROI §7 per-call
 *   attribution). A successful outcome writes a ledger booking with
 *   `source = 'phone'` (§5.4) — indistinguishable in the ledger from
 *   an API booking — and projects it into the itinerary tables.
 * - **Card details never land here.** A phone booking that needs a
 *   card uses a single-use virtual card capped at the brief's
 *   approved total + stated tolerance (international-foundation §3.4).
 *   The task row stores only the instrument REFERENCE; the PAN/CVC
 *   exist only in the live call session and are never written to any
 *   table, transcript, or log.
 */

// ─── Value sets ──────────────────────────────────────────────────────────────

/** What the call is for (Stories 4.2 / 4.3 / 4.4 + information gathering). */
export const callBriefKindValues = [
  "book",
  "change",
  "cancel",
  "special_request",
  "info",
] as const;
export type CallBriefKind = (typeof callBriefKindValues)[number];

/**
 * Brief lifecycle: a brief is prepared (draft), then confirmed by the
 * traveler, then called against. Amending a brief supersedes the old
 * version — a superseded brief can never be confirmed or called.
 */
export const callBriefStateValues = ["draft", "confirmed", "superseded"] as const;
export type CallBriefState = (typeof callBriefStateValues)[number];

/**
 * The brief's spending authority. `spend` briefs carry a money cap the
 * call may commit within; `info_only` briefs authorize NO commitment
 * of any kind (hours/availability gathering) — their cap columns are
 * null by construction and the outcome evaluator enforces it.
 */
export const callAuthorityKindValues = ["spend", "info_only"] as const;
export type CallAuthorityKind = (typeof callAuthorityKindValues)[number];

/** One dial attempt's lifecycle (architecture §6.5: call_tasks). */
export const callTaskStateValues = [
  "queued",
  "calling",
  "completed",
  "failed",
  "escalated",
] as const;
export type CallTaskState = (typeof callTaskStateValues)[number];

/** Special-request outcomes (Story 4.4) — "noted" is never "guaranteed". */
export const callRequestOutcomeValues = [
  "granted",
  "denied",
  "noted_not_guaranteed",
] as const;
export type CallRequestOutcome = (typeof callRequestOutcomeValues)[number];

// ─── Structured payloads ─────────────────────────────────────────────────────

/** One transcript turn, as reported by the call driver / relay. */
export interface CallTranscriptTurn {
  /** "agent" (Wander) | "callee" (the venue) | "system" (call events). */
  speaker: "agent" | "callee" | "system";
  text: string;
  /** ISO timestamp when known; the relay supplies it, tests may omit. */
  at?: string;
}

/**
 * The structured outcome report for a call (Story 4.5). Produced by
 * the call driver from what the venue actually said — the service
 * treats it as a CLAIM to be evaluated against the brief's authority,
 * never as ground truth to write blindly: an over-cap total or a
 * booking claimed by an info-only call is rejected here, not booked.
 */
export interface CallOutcome {
  disposition:
    | "booked"
    | "changed"
    | "cancelled"
    | "request_noted"
    | "info_gathered"
    | "no_answer"
    | "voicemail"
    | "refused_by_venue"
    | "ambiguous";
  /** Name of the person spoken to, where obtained (Story 4.5). */
  personSpokenTo?: string | null;
  /**
   * The confirmation/reference code the venue gave — VERBATIM from the
   * call. Null means the venue gave none; the record says so rather
   * than inventing one.
   */
  confirmationCode?: string | null;
  /** The total the venue agreed (charge currency, as stated). For a
   * change call this is the additional charge / fee; for a booking,
   * the full total. Null when no money was discussed or committed. */
  agreedAmountMinor?: number | null;
  agreedCurrency?: string | null;
  /** Change/cancel terms as stated on the call, in plain language. */
  agreedTerms?: string | null;
  /** Cancellation: the refund the venue stated, when applicable. */
  refundAmountMinor?: number | null;
  refundCurrency?: string | null;
  /** Cancellation: when/how the refund arrives, in the venue's words. */
  refundTimeline?: string | null;
  /** The date/time actually booked or moved to, when it differs from
   * the brief's ask (fallbacks the venue offered and the agent took). */
  serviceDate?: string | null;
  serviceTime?: string | null;
  /** Special requests only (Story 4.4). */
  requestOutcome?: CallRequestOutcome | null;
  /** Info calls only: what was learned, in plain language. */
  infoGathered?: string | null;
  /** Follow-ups owed — by the agent, the supplier, or the traveler. */
  followUps?: string[];
  /** Free-text notes from the call driver. */
  notes?: string | null;
}

// ─── call_briefs — the brief is the authorization ────────────────────────────

export const callBriefsTable = pgTable(
  "call_briefs",
  {
    id: serial("id").primaryKey(),
    tripId: integer("trip_id")
      .notNull()
      .references(() => tripsTable.id, { onDelete: "cascade" }),
    /**
     * The gate attempt this brief executes for, when the call is a
     * gate attempt's phone fulfillment (§5.2: EXECUTING creates the
     * call task; the brief is generated from the attempt and its cap
     * is the attempt's reviewed total). Nullable — most briefs are
     * prepared directly (an accepted concierge extra, a change call).
     * Plain integer, no FK (the profile_access_log.booking_id
     * precedent): the brief can be prepared before/without the gate.
     */
    bookingAttemptId: integer("booking_attempt_id"),
    /** The existing ledger booking a change/cancel call acts on.
     * Plain integer, no FK (same precedent as above). */
    bookingId: integer("booking_id"),
    /** The accepted extras suggestion this brief arranges, when the
     * call's source is the extras pass (§7: accepted = intent; the
     * arranging rides this service). */
    extrasSuggestionId: integer("extras_suggestion_id").references(
      () => extrasSuggestionsTable.id,
      { onDelete: "set null" },
    ),
    kind: text("kind").$type<CallBriefKind>().notNull(),
    state: text("state").$type<CallBriefState>().notNull().default("draft"),
    /** Concierge category (nightlife, spa, private_tour…) — drives the
     * private-by-default visibility (§7 invariant). */
    category: text("category"),
    /** shared | private — canonical on the brief and copied to the ledger. */
    visibility: text("visibility").notNull().default("shared"),
    // Who is being called, and on whose behalf.
    calleeName: text("callee_name").notNull(),
    calleePhone: text("callee_phone").notNull(),
    /** The traveler the call acts for — vault reads key on this id. */
    travelerUserId: integer("traveler_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    /** The traveler's name AS IT APPEARS on the reservation (Story 4.1) —
     * read from the vault at brief preparation, access-logged. */
    travelerNameOnReservation: text("traveler_name_on_reservation"),
    /** User ids the resulting booking covers (payer first). */
    coveredUserIds: jsonb("covered_user_ids").$type<number[]>().notNull().default([]),
    // The ask.
    /** The specific ask, in plain language (Story 4.1). */
    ask: text("ask").notNull(),
    /** Existing confirmation/reference numbers the call may need. */
    reservationRefs: jsonb("reservation_refs").$type<string[]>().notNull().default([]),
    partySize: integer("party_size"),
    /** YYYY-MM-DD the service is for, when date-specific. */
    serviceDate: text("service_date"),
    /** The acceptable time window, as stated ("19:00–20:30", "after 18:00"). */
    serviceTimeWindow: text("service_time_window"),
    /** Acceptable alternatives, in priority order (Story 4.1). */
    fallbacks: jsonb("fallbacks").$type<string[]>().notNull().default([]),
    /** What the agent may NOT agree to, in plain language. */
    mayNotAgree: jsonb("may_not_agree").$type<string[]>().notNull().default([]),
    // Authority.
    authorityKind: text("authority_kind").$type<CallAuthorityKind>().notNull().default("spend"),
    /** The spending cap — the call's ENTIRE commitment authority.
     * Null iff authority_kind = info_only. */
    authorityLimitAmountMinor: integer("authority_limit_amount_minor"),
    authorityLimitCurrency: text("authority_limit_currency"),
    /** Stated tolerance above the cap for taxes/fees, applied ONLY to
     * the virtual card's limit (international §3.4) — never to the
     * outcome evaluation: a total above the cap does not book. */
    toleranceAmountMinor: integer("tolerance_amount_minor").notNull().default(0),
    /** Whether the venue may need a card read to it on the call. When
     * true, a capped single-use virtual card is issued at call time. */
    paymentMayBeRequired: boolean("payment_may_be_required").notNull().default(false),
    /** Hard cap on call length; enforced by the telephony layer
     * (Twilio TimeLimit) and by the brief discipline (Story 4.1). */
    durationCapSeconds: integer("duration_cap_seconds").notNull().default(600),
    /** Wander's callback number, stated in the brief (Story 4.1). */
    callbackNumber: text("callback_number"),
    // Versioning + confirmation.
    version: integer("version").notNull().default(1),
    supersedesBriefId: integer("supersedes_brief_id"),
    createdByUserId: integer("created_by_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    presentedAt: timestamp("presented_at"),
    confirmedByUserId: integer("confirmed_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    confirmedAt: timestamp("confirmed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("call_briefs_trip_idx").on(t.tripId, t.state),
    index("call_briefs_attempt_idx").on(t.bookingAttemptId),
  ],
);

export type CallBrief = typeof callBriefsTable.$inferSelect;

// ─── call_tasks — one dial attempt, fully recorded ───────────────────────────

export const callTasksTable = pgTable(
  "call_tasks",
  {
    id: serial("id").primaryKey(),
    briefId: integer("brief_id")
      .notNull()
      .references(() => callBriefsTable.id, { onDelete: "cascade" }),
    tripId: integer("trip_id")
      .notNull()
      .references(() => tripsTable.id, { onDelete: "cascade" }),
    state: text("state").$type<CallTaskState>().notNull().default("queued"),
    /** 1-based attempt number against this brief (retry pattern, Story 4.5). */
    attemptNumber: integer("attempt_number").notNull().default(1),
    /** Telephony provider id ("twilio") — null until dialed. */
    provider: text("provider"),
    providerCallId: text("provider_call_id"),
    /** Last provider status seen (queued/ringing/in-progress/completed…). */
    providerStatus: text("provider_status"),
    /**
     * The single-use virtual card's REFERENCE (never its details) when
     * one was issued for this call. PAN/CVC exist only in the live
     * call session — they are never written to this or any table.
     */
    paymentInstrumentRef: text("payment_instrument_ref"),
    startedAt: timestamp("started_at"),
    endedAt: timestamp("ended_at"),
    durationSeconds: integer("duration_seconds"),
    /** Telephony cost estimate from duration × published rates (ROI §7). */
    telephonyCostMinor: integer("telephony_cost_minor"),
    telephonyCostCurrency: text("telephony_cost_currency"),
    /** Call recording reference (provider URL/id), when recorded. */
    recordingRef: text("recording_ref"),
    transcript: jsonb("transcript").$type<CallTranscriptTurn[]>().notNull().default([]),
    /** The structured outcome report, once the call driver reports it. */
    outcome: jsonb("outcome").$type<CallOutcome>(),
    /** Plain-language result for the traveler (Story 4.5) — always set
     * when the task reaches a terminal state. */
    outcomeText: text("outcome_text"),
    /** The ledger booking this call produced, when it booked/changed. */
    bookingId: integer("booking_id"),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("call_tasks_brief_idx").on(t.briefId, t.state),
    index("call_tasks_trip_idx").on(t.tripId),
    index("call_tasks_provider_call_idx").on(t.providerCallId),
  ],
);

export type CallTask = typeof callTasksTable.$inferSelect;
