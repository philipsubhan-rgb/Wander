/**
 * Concierge-Call Service (architecture-north-star §6.5; Stories
 * 4.1–4.5).
 *
 * Wander's white-glove execution channel: phone calls that make and
 * change reservations where no API exists. A call is an execution
 * channel, so this service is built with the Booking Gate's
 * discipline, not beside it:
 *
 *   BRIEF → CONFIRM → DIAL → OUTCOME (evaluated) → LEDGER
 *
 * - **No brief, no call.** A call exists only against a stored,
 *   complete brief (conciergeCallLogic.validateBriefCompleteness) —
 *   the brief is the agent's entire authorization: the ask, the
 *   ranked fallbacks, the may-not list, the money cap, the duration
 *   cap.
 * - **Confirmation before dialing.** A spend-authorizing brief must
 *   be confirmed by the traveler first, and — exactly as the gate
 *   enforces for bookings (§2.4) — a spend brief cannot be confirmed
 *   on the voice channel: voice proposes, screen confirms.
 *   Information-only briefs authorize no spend and may be confirmed
 *   on any channel, because there is nothing to spend.
 * - **Outcomes are claims, evaluated.** What the venue reportedly
 *   agreed is checked against the brief's authority before anything
 *   reaches the Booking Ledger: over-cap totals never book, an
 *   info-only call never books, and a confirmation code is recorded
 *   verbatim — or recorded as absent, never invented.
 * - **Card details never persist.** When a call may need payment, a
 *   single-use virtual card capped at the brief's total + tolerance
 *   is issued at dial time; only its reference is stored. The PAN/CVC
 *   are returned once, in memory, to the live call session.
 *
 * Live telephony verification awaits Twilio keys + Phil's
 * call-authority/recording-consent decisions (Packet #1). With no
 * keys configured, placeCall says so plainly and dials nothing.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  bookingAttemptsTable,
  bookingAttemptTravelersTable,
  bookingsTable,
  bookingTravelersTable,
  bookingSplitsTable,
  callBriefsTable,
  callTasksTable,
  commissionRecordsTable,
  extrasSuggestionsTable,
  reservationsTable,
  tripParticipantsTable,
  type Booking,
  type CallBrief,
  type CallOutcome,
  type CallTask,
  type CallTranscriptTurn,
  type Reservation,
} from "@workspace/db";
import { formatMoney, money, type Money } from "@workspace/money";
import { readProfileFields, type ProfileFieldName } from "./travelerProfile";
import {
  syncReservationForUser,
  deleteLinkedCalendarEvents,
  updateLinkedCalendarEvents,
} from "./calendarSync";
import { getTelephonyConfig, type TelephonyConfig } from "./telephony";
import {
  getPaymentInstrumentProvider,
  type IssuedCard,
  type PaymentInstrumentProvider,
} from "./virtualCards";
import { computeBookingSplits, defaultVisibility } from "./bookingGateLogic";
import {
  billedMinutes,
  estimateCallCost,
  evaluateOutcome,
  formatBriefText,
  mapProviderStatus,
  reservationTypeForBrief,
  retryDecision,
  validateBriefCompleteness,
  CALL_RETRY_POLICY,
  type OutcomeEvaluation,
} from "./conciergeCallLogic";
import { logger } from "./logger";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class CallAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallAccessDenied";
  }
}

export class CallNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallNotFound";
  }
}

/** An operational refusal — the brief/task is left as-is and the
 * reason is stated in plain language. */
export class CallRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "CallRefused";
  }
}

// ─── Deps (injectable; tests drive everything through these) ─────────────────

export interface ConciergeCallDeps {
  /** undefined = from env; a config with provider null = unconfigured. */
  telephony?: TelephonyConfig;
  /** undefined = from env; null = no card issuer configured. */
  cardProvider?: PaymentInstrumentProvider | null;
  readProfile?: typeof readProfileFields;
  syncReservation?: (userId: number, reservation: Reservation) => Promise<void>;
  deleteReservationCalendar?: (reservationId: number) => Promise<void>;
  updateReservationCalendar?: (reservation: Reservation) => Promise<void>;
  now?: () => Date;
}

export interface Actor {
  userId: number;
  role: string;
  channel?: "text" | "voice";
}

export interface PrepareBriefInput {
  tripId: number;
  kind: CallBrief["kind"];
  calleeName: string;
  calleePhone: string;
  ask: string;
  category?: string | null;
  visibility?: "shared" | "private";
  travelerUserId?: number;
  coveredUserIds?: number[];
  reservationRefs?: string[];
  partySize?: number | null;
  serviceDate?: string | null;
  serviceTimeWindow?: string | null;
  fallbacks?: string[];
  mayNotAgree?: string[];
  /** Omit for an information-only brief (kind "info" defaults to it). */
  authorityKind?: "spend" | "info_only";
  authorityLimit?: Money | null;
  toleranceAmountMinor?: number;
  paymentMayBeRequired?: boolean;
  durationCapSeconds?: number;
  callbackNumber?: string | null;
  bookingAttemptId?: number | null;
  bookingId?: number | null;
  extrasSuggestionId?: number | null;
}

export interface ConfirmBriefResult {
  confirmed: boolean;
  reason: string;
  brief: CallBrief;
}

export interface PlaceCallResult {
  placed: boolean;
  reason?: string;
  task?: CallTask;
  /**
   * ⚠ Session-only: the virtual card's details for the live call
   * session to read to the venue. Returned ONCE, in memory — callers
   * (the call driver) must never persist or log this. The Marco tool
   * façade strips it from tool results entirely.
   */
  cardDetails?: IssuedCard;
}

export interface RecordOutcomeResult {
  task: CallTask;
  evaluation: OutcomeEvaluation;
  booking?: Booking;
  /** True when the task was already terminal — the duplicate report
   * changed nothing (a call outcome never double-books). */
  alreadyRecorded?: boolean;
}

const NAME_FIELDS: readonly ProfileFieldName[] = [
  "legal_first_name",
  "legal_middle_name",
  "legal_last_name",
  "phone",
];

/** Default hard duration cap when a brief doesn't state one (10 min —
 * the brief-capped shape behind the ROI model's ~$0.80/call). */
export const DEFAULT_DURATION_CAP_SECONDS = 600;

// ─── The service ─────────────────────────────────────────────────────────────

export class ConciergeCallService {
  private readonly telephony: TelephonyConfig;
  private readonly cardProvider: PaymentInstrumentProvider | null;
  private readonly readProfile: typeof readProfileFields;
  private readonly syncReservation: NonNullable<ConciergeCallDeps["syncReservation"]>;
  private readonly deleteReservationCalendar: NonNullable<ConciergeCallDeps["deleteReservationCalendar"]>;
  private readonly updateReservationCalendar: NonNullable<ConciergeCallDeps["updateReservationCalendar"]>;
  private readonly now: () => Date;

  constructor(deps: ConciergeCallDeps = {}) {
    this.telephony = deps.telephony ?? getTelephonyConfig();
    this.cardProvider =
      deps.cardProvider !== undefined ? deps.cardProvider : getPaymentInstrumentProvider();
    this.readProfile = deps.readProfile ?? readProfileFields;
    this.syncReservation = deps.syncReservation ?? syncReservationForUser;
    this.deleteReservationCalendar =
      deps.deleteReservationCalendar ?? deleteLinkedCalendarEvents;
    this.updateReservationCalendar =
      deps.updateReservationCalendar ?? updateLinkedCalendarEvents;
    this.now = deps.now ?? (() => new Date());
  }

  // ── Access (the gate's idiom: super_admin bypasses trip access —
  // but the vault reads below key on the traveler's own id through
  // readProfileFields only, and log against that traveler).
  private async assertTripAccess(userId: number, role: string, tripId: number): Promise<void> {
    if (role === "super_admin") return;
    const [participant] = await db
      .select()
      .from(tripParticipantsTable)
      .where(and(eq(tripParticipantsTable.tripId, tripId), eq(tripParticipantsTable.userId, userId)));
    if (!participant) {
      throw new CallAccessDenied(`You are not a participant of trip ${tripId}.`);
    }
  }

  private async loadBrief(briefId: number): Promise<CallBrief> {
    const [brief] = await db.select().from(callBriefsTable).where(eq(callBriefsTable.id, briefId));
    if (!brief) throw new CallNotFound(`No call brief ${briefId}.`);
    return brief;
  }

  private async loadTask(taskId: number): Promise<CallTask> {
    const [task] = await db.select().from(callTasksTable).where(eq(callTasksTable.id, taskId));
    if (!task) throw new CallNotFound(`No call task ${taskId}.`);
    return task;
  }

  private briefProblems(brief: CallBrief): string[] {
    return validateBriefCompleteness({
      kind: brief.kind,
      calleeName: brief.calleeName,
      calleePhone: brief.calleePhone,
      ask: brief.ask,
      travelerNameOnReservation: brief.travelerNameOnReservation,
      callbackNumber: brief.callbackNumber,
      durationCapSeconds: brief.durationCapSeconds,
      authorityKind: brief.authorityKind,
      authorityLimit:
        brief.authorityLimitAmountMinor != null && brief.authorityLimitCurrency
          ? money(brief.authorityLimitAmountMinor, brief.authorityLimitCurrency)
          : null,
      bookingId: brief.bookingId,
      reservationRefs: brief.reservationRefs,
      serviceDate: brief.serviceDate,
      partySize: brief.partySize,
    });
  }

  // ── BRIEF ─────────────────────────────────────────────────────────────────

  async prepareBrief(input: PrepareBriefInput, actor: Actor): Promise<CallBrief> {
    await this.assertTripAccess(actor.userId, actor.role, input.tripId);
    const travelerUserId = input.travelerUserId ?? actor.userId;
    if (travelerUserId !== actor.userId) {
      // Preparing a brief on another traveler's behalf: that traveler
      // must be on the trip (their vault is read for the name).
      await this.assertTripAccess(travelerUserId, "user", input.tripId);
    }

    let ask = input.ask;
    let category = input.category ?? null;
    let authorityLimit = input.authorityLimit ?? null;
    let coveredUserIds = input.coveredUserIds ?? [travelerUserId];
    let reservationRefs = input.reservationRefs ?? [];

    // Gate-attempt seeding (§5.2): the brief inherits the attempt's
    // reviewed total as its cap and the attempt's coverage — the call
    // may commit only within what the gate already confirmed.
    if (input.bookingAttemptId) {
      const [attempt] = await db
        .select()
        .from(bookingAttemptsTable)
        .where(eq(bookingAttemptsTable.id, input.bookingAttemptId));
      if (!attempt || attempt.tripId !== input.tripId) {
        throw new CallNotFound(`No booking attempt ${input.bookingAttemptId} on trip ${input.tripId}.`);
      }
      if (!authorityLimit) {
        authorityLimit = money(
          attempt.reviewedAmountMinor ?? attempt.presentedAmountMinor,
          attempt.reviewedCurrency ?? attempt.presentedCurrency,
        );
      }
      if (!input.coveredUserIds) {
        const coverage = await db
          .select()
          .from(bookingAttemptTravelersTable)
          .where(eq(bookingAttemptTravelersTable.attemptId, attempt.id));
        const ids = coverage.map((c) => c.userId).filter((id): id is number => id != null);
        if (ids.length > 0) coveredUserIds = ids;
      }
      category = category ?? attempt.category;
    }

    // Accepted-extras seeding (§7): an accepted suggestion is the
    // traveler's stated intent to arrange the item; the brief's ask
    // defaults to the suggestion's own words.
    if (input.extrasSuggestionId) {
      const [suggestion] = await db
        .select()
        .from(extrasSuggestionsTable)
        .where(eq(extrasSuggestionsTable.id, input.extrasSuggestionId));
      if (!suggestion || suggestion.tripId !== input.tripId) {
        throw new CallNotFound(
          `No extras suggestion ${input.extrasSuggestionId} on trip ${input.tripId}.`,
        );
      }
      if (suggestion.state !== "accepted") {
        throw new CallRefused(
          "That extras suggestion hasn't been accepted yet — accept it first, then the call brief can be prepared from it.",
        );
      }
      if (!ask) ask = `${suggestion.title} — ${suggestion.detail}`;
    }

    // Existing-booking seeding (change/cancel): the booking's own
    // confirmation code is the reference the venue will ask for.
    if (input.bookingId) {
      const [booking] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, input.bookingId));
      if (!booking || booking.tripId !== input.tripId) {
        throw new CallNotFound(`No booking ${input.bookingId} on trip ${input.tripId}.`);
      }
      if (reservationRefs.length === 0 && booking.confirmationCode) {
        reservationRefs = [booking.confirmationCode];
      }
    }

    // The traveler's name AS IT APPEARS on the reservation (Story
    // 4.1) — from the vault, access-logged under the call purpose.
    // A profile gap doesn't block preparing the brief; it blocks
    // DIALING (completeness), and the brief view names it.
    let travelerName: string | null = null;
    try {
      const values = await this.readProfile(
        travelerUserId,
        NAME_FIELDS,
        { kind: "agent" },
        "call_execution",
      );
      const parts = [
        values.legal_first_name,
        values.legal_middle_name,
        values.legal_last_name,
      ].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
      travelerName = parts.length > 0 ? parts.join(" ") : null;
    } catch (err) {
      logger.warn(
        { travelerUserId, err },
        "[ConciergeCalls] vault name read failed at brief preparation — brief stored without the name; dialing will refuse until it is present",
      );
    }

    const authorityKind = input.authorityKind ?? (input.kind === "info" ? "info_only" : "spend");
    const [brief] = await db
      .insert(callBriefsTable)
      .values({
        tripId: input.tripId,
        bookingAttemptId: input.bookingAttemptId ?? null,
        bookingId: input.bookingId ?? null,
        extrasSuggestionId: input.extrasSuggestionId ?? null,
        kind: input.kind,
        state: "draft",
        category,
        visibility: input.visibility ?? defaultVisibility(category),
        calleeName: input.calleeName,
        calleePhone: input.calleePhone,
        travelerUserId,
        travelerNameOnReservation: travelerName,
        coveredUserIds,
        ask,
        reservationRefs,
        partySize: input.partySize ?? null,
        serviceDate: input.serviceDate ?? null,
        serviceTimeWindow: input.serviceTimeWindow ?? null,
        fallbacks: input.fallbacks ?? [],
        mayNotAgree: input.mayNotAgree ?? [],
        authorityKind,
        authorityLimitAmountMinor: authorityKind === "spend" ? (authorityLimit?.amountMinor ?? null) : null,
        authorityLimitCurrency: authorityKind === "spend" ? (authorityLimit?.currency ?? null) : null,
        toleranceAmountMinor: input.toleranceAmountMinor ?? 0,
        paymentMayBeRequired: input.paymentMayBeRequired ?? false,
        durationCapSeconds: input.durationCapSeconds ?? DEFAULT_DURATION_CAP_SECONDS,
        callbackNumber: input.callbackNumber ?? this.telephony.fromNumber ?? null,
        version: 1,
        supersedesBriefId: null,
        createdByUserId: actor.userId,
      })
      .returning();
    if (!brief) throw new Error("call brief insert returned no row");
    logger.info(
      { briefId: brief.id, tripId: input.tripId, kind: brief.kind, userId: actor.userId },
      "[ConciergeCalls] brief prepared",
    );
    return brief;
  }

  /**
   * Amend a brief (Story 4.1): the amendment is a NEW version; the
   * old row is superseded and can never be confirmed or called
   * against. Confirmation does NOT carry over — the amended ask is a
   * new authorization and is confirmed fresh.
   */
  async amendBrief(
    briefId: number,
    patch: Partial<PrepareBriefInput>,
    actor: Actor,
  ): Promise<CallBrief> {
    const old = await this.loadBrief(briefId);
    await this.assertTripAccess(actor.userId, actor.role, old.tripId);
    if (old.state === "superseded") {
      throw new CallRefused("That brief version was already superseded — amend the current version.");
    }
    const active = await db
      .select()
      .from(callTasksTable)
      .where(and(eq(callTasksTable.briefId, old.id), eq(callTasksTable.state, "calling")));
    if (active.length > 0) {
      throw new CallRefused("A call against this brief is in progress — it can't be amended mid-call.");
    }

    const [next] = await db
      .insert(callBriefsTable)
      .values({
        tripId: old.tripId,
        bookingAttemptId: patch.bookingAttemptId !== undefined ? patch.bookingAttemptId : old.bookingAttemptId,
        bookingId: patch.bookingId !== undefined ? patch.bookingId : old.bookingId,
        extrasSuggestionId:
          patch.extrasSuggestionId !== undefined ? patch.extrasSuggestionId : old.extrasSuggestionId,
        kind: patch.kind ?? old.kind,
        state: "draft",
        category: patch.category !== undefined ? patch.category : old.category,
        visibility: patch.visibility ?? (old.visibility as "shared" | "private"),
        calleeName: patch.calleeName ?? old.calleeName,
        calleePhone: patch.calleePhone ?? old.calleePhone,
        travelerUserId: patch.travelerUserId ?? old.travelerUserId,
        travelerNameOnReservation: old.travelerNameOnReservation,
        coveredUserIds: patch.coveredUserIds ?? old.coveredUserIds,
        ask: patch.ask ?? old.ask,
        reservationRefs: patch.reservationRefs ?? old.reservationRefs,
        partySize: patch.partySize !== undefined ? patch.partySize : old.partySize,
        serviceDate: patch.serviceDate !== undefined ? patch.serviceDate : old.serviceDate,
        serviceTimeWindow:
          patch.serviceTimeWindow !== undefined ? patch.serviceTimeWindow : old.serviceTimeWindow,
        fallbacks: patch.fallbacks ?? old.fallbacks,
        mayNotAgree: patch.mayNotAgree ?? old.mayNotAgree,
        authorityKind: patch.authorityKind ?? old.authorityKind,
        authorityLimitAmountMinor:
          patch.authorityLimit !== undefined
            ? patch.authorityLimit?.amountMinor ?? null
            : old.authorityLimitAmountMinor,
        authorityLimitCurrency:
          patch.authorityLimit !== undefined
            ? patch.authorityLimit?.currency ?? null
            : old.authorityLimitCurrency,
        toleranceAmountMinor: patch.toleranceAmountMinor ?? old.toleranceAmountMinor,
        paymentMayBeRequired: patch.paymentMayBeRequired ?? old.paymentMayBeRequired,
        durationCapSeconds: patch.durationCapSeconds ?? old.durationCapSeconds,
        callbackNumber: patch.callbackNumber !== undefined ? patch.callbackNumber : old.callbackNumber,
        version: old.version + 1,
        supersedesBriefId: old.id,
        createdByUserId: actor.userId,
      })
      .returning();
    if (!next) throw new Error("call brief amendment insert returned no row");
    await db
      .update(callBriefsTable)
      .set({ state: "superseded", updatedAt: this.now() })
      .where(eq(callBriefsTable.id, old.id));
    logger.info(
      { briefId: next.id, supersedes: old.id, version: next.version },
      "[ConciergeCalls] brief amended — new version",
    );
    return next;
  }

  /** The brief + its call tasks + any completeness problems. */
  async getBriefView(
    briefId: number,
    actor: Actor,
  ): Promise<{ brief: CallBrief; tasks: CallTask[]; problems: string[] }> {
    const brief = await this.loadBrief(briefId);
    await this.assertTripAccess(actor.userId, actor.role, brief.tripId);
    const tasks = await db
      .select()
      .from(callTasksTable)
      .where(eq(callTasksTable.briefId, brief.id));
    return { brief, tasks, problems: this.briefProblems(brief) };
  }

  // ── CONFIRM ───────────────────────────────────────────────────────────────

  async confirmBrief(briefId: number, actor: Actor): Promise<ConfirmBriefResult> {
    const brief = await this.loadBrief(briefId);
    await this.assertTripAccess(actor.userId, actor.role, brief.tripId);
    // Voice proposes, screen confirms (§2.4), applied to call briefs:
    // a brief that authorizes SPEND cannot be confirmed on the voice
    // channel — refused BEFORE anything is recorded, exactly as the
    // gate refuses voice booking confirmations. An information-only
    // brief authorizes nothing, so it may be confirmed on any channel.
    if (actor.channel === "voice" && brief.authorityKind === "spend") {
      logger.info(
        { briefId, userId: actor.userId },
        "[ConciergeCalls] voice-channel spend-brief confirmation refused — screen confirmation required",
      );
      return {
        confirmed: false,
        reason:
          "Voice can't confirm a brief that authorizes spending. Confirmation has to happen on screen, " +
          "with the brief — the ask and the spending cap — in front of you. Tap Confirm there, then tell me to place the call.",
        brief,
      };
    }
    if (brief.state === "superseded") {
      return {
        confirmed: false,
        reason: "That brief was superseded by a newer version — confirm the current version instead.",
        brief,
      };
    }
    if (brief.state === "confirmed" && brief.confirmedByUserId === actor.userId) {
      return { confirmed: true, reason: "Already confirmed.", brief };
    }
    const [updated] = await db
      .update(callBriefsTable)
      .set({
        state: "confirmed",
        confirmedByUserId: actor.userId,
        confirmedAt: this.now(),
        presentedAt: brief.presentedAt ?? this.now(),
        updatedAt: this.now(),
      })
      .where(eq(callBriefsTable.id, brief.id))
      .returning();
    logger.info({ briefId, userId: actor.userId }, "[ConciergeCalls] brief confirmed");
    return {
      confirmed: true,
      reason:
        brief.authorityKind === "info_only"
          ? "Confirmed — an information-only brief: the call may gather information and commit nothing."
          : "Confirmed — the call may be placed against this brief, within its cap.",
      brief: updated ?? { ...brief, state: "confirmed" as const },
    };
  }

  // ── DIAL ──────────────────────────────────────────────────────────────────

  async placeCall(briefId: number, actor: Actor): Promise<PlaceCallResult> {
    const brief = await this.loadBrief(briefId);
    await this.assertTripAccess(actor.userId, actor.role, brief.tripId);

    // The place-call path exists ONLY behind a confirmed brief.
    if (brief.state !== "confirmed") {
      return {
        placed: false,
        reason:
          brief.state === "superseded"
            ? "That brief was superseded by a newer version — place the call against the current, confirmed version."
            : "The brief hasn't been confirmed yet — no call is placed without the traveler's confirmation of the brief. Nothing was called.",
      };
    }
    // No brief, no call: completeness is enforced at the dial, whatever
    // state the brief was prepared in.
    const problems = this.briefProblems(brief);
    if (problems.length > 0) {
      return {
        placed: false,
        reason: `The brief isn't complete, so no call was placed: ${problems.join("; ")}.`,
      };
    }
    const provider = this.telephony.provider;
    if (!provider) {
      return {
        placed: false,
        reason:
          "Telephony isn't configured on this server yet (no Twilio keys), so no call can be placed. " +
          "The brief is ready and confirmed — nothing was called.",
      };
    }
    if (!this.telephony.callUrl) {
      return {
        placed: false,
        reason:
          "Telephony is configured but the call URL (the ConversationRelay endpoint Twilio fetches) isn't set, so no call was placed.",
      };
    }
    if (brief.authorityKind === "info_only" && brief.paymentMayBeRequired) {
      return {
        placed: false,
        reason:
          "The brief is information-only but says payment may be required — an information call never takes payment. Fix the brief before dialing.",
      };
    }

    // Retry pattern (Story 4.5): attempts are counted per brief; past
    // the stated maximum the task escalates instead of dialing again.
    const priorTasks = await db
      .select()
      .from(callTasksTable)
      .where(eq(callTasksTable.briefId, brief.id));
    const attemptNumber = priorTasks.length + 1;
    if (attemptNumber > CALL_RETRY_POLICY.maxAttempts) {
      return {
        placed: false,
        reason:
          `This brief has had ${CALL_RETRY_POLICY.maxAttempts} call attempts — the stated pattern stops there and ` +
          "escalates to you rather than retrying forever. Review the outcomes and prepare a fresh brief if you'd like to try again.",
      };
    }

    // Payment: the single-use virtual card is issued BEFORE dialing —
    // the live session needs it in hand — capped at the brief's
    // approved total + its stated tolerance (international §3.4). Only
    // the reference is ever stored.
    let card: IssuedCard | undefined;
    if (brief.paymentMayBeRequired) {
      if (!this.cardProvider) {
        return {
          placed: false,
          reason:
            "This brief may need a card read to the venue, but no virtual-card issuer is configured — " +
            "and the agent never reads out a traveler's real card. No call was placed.",
        };
      }
      const cap = money(
        brief.authorityLimitAmountMinor ?? 0,
        brief.authorityLimitCurrency ?? "USD",
      );
      try {
        card = await this.cardProvider.issueSingleUseCard({
          limit: money(cap.amountMinor + brief.toleranceAmountMinor, cap.currency),
          merchantCategory: brief.category,
          expiresInMinutes: 120,
          reference: `call-brief-${brief.id}-attempt-${attemptNumber}`,
        });
      } catch (err) {
        return {
          placed: false,
          reason: `The virtual card couldn't be issued (${err instanceof Error ? err.message : String(err)}), so no call was placed.`,
        };
      }
    }

    const [task] = await db
      .insert(callTasksTable)
      .values({
        briefId: brief.id,
        tripId: brief.tripId,
        state: "queued",
        attemptNumber,
        paymentInstrumentRef: card?.instrumentRef ?? null,
      })
      .returning();
    if (!task) throw new Error("call task insert returned no row");

    let created: { providerCallId: string; status: string };
    try {
      created = await provider.createCall({
        to: brief.calleePhone,
        from: this.telephony.fromNumber ?? "",
        callUrl: this.telephony.callUrl,
        statusCallbackUrl: this.telephony.statusCallbackUrl ?? undefined,
        timeLimitSeconds: brief.durationCapSeconds,
        record: true,
        machineDetection: true,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const [failed] = await db
        .update(callTasksTable)
        .set({
          state: "failed",
          failureReason: `The call couldn't be placed: ${detail}`,
          outcomeText: `The call to ${brief.calleeName} couldn't be placed (${detail}). Nothing was booked or changed.`,
          endedAt: this.now(),
          updatedAt: this.now(),
        })
        .where(eq(callTasksTable.id, task.id))
        .returning();
      logger.warn({ briefId, taskId: task.id, err }, "[ConciergeCalls] provider create failed");
      return {
        placed: false,
        reason: `The call couldn't be placed: ${detail}`,
        task: failed ?? task,
      };
    }

    const [calling] = await db
      .update(callTasksTable)
      .set({
        state: "calling",
        provider: provider.id,
        providerCallId: created.providerCallId,
        providerStatus: created.status,
        startedAt: this.now(),
        updatedAt: this.now(),
      })
      .where(eq(callTasksTable.id, task.id))
      .returning();
    logger.info(
      { briefId, taskId: task.id, attemptNumber, provider: provider.id },
      "[ConciergeCalls] call placed",
    );
    return { placed: true, task: calling ?? task, cardDetails: card };
  }

  // ── Provider status callbacks ─────────────────────────────────────────────

  /**
   * Twilio status callbacks land here (via the status-callback route).
   * A callback updates the task's provider state and — for the
   * terminal no-contact statuses — finalizes the task through the
   * same outcome path the call driver uses, so a no-answer is
   * recorded and retried/escalated by the stated pattern, never lost.
   */
  async handleStatusCallback(
    providerCallId: string,
    status: string,
    opts: { durationSeconds?: number; recordingRef?: string } = {},
  ): Promise<CallTask | null> {
    const [task] = await db
      .select()
      .from(callTasksTable)
      .where(eq(callTasksTable.providerCallId, providerCallId));
    if (!task) return null;
    // Terminal tasks are settled: a late callback never re-opens one
    // (an outcome, once evaluated, is never re-evaluated).
    if (task.state === "completed" || task.state === "failed" || task.state === "escalated") {
      return task;
    }

    const phase = mapProviderStatus(status);
    const patch: Partial<CallTask> = {
      providerStatus: status,
      updatedAt: this.now(),
    };
    if (opts.recordingRef) patch.recordingRef = opts.recordingRef;
    if (opts.durationSeconds != null) {
      patch.durationSeconds = opts.durationSeconds;
      patch.telephonyCostMinor = estimateCallCost(opts.durationSeconds).amountMinor;
      patch.telephonyCostCurrency = "USD";
    }
    if (phase === "ended") patch.endedAt = this.now();
    const [updated] = await db
      .update(callTasksTable)
      .set(patch)
      .where(eq(callTasksTable.id, task.id))
      .returning();
    const current = updated ?? { ...task, ...patch };

    if (phase === "no_answer" || phase === "busy") {
      return this.finalizeTask(current, {
        disposition: "no_answer",
        notes: `The provider reported ${status}.`,
      });
    }
    if (phase === "failed") {
      return this.finalizeTask(current, {
        disposition: "ambiguous",
        notes: `The provider reported the call ${status} before an outcome could be established.`,
      });
    }
    return current;
  }

  // ── OUTCOME ───────────────────────────────────────────────────────────────

  /**
   * The call driver's structured outcome report (Story 4.5) — the
   * relay/driver calls this at session end with what the venue
   * actually said plus the transcript. The outcome is EVALUATED
   * against the brief's authority before anything is written to the
   * ledger (see finalizeTask). Idempotent: a duplicate report against
   * a terminal task changes nothing.
   */
  async recordOutcome(
    taskId: number,
    input: {
      outcome: CallOutcome;
      transcript?: CallTranscriptTurn[];
      durationSeconds?: number;
    },
  ): Promise<RecordOutcomeResult> {
    const task = await this.loadTask(taskId);
    if (task.state === "queued") {
      throw new CallRefused(
        "That call hasn't been placed yet — there is nothing to record an outcome against.",
      );
    }
    if (task.state === "completed" || task.state === "failed" || task.state === "escalated") {
      const brief = await this.loadBrief(task.briefId);
      return {
        task,
        evaluation: evaluateOutcome(
          {
            kind: brief.kind,
            authorityKind: brief.authorityKind,
            authorityLimit:
              brief.authorityLimitAmountMinor != null && brief.authorityLimitCurrency
                ? money(brief.authorityLimitAmountMinor, brief.authorityLimitCurrency)
                : null,
          },
          task.outcome ?? input.outcome,
        ),
        alreadyRecorded: true,
      };
    }
    const updated = await this.finalizeTask(task, input.outcome, input);
    const brief = await this.loadBrief(task.briefId);
    const evaluation = evaluateOutcome(
      {
        kind: brief.kind,
        authorityKind: brief.authorityKind,
        authorityLimit:
          brief.authorityLimitAmountMinor != null && brief.authorityLimitCurrency
            ? money(brief.authorityLimitAmountMinor, brief.authorityLimitCurrency)
            : null,
      },
      input.outcome,
    );
    let booking: Booking | undefined;
    if (updated.bookingId) {
      const [row] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, updated.bookingId));
      booking = row;
    }
    return { task: updated, evaluation, booking };
  }

  /** Status/outcome view for one task (the caller's trip access applies). */
  async getTaskView(
    taskId: number,
    actor: Actor,
  ): Promise<{ task: CallTask; brief: CallBrief }> {
    const task = await this.loadTask(taskId);
    await this.assertTripAccess(actor.userId, actor.role, task.tripId);
    const brief = await this.loadBrief(task.briefId);
    return { task, brief };
  }

  // ── Outcome finalization (the ledger's door) ──────────────────────────────

  private async finalizeTask(
    task: CallTask,
    outcome: CallOutcome,
    input: { transcript?: CallTranscriptTurn[]; durationSeconds?: number } = {},
  ): Promise<CallTask> {
    const brief = await this.loadBrief(task.briefId);
    const evaluation = evaluateOutcome(
      {
        kind: brief.kind,
        authorityKind: brief.authorityKind,
        authorityLimit:
          brief.authorityLimitAmountMinor != null && brief.authorityLimitCurrency
            ? money(brief.authorityLimitAmountMinor, brief.authorityLimitCurrency)
            : null,
      },
      outcome,
    );
    const durationSeconds = input.durationSeconds ?? task.durationSeconds ?? null;
    const cost = estimateCallCost(durationSeconds ?? 0);

    let bookingId: number | null = null;
    let state: CallTask["state"] = "completed";
    let failureReason: string | null = null;
    let outcomeText: string;

    switch (evaluation.action) {
      case "book": {
        const booking = await this.writePhoneBooking(brief, task, outcome, evaluation.agreedTotal, {
          durationSeconds,
          costMinor: cost.amountMinor,
        });
        bookingId = booking.id;
        outcomeText = this.bookedText(brief, outcome, booking);
        break;
      }
      case "apply_change": {
        if (!brief.bookingId) {
          state = "failed";
          failureReason = "The call reported a change, but the brief doesn't reference the booking it changed.";
          outcomeText = failureReason;
          break;
        }
        const booking = await this.applyPhoneChange(brief, outcome, evaluation.agreedTotal);
        bookingId = booking?.id ?? null;
        outcomeText = booking
          ? `Changed by phone with ${brief.calleeName}: booking #${booking.id} is updated` +
            (outcome.confirmationCode
              ? ` — new confirmation ${outcome.confirmationCode}.`
              : " — the venue gave no new confirmation code.") +
            (outcome.agreedTerms ? ` Terms as stated: ${outcome.agreedTerms}` : "")
          : "The change couldn't be recorded — the original booking wasn't found.";
        if (!booking) {
          state = "failed";
          failureReason = outcomeText;
        }
        break;
      }
      case "apply_cancel": {
        if (!brief.bookingId) {
          state = "failed";
          failureReason = "The call reported a cancellation, but the brief doesn't reference the booking it cancelled.";
          outcomeText = failureReason;
          break;
        }
        const booking = await this.applyPhoneCancel(brief, outcome);
        bookingId = booking?.id ?? null;
        outcomeText = booking
          ? `Cancelled by phone with ${brief.calleeName}: booking #${booking.id} is cancelled.` +
            (outcome.refundAmountMinor != null && outcome.refundCurrency
              ? ` Refund of ${formatMoney(money(outcome.refundAmountMinor, outcome.refundCurrency), "en-US")} stated by the venue${outcome.refundTimeline ? ` — ${outcome.refundTimeline}` : ""}.`
              : " No refund was stated on the call.")
          : "The cancellation couldn't be recorded — the original booking wasn't found.";
        if (!booking) {
          state = "failed";
          failureReason = outcomeText;
        }
        break;
      }
      case "record_request": {
        const label =
          outcome.requestOutcome === "granted"
            ? "granted"
            : outcome.requestOutcome === "denied"
              ? "denied"
              : "noted — NOT guaranteed";
        outcomeText =
          `Special request to ${brief.calleeName}: ${label}.` +
          (outcome.requestOutcome === "noted_not_guaranteed"
            ? " The venue noted the request but did not guarantee it, and the itinerary shows it as noted, never as guaranteed."
            : "") +
          (outcome.personSpokenTo ? ` Spoken to: ${outcome.personSpokenTo}.` : "");
        break;
      }
      case "record_info": {
        outcomeText =
          `Information call to ${brief.calleeName}: ${outcome.infoGathered ?? "the call completed."}` +
          " Nothing was booked or changed — the brief authorized information only.";
        break;
      }
      case "rejected_claim": {
        // The call happened; its commitment claim is refused at the
        // ledger's door. The task completes with the rejection as its
        // outcome — visible, never silent.
        outcomeText = evaluation.reason;
        break;
      }
      case "over_cap": {
        state = "escalated";
        failureReason = evaluation.reason;
        outcomeText = evaluation.reason;
        break;
      }
      case "failed": {
        const decision = retryDecision(task.attemptNumber, evaluation.retryable);
        if (decision.action === "escalate") {
          state = "escalated";
          failureReason = evaluation.reason;
          outcomeText =
            `${evaluation.reason} That was attempt ${task.attemptNumber} of ${CALL_RETRY_POLICY.maxAttempts} — ` +
            "the stated retry pattern stops here and escalates to you with the outcome rather than retrying forever.";
        } else {
          state = "failed";
          failureReason = evaluation.reason;
          outcomeText =
            `${evaluation.reason} Attempt ${task.attemptNumber} of ${CALL_RETRY_POLICY.maxAttempts}; ` +
            `the next attempt can be placed after the stated spacing (${decision.spacingMinutes} minutes).`;
        }
        break;
      }
    }

    const [updated] = await db
      .update(callTasksTable)
      .set({
        state,
        outcome,
        outcomeText,
        bookingId,
        failureReason,
        transcript: input.transcript ?? task.transcript,
        durationSeconds,
        telephonyCostMinor: cost.amountMinor,
        telephonyCostCurrency: cost.currency,
        endedAt: task.endedAt ?? this.now(),
        updatedAt: this.now(),
      })
      .where(eq(callTasksTable.id, task.id))
      .returning();
    logger.info(
      {
        taskId: task.id,
        briefId: brief.id,
        action: evaluation.action,
        state,
        bookingId,
      },
      "[ConciergeCalls] call outcome recorded",
    );
    return updated ?? { ...task, state, outcome, outcomeText, bookingId, failureReason };
  }

  private bookedText(brief: CallBrief, outcome: CallOutcome, booking: Booking): string {
    const lines = [
      `Booked by phone with ${brief.calleeName} — ledger booking #${booking.id}.`,
      outcome.confirmationCode
        ? `Confirmation: ${outcome.confirmationCode} (as given on the call).`
        : "The venue gave no confirmation code on the call — the booking record says so rather than inventing one.",
    ];
    if (outcome.personSpokenTo) lines.push(`Spoken to: ${outcome.personSpokenTo}.`);
    if (booking.chargeAmountMinor > 0) {
      lines.push(
        `Total agreed: ${formatMoney(money(booking.chargeAmountMinor, booking.chargeCurrency), "en-US")}.`,
      );
    }
    if (outcome.agreedTerms) lines.push(`Terms as stated: ${outcome.agreedTerms}`);
    if (!outcome.serviceDate && !brief.serviceDate) {
      lines.push(
        "It isn't on the itinerary yet — the call didn't settle a service date, so a date is still owed before it can be projected.",
      );
    }
    if (brief.visibility === "private") {
      lines.push("Kept private on the shared itinerary, per its category.");
    }
    return lines.join(" ");
  }

  /**
   * Write a phone booking to the ledger (source 'phone', §5.4) and
   * project it into the itinerary — one transaction, exactly like an
   * API booking: coverage, splits, an explicit no-rail commission
   * record, and the reservation projection. Calendar write-back rides
   * the existing reservation hook, best-effort.
   */
  private async writePhoneBooking(
    brief: CallBrief,
    task: CallTask,
    outcome: CallOutcome,
    agreedTotal: Money | null,
    callFacts: { durationSeconds: number | null; costMinor: number },
  ): Promise<Booking> {
    const charge: Money =
      agreedTotal ??
      money(0, brief.authorityLimitCurrency ?? "USD");
    const serviceDate = outcome.serviceDate ?? brief.serviceDate;
    const serviceTime = outcome.serviceTime ?? brief.serviceTimeWindow;
    const covered = brief.coveredUserIds.length > 0 ? brief.coveredUserIds : [brief.travelerUserId];

    const finalized = await db.transaction(async (tx) => {
      const [booking] = await tx
        .insert(bookingsTable)
        .values({
          attemptId: brief.bookingAttemptId,
          tripId: brief.tripId,
          kind: reservationTypeForBrief(brief),
          supplier: brief.calleeName,
          confirmationCode: outcome.confirmationCode ?? null,
          status: "confirmed",
          source: "phone",
          chargeAmountMinor: charge.amountMinor,
          chargeCurrency: charge.currency,
          amountActuallyChargedMinor: null,
          merchantOfRecord: brief.calleeName,
          changeTerms: outcome.agreedTerms ?? null,
          cancelTerms: outcome.agreedTerms ?? null,
          whyThisOption: "traveler_chose",
          whyThisOptionText: brief.ask,
          visibility: brief.visibility as Booking["visibility"],
          costAttribution: {
            callTaskId: task.id,
            callMinutes: billedMinutes(callFacts.durationSeconds ?? 0),
            telephonyCostMinor: callFacts.costMinor,
            resolved: true,
          },
        })
        .returning();
      if (!booking) throw new Error("phone booking insert returned no row");

      for (const [i, userId] of covered.entries()) {
        await tx.insert(bookingTravelersTable).values({
          bookingId: booking.id,
          userId,
          rosterEntryId: null,
          isPayer: i === 0,
        });
      }
      if (charge.amountMinor > 0) {
        const shares = computeBookingSplits(charge, covered.length);
        for (const [i, userId] of covered.entries()) {
          await tx.insert(bookingSplitsTable).values({
            bookingId: booking.id,
            userId,
            rosterEntryId: null,
            shareAmountMinor: shares[i]?.amountMinor ?? 0,
            shareCurrency: charge.currency,
          });
        }
      }
      // A phone booking has no commission rail — recorded EXPLICITLY
      // as no_rail, never a null (Story 7.2/7.4).
      await tx.insert(commissionRecordsTable).values({
        bookingId: booking.id,
        partnerProgram: null,
        basis: null,
        rateBps: null,
        expectedAmountMinor: null,
        expectedCurrency: null,
        status: "no_rail",
        noRailReason: "phone_booking_no_commission_rail",
      });

      // Itinerary projection — a reservation row, the same table the
      // timeline/snapshot/calendar already read. Without a service
      // date there is nothing honest to project; the booking stands
      // in the ledger and the outcome text says a date is owed.
      let reservation: Reservation | null = null;
      if (serviceDate) {
        const notes = [
          outcome.agreedTerms ?? null,
          outcome.personSpokenTo ? `Booked by phone with ${outcome.personSpokenTo}.` : null,
          outcome.confirmationCode
            ? null
            : "No confirmation code was given on the call.",
        ]
          .filter((n): n is string => n !== null)
          .join(" ");
        const [row] = await tx
          .insert(reservationsTable)
          .values({
            tripId: brief.tripId,
            type: reservationTypeForBrief(brief),
            title: brief.calleeName,
            venue: brief.calleeName,
            date: serviceDate,
            time: serviceTime,
            confirmationCode: outcome.confirmationCode ?? null,
            numberOfPeople: brief.partySize,
            phone: brief.calleePhone,
            notes: notes || null,
          })
          .returning();
        reservation = row ?? null;
        if (reservation) {
          await tx
            .update(bookingsTable)
            .set({
              reservationId: reservation.id,
              projection: { reservationIds: [reservation.id] },
              updatedAt: this.now(),
            })
            .where(eq(bookingsTable.id, booking.id));
          booking.reservationId = reservation.id;
        }
      }
      return { booking, reservation };
    });

    // Calendar write-back through the existing reservation hook —
    // best-effort, exactly as everywhere else: a Google outage never
    // un-books a booking.
    if (finalized.reservation) {
      try {
        await this.syncReservation(brief.createdByUserId, finalized.reservation);
      } catch (err) {
        logger.error(
          { bookingId: finalized.booking.id, err },
          "[ConciergeCalls] calendar write-back failed (best-effort)",
        );
      }
    }
    return finalized.booking;
  }

  /** Record a phone change against an existing ledger booking. */
  private async applyPhoneChange(
    brief: CallBrief,
    outcome: CallOutcome,
    agreedTotal: Money | null,
  ): Promise<Booking | null> {
    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, brief.bookingId!));
    if (!booking) return null;
    const changes = [
      ...(((booking.costAttribution as Record<string, unknown>)?.phoneChanges as unknown[]) ?? []),
      {
        at: this.now().toISOString(),
        additionalChargeMinor: agreedTotal?.amountMinor ?? null,
        additionalChargeCurrency: agreedTotal?.currency ?? null,
        terms: outcome.agreedTerms ?? null,
        confirmationCode: outcome.confirmationCode ?? null,
      },
    ];
    const [updated] = await db
      .update(bookingsTable)
      .set({
        status: "changed",
        confirmationCode: outcome.confirmationCode ?? booking.confirmationCode,
        costAttribution: { ...booking.costAttribution, phoneChanges: changes },
        updatedAt: this.now(),
      })
      .where(eq(bookingsTable.id, booking.id))
      .returning();

    // The projected reservation follows the new state (date/time as
    // the venue stated them), and its calendar event updates through
    // the existing hook — best-effort.
    if (booking.reservationId) {
      const [reservation] = await db
        .select()
        .from(reservationsTable)
        .where(eq(reservationsTable.id, booking.reservationId));
      if (reservation) {
        const [moved] = await db
          .update(reservationsTable)
          .set({
            date: outcome.serviceDate ?? reservation.date,
            time: outcome.serviceTime ?? reservation.time,
            confirmationCode: outcome.confirmationCode ?? reservation.confirmationCode,
          })
          .where(eq(reservationsTable.id, reservation.id))
          .returning();
        if (moved) {
          try {
            await this.updateReservationCalendar(moved);
          } catch (err) {
            logger.error({ bookingId: booking.id, err }, "[ConciergeCalls] calendar update failed (best-effort)");
          }
        }
      }
    }
    return updated ?? booking;
  }

  /** Record a phone cancellation against an existing ledger booking. */
  private async applyPhoneCancel(brief: CallBrief, outcome: CallOutcome): Promise<Booking | null> {
    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, brief.bookingId!));
    if (!booking) return null;
    const [updated] = await db
      .update(bookingsTable)
      .set({
        status: "cancelled",
        costAttribution: {
          ...booking.costAttribution,
          cancellation: {
            channel: "phone",
            at: this.now().toISOString(),
            refundAmountMinor: outcome.refundAmountMinor ?? null,
            refundCurrency: outcome.refundCurrency ?? null,
            refundTimeline: outcome.refundTimeline ?? null,
            personSpokenTo: outcome.personSpokenTo ?? null,
          },
        },
        updatedAt: this.now(),
      })
      .where(eq(bookingsTable.id, booking.id))
      .returning();

    // The projected reservation's calendar event is deleted through
    // the existing hook — a cancelled booking never leaves a ghost
    // event. Best-effort, as everywhere.
    if (booking.reservationId) {
      try {
        await this.deleteReservationCalendar(booking.reservationId);
      } catch (err) {
        logger.error({ bookingId: booking.id, err }, "[ConciergeCalls] calendar delete failed (best-effort)");
      }
    }
    return updated ?? booking;
  }
}

// ─── Default singleton (the gate's pattern) ──────────────────────────────────

let defaultService: ConciergeCallService | null = null;
let testService: ConciergeCallService | null | undefined;

export function getDefaultConciergeCallService(): ConciergeCallService {
  if (testService !== undefined) {
    if (!testService) throw new Error("Concierge call service disabled in tests");
    return testService;
  }
  if (!defaultService) defaultService = new ConciergeCallService();
  return defaultService;
}

export function setDefaultConciergeCallServiceForTests(
  service: ConciergeCallService | null,
): void {
  testService = service === null ? undefined : service;
}
