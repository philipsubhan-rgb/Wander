/**
 * Booking Gate Service — the confirm-then-book execution layer
 * (architecture-north-star §5.2–§5.6, Stories 3.1–3.3, 7.1/7.2/7.4).
 *
 * THE discipline of this module, in one paragraph: an option the
 * traveler saw becomes an attempt; selecting it re-verifies the price
 * LIVE; the traveler confirms the reviewed total explicitly (a logged
 * act bound to the attempt, checked against the ConfirmationPolicy);
 * execution re-verifies AGAIN, then creates the provider order exactly
 * once — never retried, never substituted. Passenger details come from
 * the profile vault via readProfileFields (purpose booking_execution,
 * access-logged) — never from chat text or tool arguments. On success
 * the Booking Ledger row is canonical; legacy itinerary rows are its
 * projection.
 *
 * Failure honesty: a failed execution leaves the attempt FAILED with a
 * plain-language reason and a ledger row marked failed — written and
 * marked, never silently partial, and never a phantom itinerary row.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  accommodationsTable,
  bookingAttemptsTable,
  bookingAttemptTravelersTable,
  bookingOperationsTable,
  bookingsTable,
  bookingTravelersTable,
  bookingSplitsTable,
  commissionRecordsTable,
  flightsTable,
  tripParticipantsTable,
  usersTable,
  type Booking,
  type BookingAttempt,
  type BookingAttemptTraveler,
  type BookingChangeContext,
} from "@workspace/db";
import { formatMoney, fromMajorDecimal, money, subtract, toLegacyPrice, type Money } from "@workspace/money";
import {
  assertTransition,
  computeBookingSplits,
  ConservativeSelfOnlyPolicy,
  defaultVisibility,
  deriveWhyThisOption,
  describePriceDelta,
  describeStayQuoteDelta,
  duffelRailFees,
  flightTerms,
  GateTransitionError,
  rankingInputsHash,
  type ConfirmationPolicy,
  type CoverageEntry,
} from "./bookingGateLogic";
import {
  DuffelError,
  duffelOrdersClientFromEnv,
  mapChangeOfferToOption,
  mapDuffelOffer,
  mapOrderToFlightRows,
  type CreateOrderResult,
  type DuffelOffer,
  type DuffelOrder,
  type DuffelOrderChange,
  type DuffelOrderChangeRequest,
  type DuffelOrdersClient,
  type DuffelPassengerInput,
} from "./duffel";
import {
  duffelStaysClientFromEnv,
  stayCancellationTermsFromTimeline,
  type CreateStayBookingResult,
  type DuffelStayQuote,
  type DuffelStaysClient,
} from "./duffelStays";
import type { StayOption, StayRateBreakdown, WanderOption } from "./options";
import { checkExecutionChannel, type RuleInput } from "./rulesEngine";
import { listRules, ruleRowToInput } from "./travelerContext";
import { readProfileFields, type ProfileFieldName } from "./travelerProfile";
import { deregisterWatchForFlight, registerWatchForFlight } from "./watching";
import { logger } from "./logger";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class BookingAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingAccessDenied";
  }
}

export class BookingNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookingNotFound";
  }
}

/** An operational refusal (policy, channel, configuration) — the
 * attempt is left in its current state and the reason is stated. */
export class BookingRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "BookingRefused";
  }
}

// ─── Re-verification (the quote step) ────────────────────────────────────────

export interface RequoteInfo {
  outcome: "same" | "changed" | "unavailable" | "unverifiable";
  /** The fresh normalized option (same/changed). */
  option?: WanderOption;
  deltaText?: string;
  reason?: string;
  /** Passenger ids from the raw provider offer — execution maps
   * covered travelers onto these, in order. */
  offerPassengerIds?: string[];
  /** Refreshed change context (change attempts only): the provider
   * may restate the resulting total when the offer is re-read. */
  changeContext?: BookingChangeContext;
}

export type RequoteProvider = (option: WanderOption) => Promise<RequoteInfo>;

/** Change re-verification: re-read the change request's offers. */
export type ChangeRequoteProvider = (
  option: WanderOption,
  change: BookingChangeContext,
) => Promise<RequoteInfo>;

// ─── Deps (injectable; tests drive everything through these) ─────────────────

export interface BookingGateDeps {
  /** undefined = from env; null = no rail configured. */
  ordersClient?: DuffelOrdersClient | null;
  /** undefined = from env; null = no stays rail configured. */
  staysClient?: DuffelStaysClient | null;
  requote?: RequoteProvider;
  staysRequote?: RequoteProvider;
  changeRequote?: ChangeRequoteProvider;
  readProfile?: typeof readProfileFields;
  registerWatch?: (flightId: number) => Promise<unknown>;
  deregisterWatch?: (flightId: number) => Promise<unknown>;
  loadRules?: (userId: number) => Promise<RuleInput[]>;
  policy?: ConfirmationPolicy;
  now?: () => Date;
}

export interface CoverageInput {
  userId?: number | null;
  rosterEntryId?: number | null;
  isPayer?: boolean;
}

export interface CreateAttemptInput {
  userId: number;
  role: string;
  tripId: number;
  option: WanderOption;
  coveredTravelers: CoverageInput[];
  category?: string | null;
  visibility?: "shared" | "private";
  whyHint?: string | null;
  fitReasons?: readonly string[];
  setSize?: number;
  /**
   * Change attempts only (E-3.4): the option is a provider change
   * offer against an existing booking. Carried on the snapshot;
   * execution runs the provider's change flow instead of a create.
   */
  change?: BookingChangeContext;
}

export interface BeginReviewResult {
  attempt: BookingAttempt;
  outcome: "same" | "changed" | "unavailable" | "unverifiable" | "already_in_review";
  deltaText?: string;
  reason?: string;
}

export interface ConfirmResult {
  confirmed: boolean;
  reason: string;
  attempt: BookingAttempt;
  coverage: BookingAttemptTraveler[];
}

export interface ExecuteResult {
  executed: boolean;
  reason?: string;
  deltaText?: string;
  attempt: BookingAttempt;
  booking?: Booking;
  /** True when the provider accepted (202) but hasn't confirmed yet. */
  pendingConfirmation?: boolean;
  alreadyBooked?: boolean;
}

const PASSENGER_FIELDS: readonly ProfileFieldName[] = [
  "legal_first_name",
  "legal_middle_name",
  "legal_last_name",
  "date_of_birth",
  "phone",
];

/** A stay guest as built from the vault (never from chat/tool args). */
interface StayGuest {
  userId: number;
  givenName: string;
  familyName: string;
  bornOn: string;
  phone: string | null;
}

// ─── The service ─────────────────────────────────────────────────────────────

export class BookingGate {
  private readonly ordersClient: DuffelOrdersClient | null;
  private readonly staysClient: DuffelStaysClient | null;
  private readonly requote: RequoteProvider;
  private readonly staysRequote: RequoteProvider;
  private readonly changeRequote: ChangeRequoteProvider;
  private readonly readProfile: typeof readProfileFields;
  private readonly registerWatch: (flightId: number) => Promise<unknown>;
  private readonly deregisterWatch: (flightId: number) => Promise<unknown>;
  private readonly loadRules: (userId: number) => Promise<RuleInput[]>;
  private readonly policy: ConfirmationPolicy;
  private readonly now: () => Date;

  constructor(deps: BookingGateDeps = {}) {
    this.ordersClient = deps.ordersClient !== undefined ? deps.ordersClient : duffelOrdersClientFromEnv();
    this.staysClient = deps.staysClient !== undefined ? deps.staysClient : duffelStaysClientFromEnv();
    this.requote = deps.requote ?? makeDuffelRequote(this.ordersClient);
    this.staysRequote = deps.staysRequote ?? ((option) => this.defaultStaysRequote(option));
    this.changeRequote = deps.changeRequote ?? makeDuffelChangeRequote(this.ordersClient);
    this.readProfile = deps.readProfile ?? readProfileFields;
    this.registerWatch = deps.registerWatch ?? (async (flightId) => registerWatchForFlight(flightId));
    this.deregisterWatch =
      deps.deregisterWatch ?? (async (flightId) => deregisterWatchForFlight(flightId));
    this.loadRules =
      deps.loadRules ?? (async (userId) => (await listRules(userId)).map(ruleRowToInput));
    this.policy = deps.policy ?? new ConservativeSelfOnlyPolicy();
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Attempt-aware re-verification dispatch — ONE quote step per kind,
   * never a parallel path (§5.2): a change attempt re-reads its change
   * offers; a stay attempt creates the Duffel Stays quote (the
   * estimate becomes firm); a flight attempt re-fetches the offer.
   */
  private async requoteForAttempt(attempt: BookingAttempt, option: WanderOption): Promise<RequoteInfo> {
    const change = attempt.optionSnapshot.change;
    if (change) return this.changeRequote(option, change);
    if (option.kind === "stay") return this.staysRequote(option);
    return this.requote(option);
  }

  /**
   * The default stays re-verification: POST a quote for the option's
   * rate. The quote total is FIRM (priceNature flips to "firm" and the
   * quote id lands on the fresh option's summary, where execution
   * picks it up). A quote equal to the estimate is "same" — the stay
   * books after ONE confirmation; any difference is "changed" with
   * honest estimate→quote copy (the normal case for stays, E-3.2).
   */
  private async defaultStaysRequote(option: WanderOption): Promise<RequoteInfo> {
    if (option.kind !== "stay" || option.adapter !== "duffel") {
      return {
        outcome: "unverifiable",
        reason: "Live re-verification isn't wired for this kind of option yet.",
      };
    }
    if (!this.staysClient) {
      return {
        outcome: "unverifiable",
        reason: "Duffel isn't configured (no DUFFEL_API_TOKEN), so the stay price can't be re-verified live.",
      };
    }
    if (!option.summary.rateId) {
      return {
        outcome: "unverifiable",
        reason:
          "This stay option didn't carry a rate reference, so it can't be quoted or booked. Nothing was booked.",
      };
    }
    let quote: DuffelStayQuote;
    try {
      quote = await this.staysClient.createQuote(option.summary.rateId);
    } catch (err) {
      return {
        outcome: "unverifiable",
        reason: `The live quote check failed (${err instanceof Error ? err.message : String(err)}). Nothing was booked.`,
      };
    }
    return stayQuoteToRequoteInfo(quote, option, this.now().toISOString());
  }

  // ── Access (the extras/assertTripAccess idiom: super_admin bypasses
  // trip access — but never the vault; the vault reads below key on the
  // covered traveler's own id through readProfileFields only).
  private async assertTripAccess(userId: number, role: string, tripId: number): Promise<void> {
    if (role === "super_admin") return;
    const [participant] = await db
      .select()
      .from(tripParticipantsTable)
      .where(and(eq(tripParticipantsTable.tripId, tripId), eq(tripParticipantsTable.userId, userId)));
    if (!participant) {
      throw new BookingAccessDenied(`You are not a participant of trip ${tripId}.`);
    }
  }

  private async loadAttempt(attemptId: number): Promise<BookingAttempt> {
    const [attempt] = await db
      .select()
      .from(bookingAttemptsTable)
      .where(eq(bookingAttemptsTable.id, attemptId));
    if (!attempt) throw new BookingNotFound(`No booking attempt ${attemptId}.`);
    return attempt;
  }

  private async loadCoverage(attemptId: number): Promise<BookingAttemptTraveler[]> {
    return db
      .select()
      .from(bookingAttemptTravelersTable)
      .where(eq(bookingAttemptTravelersTable.attemptId, attemptId));
  }

  /** The ONLY state-change path: typed transition + patch, or it throws. */
  private async transition(
    attempt: BookingAttempt,
    to: BookingAttempt["state"],
    patch: Partial<BookingAttempt> = {},
    exec: Pick<typeof db, "update"> = db,
  ): Promise<BookingAttempt> {
    assertTransition(attempt.state, to);
    const [updated] = await exec
      .update(bookingAttemptsTable)
      .set({ ...patch, state: to, updatedAt: this.now() })
      .where(eq(bookingAttemptsTable.id, attempt.id))
      .returning();
    return updated ?? { ...attempt, ...patch, state: to };
  }

  // ── PRESENTED ─────────────────────────────────────────────────────────────

  async createAttempt(input: CreateAttemptInput): Promise<BookingAttempt> {
    await this.assertTripAccess(input.userId, input.role, input.tripId);
    if (input.coveredTravelers.length === 0) {
      throw new BookingRefused("A booking must cover at least one traveler.");
    }
    const option = input.option;
    const label = option.summary.label;
    const why = deriveWhyThisOption({
      hint: input.whyHint,
      setSize: input.setSize,
      fitReasons: input.fitReasons,
      label,
    });
    const terms =
      option.kind === "flight"
        ? flightTerms({
            changeable: option.summary.changeable,
            refundable: option.summary.refundable,
          })
        : option.kind === "stay"
          ? {
              changeTerms: "Change rules are confirmed when the stay quote is issued.",
              cancelTerms:
                option.summary.cancellationTerms ??
                "Cancellation terms weren't stated by the supplier at search time.",
            }
          : { changeTerms: null, cancelTerms: null };

    const [attempt] = await db
      .insert(bookingAttemptsTable)
      .values({
        tripId: input.tripId,
        kind: option.kind,
        adapter: option.adapter,
        supplier: option.supplier,
        optionId: option.id,
        optionSnapshot: {
          option: option as unknown as Record<string, unknown>,
          setSize: input.setSize,
          fitReasons: input.fitReasons ? [...input.fitReasons] : undefined,
          change: input.change,
        },
        state: "presented",
        visibility: input.visibility ?? defaultVisibility(input.category),
        category: input.category ?? null,
        presentedAmountMinor: option.money.amountMinor,
        presentedCurrency: option.money.currency,
        homeEquivalentMinor: option.homeEquivalent?.money.amountMinor ?? null,
        homeCurrency: option.homeEquivalent?.money.currency ?? null,
        fxSnapshotId: option.homeEquivalent?.fxSnapshotId ?? null,
        changeTerms: terms.changeTerms,
        cancelTerms: terms.cancelTerms,
        whyThisOption: why.why,
        whyThisOptionText: why.text,
        rankingInputsHash: rankingInputsHash({
          optionId: option.id,
          pricedAt: option.pricedAt,
          amountMinor: option.money.amountMinor,
          currency: option.money.currency,
          fitReasons: input.fitReasons,
        }),
        executionChannel: option.fulfillment === "phone_only" ? "phone" : option.adapter,
      })
      .returning();
    if (!attempt) throw new Error("booking attempt insert returned no row");

    // Coverage rows. The payer defaults to the first covered traveler
    // (under the shipped policy that is the confirmer themselves).
    let payerAssigned = input.coveredTravelers.some((c) => c.isPayer);
    for (const covered of input.coveredTravelers) {
      const isPayer = covered.isPayer ?? !payerAssigned;
      if (isPayer) payerAssigned = true;
      await db.insert(bookingAttemptTravelersTable).values({
        attemptId: attempt.id,
        userId: covered.userId ?? null,
        rosterEntryId: covered.rosterEntryId ?? null,
        isPayer,
      });
    }
    logger.info(
      { attemptId: attempt.id, tripId: input.tripId, kind: option.kind, userId: input.userId },
      "[BookingGate] attempt presented",
    );
    return attempt;
  }

  // ── PRESENTED → REVERIFYING → REVIEW ──────────────────────────────────────

  async beginReview(attemptId: number, actor: { userId: number; role: string }): Promise<BeginReviewResult> {
    let attempt = await this.loadAttempt(attemptId);
    await this.assertTripAccess(actor.userId, actor.role, attempt.tripId);
    if (attempt.state === "review") {
      return { attempt, outcome: "already_in_review" };
    }
    attempt = await this.transition(attempt, "reverifying");

    const snapshotOption = attempt.optionSnapshot.option as unknown as WanderOption;
    const info = await this.requoteForAttempt(attempt, snapshotOption);

    if (info.outcome === "unverifiable") {
      attempt = await this.transition(attempt, "presented");
      return {
        attempt,
        outcome: "unverifiable",
        reason: info.reason ?? "The price couldn't be re-verified live right now.",
      };
    }
    if (info.outcome === "unavailable" || !info.option) {
      const reason = info.reason ?? "That option is no longer available.";
      attempt = await this.transition(attempt, "failed", { failureReason: reason });
      return { attempt, outcome: "unavailable", reason };
    }

    const fresh = info.option;
    const patch: Partial<BookingAttempt> = {
      optionSnapshot: {
        ...attempt.optionSnapshot,
        option: fresh as unknown as Record<string, unknown>,
        ...(info.changeContext ? { change: info.changeContext } : {}),
      },
      reviewedAmountMinor: fresh.money.amountMinor,
      reviewedCurrency: fresh.money.currency,
      homeEquivalentMinor: fresh.homeEquivalent?.money.amountMinor ?? attempt.homeEquivalentMinor,
      homeCurrency: fresh.homeEquivalent?.money.currency ?? attempt.homeCurrency,
      fxSnapshotId: fresh.homeEquivalent?.fxSnapshotId ?? attempt.fxSnapshotId,
      // A stay quote restates the cancellation position — the terms
      // the traveler confirms are the QUOTE's terms, not the search's.
      cancelTerms:
        fresh.kind === "stay"
          ? (fresh.summary.cancellationTerms ?? attempt.cancelTerms)
          : attempt.cancelTerms,
    };
    if (info.outcome === "changed") {
      patch.reviewVersion = attempt.reviewVersion + 1;
    }
    attempt = await this.transition(attempt, "review", patch);
    return {
      attempt,
      outcome: info.outcome,
      deltaText: info.outcome === "changed" ? info.deltaText : undefined,
    };
  }

  // ── REVIEW → CONFIRMED (policy-checked) ───────────────────────────────────

  async confirmAttempt(
    attemptId: number,
    actor: { userId: number; role: string; channel?: "text" | "voice" },
  ): Promise<ConfirmResult> {
    let attempt = await this.loadAttempt(attemptId);
    await this.assertTripAccess(actor.userId, actor.role, attempt.tripId);
    // Voice proposes, screen confirms (§2.4): a confirmation that arrives
    // on the voice channel is refused BEFORE anything is recorded — no
    // per-traveler confirmation, no transition, no writes at all. The
    // gate enforces this, not the gateway, so no voice client (or model
    // acting on a spoken "yes") can complete the money moment. The
    // on-screen review surface confirms through this same method on the
    // text channel.
    if (actor.channel === "voice") {
      logger.info(
        { attemptId, userId: actor.userId },
        "[BookingGate] voice-channel confirmation refused — screen confirmation required",
      );
      return {
        confirmed: false,
        reason:
          "Voice can't confirm a booking. Confirmation has to happen on screen, on the review card, " +
          "with the exact total and terms in front of you — tap Confirm there, then tell me to go ahead.",
        attempt,
        coverage: await this.loadCoverage(attemptId),
      };
    }
    if (attempt.state === "confirmed" && attempt.confirmedByUserId === actor.userId) {
      return {
        confirmed: true,
        reason: "Already confirmed.",
        attempt,
        coverage: await this.loadCoverage(attemptId),
      };
    }
    // Throws GateTransitionError unless the attempt is in REVIEW.
    assertTransition(attempt.state, "confirmed");

    // Record the confirmer's OWN confirmation first — per-traveler
    // tracking is real even when the policy then refuses the whole.
    const coverage = await this.loadCoverage(attemptId);
    const own = coverage.find((c) => c.userId === actor.userId);
    if (own && !own.confirmedAt) {
      await db
        .update(bookingAttemptTravelersTable)
        .set({ confirmedAt: this.now() })
        .where(eq(bookingAttemptTravelersTable.id, own.id));
      own.confirmedAt = this.now();
    }

    const decision = this.policy.evaluateConfirm({
      coverage: coverage.map(toCoverageEntry),
      confirmerUserId: actor.userId,
    });
    if (!decision.allowed) {
      logger.info(
        { attemptId, userId: actor.userId, policy: this.policy.mode },
        "[BookingGate] confirmation refused by policy",
      );
      return { confirmed: false, reason: decision.reason, attempt, coverage };
    }

    attempt = await this.transition(attempt, "confirmed", {
      confirmedByUserId: actor.userId,
      confirmedAt: this.now(),
    });
    // Ledger lifecycle (E-3.4): confirming a CHANGE attempt moves its
    // target booking to change_pending. The booking's own machine is
    // separate from the attempt's — this is the one place they touch
    // before execution. Only a confirmed booking can pend; anything
    // else is left exactly as it is.
    const changeCtx = attempt.optionSnapshot.change;
    if (changeCtx) {
      await db
        .update(bookingsTable)
        .set({ status: "change_pending", updatedAt: this.now() })
        .where(
          and(eq(bookingsTable.id, changeCtx.bookingId), eq(bookingsTable.status, "confirmed")),
        );
    }
    logger.info({ attemptId, userId: actor.userId }, "[BookingGate] attempt confirmed");
    return { confirmed: true, reason: decision.reason, attempt, coverage };
  }

  /** Undo the change_pending mark when a change attempt falls back
   * (price moved at the execution boundary, option vanished): the
   * booking returns to plain confirmed — it was never changed. */
  private async restoreChangePending(bookingId: number): Promise<void> {
    await db
      .update(bookingsTable)
      .set({ status: "confirmed", updatedAt: this.now() })
      .where(and(eq(bookingsTable.id, bookingId), eq(bookingsTable.status, "change_pending")));
  }

  // ── CONFIRMED → EXECUTING → BOOKED | FAILED ───────────────────────────────

  async executeAttempt(
    attemptId: number,
    actor: { userId: number; role: string },
  ): Promise<ExecuteResult> {
    let attempt = await this.loadAttempt(attemptId);
    await this.assertTripAccess(actor.userId, actor.role, attempt.tripId);

    // Idempotent re-entry: a BOOKED attempt returns its booking; the
    // provider is never called twice for one attempt.
    if (attempt.state === "booked" && attempt.bookingId) {
      const [booking] = await db
        .select()
        .from(bookingsTable)
        .where(eq(bookingsTable.id, attempt.bookingId));
      if (booking) return { executed: true, alreadyBooked: true, attempt, booking };
    }
    if (attempt.state === "executing") {
      return {
        executed: false,
        attempt,
        reason:
          "Execution is already in progress for this booking — its state must be reconciled, never re-sent.",
      };
    }
    // Throws GateTransitionError unless CONFIRMED — there is no path
    // from PRESENTED/REVIEW to execution.
    assertTransition(attempt.state, "executing");

    const changeCtx = attempt.optionSnapshot.change;
    const supported =
      attempt.adapter === "duffel" && (attempt.kind === "flight" || attempt.kind === "stay");
    if (!supported) {
      return {
        executed: false,
        attempt,
        reason: `Execution for ${attempt.kind} options isn't wired to a booking rail yet — this attempt stays confirmed, nothing was booked.`,
      };
    }
    if (attempt.kind === "flight" && !this.ordersClient) {
      return {
        executed: false,
        attempt,
        reason: "Duffel isn't configured (no DUFFEL_API_TOKEN), so bookings can't be executed. Nothing was booked.",
      };
    }
    if (attempt.kind === "stay" && !this.staysClient) {
      return {
        executed: false,
        attempt,
        reason: "Duffel isn't configured (no DUFFEL_API_TOKEN), so bookings can't be executed. Nothing was booked.",
      };
    }

    // Policy rules at CONFIRMED (§5.2): a booking_channel_required rule
    // refuses off-channel execution, with the reason stated (TC-5).
    const rulesUserId = attempt.confirmedByUserId ?? actor.userId;
    const rules = await this.loadRules(rulesUserId);
    const channelCheck = checkExecutionChannel(rules, {
      channel: attempt.executionChannel ?? "duffel",
    });
    if (!channelCheck.allowed) {
      return { executed: false, attempt, reason: channelCheck.refusals[0]?.message ?? "Refused by a booking-channel rule." };
    }

    // Re-verify AGAIN at the execution boundary (§5.2): the reviewed
    // total is never silently updated, and a changed option is a new
    // presentation — back to REVIEW, zero provider creates.
    const snapshotOption = attempt.optionSnapshot.option as unknown as WanderOption;
    const info = await this.requoteForAttempt(attempt, snapshotOption);
    if (info.outcome === "unverifiable") {
      return {
        executed: false,
        attempt,
        reason: info.reason ?? "The price couldn't be re-verified live right now — nothing was booked.",
      };
    }
    if (info.outcome === "unavailable" || !info.option) {
      const reason =
        info.reason ??
        (attempt.kind === "stay"
          ? "That stay is no longer available."
          : "That flight is no longer available.");
      attempt = await this.transition(attempt, "failed", { failureReason: reason });
      if (changeCtx) await this.restoreChangePending(changeCtx.bookingId);
      return { executed: false, attempt, reason };
    }
    if (info.outcome === "changed") {
      attempt = await this.transition(attempt, "review", {
        optionSnapshot: {
          ...attempt.optionSnapshot,
          option: info.option as unknown as Record<string, unknown>,
          ...(info.changeContext ? { change: info.changeContext } : {}),
        },
        reviewedAmountMinor: info.option.money.amountMinor,
        reviewedCurrency: info.option.money.currency,
        reviewVersion: attempt.reviewVersion + 1,
        confirmedByUserId: null,
        confirmedAt: null,
      });
      if (changeCtx) await this.restoreChangePending(changeCtx.bookingId);
      return {
        executed: false,
        attempt,
        deltaText: info.deltaText,
        reason: "The price changed since you confirmed, so nothing was booked. Review the new total and confirm again if you'd like to go ahead.",
      };
    }

    // The fresh option (for a stay: the firm quote, quote id included)
    // is what execution acts on — persist it on the executing attempt.
    attempt = await this.transition(attempt, "executing", {
      optionSnapshot: {
        ...attempt.optionSnapshot,
        option: info.option as unknown as Record<string, unknown>,
        ...(info.changeContext ? { change: info.changeContext } : {}),
      },
    });

    // One state machine, three executions (§5.2/E-3.2/E-3.4): a change
    // attempt runs the provider's change flow against the original
    // booking; a stay books against its quote; a flight creates an
    // order. No parallel paths exist.
    if (changeCtx) return this.executeChangeAttempt(attempt, info);
    if (attempt.kind === "stay") return this.executeStayAttempt(attempt, info);
    return this.executeFlightAttempt(attempt, info);
  }

  // ── Flight execution (CONFIRMED → EXECUTING → BOOKED | FAILED) ────────────

  private async executeFlightAttempt(
    attempt: BookingAttempt,
    info: RequoteInfo,
  ): Promise<ExecuteResult> {
    const attemptId = attempt.id;
    const ordersClient = this.ordersClient;
    if (!ordersClient) {
      // Unreachable through executeAttempt (checked there); stated
      // plainly rather than assumed.
      return {
        executed: false,
        attempt,
        reason: "Duffel isn't configured (no DUFFEL_API_TOKEN), so bookings can't be executed. Nothing was booked.",
      };
    }

    // The ledger row comes FIRST (status pending): it anchors the
    // vault access log's booking_id and makes a crash mid-execution
    // reconcilable instead of invisible.
    const coverage = await this.loadCoverage(attemptId);
    const reviewedTotal = money(
      attempt.reviewedAmountMinor ?? attempt.presentedAmountMinor,
      attempt.reviewedCurrency ?? attempt.presentedCurrency,
    );
    const [booking] = await db
      .insert(bookingsTable)
      .values({
        attemptId: attempt.id,
        tripId: attempt.tripId,
        kind: attempt.kind,
        supplier: attempt.supplier,
        status: "pending",
        source: "api_rail",
        chargeAmountMinor: reviewedTotal.amountMinor,
        chargeCurrency: reviewedTotal.currency,
        homeEquivalentMinor: attempt.homeEquivalentMinor,
        homeCurrency: attempt.homeCurrency,
        fxSnapshotId: attempt.fxSnapshotId,
        merchantOfRecord: "duffel",
        changeTerms: attempt.changeTerms,
        cancelTerms: attempt.cancelTerms,
        whyThisOption: attempt.whyThisOption,
        whyThisOptionText: attempt.whyThisOptionText,
        rankingInputsHash: attempt.rankingInputsHash,
        visibility: attempt.visibility,
      })
      .returning();
    if (!booking) throw new Error("booking insert returned no row");
    for (const covered of coverage) {
      await db.insert(bookingTravelersTable).values({
        bookingId: booking.id,
        userId: covered.userId,
        rosterEntryId: covered.rosterEntryId,
        isPayer: covered.isPayer,
      });
    }

    const failExecution = async (reason: string): Promise<ExecuteResult> => {
      await db
        .update(bookingsTable)
        .set({ status: "failed", updatedAt: this.now() })
        .where(eq(bookingsTable.id, booking.id));
      const failed = await this.transition(attempt, "failed", { failureReason: reason, bookingId: booking.id });
      logger.warn({ attemptId, bookingId: booking.id, reason }, "[BookingGate] execution failed");
      return { executed: false, attempt: failed, booking: { ...booking, status: "failed" }, reason };
    };

    // Passengers: from the VAULT, per covered traveler, access-logged
    // against this booking. Never from chat text or tool arguments.
    let passengers: DuffelPassengerInput[];
    try {
      passengers = await this.buildPassengers(coverage, info.offerPassengerIds ?? [], booking.id);
    } catch (err) {
      if (err instanceof BookingRefused) return failExecution(err.reason);
      throw err;
    }

    // The create call — sent exactly once. 200/201/202 all mean
    // "accepted; check state, don't re-send" (Duffel discipline).
    let createResult: CreateOrderResult;
    try {
      createResult = await ordersClient.createOrder({
        offerId: attempt.optionId,
        passengers,
      });
    } catch (err) {
      const detail = err instanceof DuffelError ? err.message : err instanceof Error ? err.message : String(err);
      return failExecution(`The booking didn't go through: ${detail} Nothing was charged or booked — you can pick another option and try again.`);
    }

    const order = createResult.order;
    const pendingConfirmation = createResult.status === 202;
    const charged = parseOrderTotal(order);
    const rows = order ? mapOrderToFlightRows(order) : [];

    const finalized = await db.transaction(async (tx) => {
      const flightIds: number[] = [];
      for (const row of rows) {
        const [inserted] = await tx
          .insert(flightsTable)
          .values({
            tripId: attempt.tripId,
            flightNumber: row.flightNumber,
            airline: row.airline,
            departureAirport: row.departureAirport,
            arrivalAirport: row.arrivalAirport,
            departureDatetime: row.departureDatetime,
            arrivalDatetime: row.arrivalDatetime,
            departureTimezone: row.departureTimezone,
            arrivalTimezone: row.arrivalTimezone,
            confirmationCode: order?.booking_reference ?? null,
            notes: row.notes,
            direction: row.direction,
            totalPrice:
              flightIds.length === 0
                ? legacyAmountString(reviewedTotal)
                : null,
            currency: reviewedTotal.currency,
            fareBrand:
              info.option?.kind === "flight" ? info.option.summary.fareClass : null,
            refundable:
              info.option?.kind === "flight" ? (info.option.summary.refundable ?? null) : null,
            changeable:
              info.option?.kind === "flight" ? (info.option.summary.changeable ?? null) : null,
            passengerCount: coverage.length,
          })
          .returning();
        if (inserted) flightIds.push(inserted.id);
      }

      // Splits: equal shares in the charge currency, organizer first
      // (the remainder lands on the first share — §5.4).
      const orderedCoverage = orderCoverageForSplits(coverage, attempt.confirmedByUserId);
      const shares = computeBookingSplits(reviewedTotal, orderedCoverage.length);
      for (const [i, covered] of orderedCoverage.entries()) {
        await tx.insert(bookingSplitsTable).values({
          bookingId: booking.id,
          userId: covered.userId,
          rosterEntryId: covered.rosterEntryId,
          shareAmountMinor: shares[i]?.amountMinor ?? 0,
          shareCurrency: reviewedTotal.currency,
        });
      }

      // Commission: Duffel flight bookings earn Wander no commission —
      // recorded EXPLICITLY as no_rail, never a null (Story 7.2/7.4).
      await tx.insert(commissionRecordsTable).values({
        bookingId: booking.id,
        partnerProgram: "duffel",
        basis: null,
        rateBps: null,
        expectedAmountMinor: null,
        expectedCurrency: null,
        status: "no_rail",
        noRailReason: "no_commission_on_duffel_flights",
      });

      const fees = duffelRailFees(reviewedTotal);
      const [updatedBooking] = await tx
        .update(bookingsTable)
        .set({
          status: pendingConfirmation ? "pending" : "confirmed",
          confirmationCode: order?.booking_reference ?? null,
          providerOrderId: order?.id ?? null,
          amountActuallyChargedMinor: charged?.amountMinor ?? null,
          railProvider: fees.railProvider,
          railOrderFeeMinor: fees.orderFeeMinor,
          railPctFeeMinor: fees.pctFeeMinor,
          railFeeCurrency: fees.feeCurrency,
          processingFeeMinor: null,
          costAttribution: {
            ...(charged && charged.amountMinor !== reviewedTotal.amountMinor
              ? {
                  chargeDiscrepancy:
                    "The supplier reported a different charged total than the reviewed total; the reviewed total is what was authorized.",
                }
              : {}),
          },
          flightId: flightIds[0] ?? null,
          projection: { flightIds },
          updatedAt: this.now(),
        })
        .where(eq(bookingsTable.id, booking.id))
        .returning();

      const bookedAttempt = await this.transition(
        { ...attempt, state: "executing" },
        "booked",
        { bookingId: booking.id },
        tx,
      );
      return { booking: updatedBooking ?? booking, flightIds, bookedAttempt };
    });

    // Watching: register a FlightAware watch per projected leg —
    // best-effort; a watch failure never un-books a booking (§6.1).
    let firstWatch: { ident?: string; alertId?: string } | null = null;
    for (const flightId of finalized.flightIds) {
      try {
        const result = (await this.registerWatch(flightId)) as {
          created?: boolean;
          watch?: { ident?: string; alertId?: string | null };
        } | null;
        if (!firstWatch && result?.watch) {
          firstWatch = { ident: result.watch.ident, alertId: result.watch.alertId ?? undefined };
        }
      } catch (err) {
        logger.warn({ attemptId, flightId, err }, "[BookingGate] watch registration failed (best-effort)");
      }
    }
    if (firstWatch) {
      await db
        .update(bookingsTable)
        .set({
          flightawareIdent: firstWatch.ident ?? null,
          alertRegistrationId: firstWatch.alertId ?? null,
          updatedAt: this.now(),
        })
        .where(eq(bookingsTable.id, booking.id));
    }

    logger.info(
      { attemptId, bookingId: booking.id, pendingConfirmation },
      "[BookingGate] booking executed",
    );
    return {
      executed: true,
      pendingConfirmation,
      attempt: finalized.bookedAttempt,
      booking: finalized.booking,
    };
  }

  // ── Stay execution (the same machine; quote → book, E-3.2) ────────────────

  private async executeStayAttempt(
    attempt: BookingAttempt,
    info: RequoteInfo,
  ): Promise<ExecuteResult> {
    const attemptId = attempt.id;
    const staysClient = this.staysClient;
    const option = info.option;
    if (!staysClient || !option || option.kind !== "stay") {
      // Unreachable through executeAttempt (checked there); stated
      // plainly rather than assumed.
      return {
        executed: false,
        attempt,
        reason: "Duffel isn't configured (no DUFFEL_API_TOKEN), so bookings can't be executed. Nothing was booked.",
      };
    }
    const summary = option.summary;

    // The ledger row comes FIRST (status pending) — the same
    // discipline as flights: it anchors the vault access log's
    // booking_id and makes a crash mid-execution reconcilable.
    const coverage = await this.loadCoverage(attemptId);
    const reviewedTotal = money(
      attempt.reviewedAmountMinor ?? attempt.presentedAmountMinor,
      attempt.reviewedCurrency ?? attempt.presentedCurrency,
    );
    const [booking] = await db
      .insert(bookingsTable)
      .values({
        attemptId: attempt.id,
        tripId: attempt.tripId,
        kind: "stay",
        supplier: attempt.supplier,
        status: "pending",
        source: "api_rail",
        chargeAmountMinor: reviewedTotal.amountMinor,
        chargeCurrency: reviewedTotal.currency,
        homeEquivalentMinor: attempt.homeEquivalentMinor,
        homeCurrency: attempt.homeCurrency,
        fxSnapshotId: attempt.fxSnapshotId,
        merchantOfRecord: "duffel",
        changeTerms: attempt.changeTerms,
        cancelTerms: summary.cancellationTerms ?? attempt.cancelTerms,
        whyThisOption: attempt.whyThisOption,
        whyThisOptionText: attempt.whyThisOptionText,
        rankingInputsHash: attempt.rankingInputsHash,
        visibility: attempt.visibility,
      })
      .returning();
    if (!booking) throw new Error("booking insert returned no row");
    for (const covered of coverage) {
      await db.insert(bookingTravelersTable).values({
        bookingId: booking.id,
        userId: covered.userId,
        rosterEntryId: covered.rosterEntryId,
        isPayer: covered.isPayer,
      });
    }

    const failExecution = async (reason: string): Promise<ExecuteResult> => {
      await db
        .update(bookingsTable)
        .set({ status: "failed", updatedAt: this.now() })
        .where(eq(bookingsTable.id, booking.id));
      const failed = await this.transition(attempt, "failed", { failureReason: reason, bookingId: booking.id });
      logger.warn({ attemptId, bookingId: booking.id, reason }, "[BookingGate] stay execution failed");
      return { executed: false, attempt: failed, booking: { ...booking, status: "failed" }, reason };
    };

    // The booking is created against the QUOTE from re-verification —
    // never against the search estimate. No quote id, nothing firm to
    // book: fail honestly, zero provider creates.
    const quoteId = summary.quoteId;
    if (!quoteId) {
      return failExecution(
        "The stay couldn't be quoted at booking time, so nothing was booked. Review the stay again so a firm quote can be issued first.",
      );
    }

    // Guests: from the VAULT, per covered traveler, access-logged
    // against this booking — identical discipline to flight passengers.
    let guests: StayGuest[];
    try {
      guests = await this.buildStayGuests(coverage, booking.id);
    } catch (err) {
      if (err instanceof BookingRefused) return failExecution(err.reason);
      throw err;
    }

    // Lead contact (the documented booking body requires an email and
    // a phone number): the confirmer's account email + their vault
    // phone. Neither is ever taken from chat text or tool arguments.
    const lead = guests.find((g) => g.userId === attempt.confirmedByUserId) ?? guests[0];
    if (!lead) {
      return failExecution("No covered traveler could be the booking contact. Nothing was booked.");
    }
    if (!lead.phone) {
      return failExecution(
        "The property needs a contact phone number, and the lead traveler's profile doesn't have one yet. Nothing was booked.",
      );
    }
    const [leadUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, lead.userId));
    if (!leadUser?.email) {
      return failExecution(
        "The lead traveler has no email address on their account, which the property requires for the booking. Nothing was booked.",
      );
    }

    // The create call — sent exactly once. 200/201/202 all mean
    // "accepted; check state, don't re-send" (Duffel discipline).
    let result: CreateStayBookingResult;
    try {
      result = await staysClient.createBooking({
        quoteId,
        guests: guests.map((g) => ({
          givenName: g.givenName,
          familyName: g.familyName,
          bornOn: g.bornOn,
        })),
        email: leadUser.email,
        phoneNumber: lead.phone,
      });
    } catch (err) {
      const detail = err instanceof DuffelError ? err.message : err instanceof Error ? err.message : String(err);
      return failExecution(`The booking didn't go through: ${detail} Nothing was charged or booked — you can pick another option and try again.`);
    }

    const stayBooking = result.booking;
    const pendingConfirmation = result.status === 202;
    const charged = parseOrderTotal(stayBooking);

    const finalized = await db.transaction(async (tx) => {
      const [acc] = await tx
        .insert(accommodationsTable)
        .values({
          tripId: attempt.tripId,
          name: summary.propertyName,
          address: summary.addressLine ?? summary.areaLabel,
          checkIn: summary.checkInDate,
          checkOut: summary.checkOutDate,
          type: stayAccommodationType(summary),
          nightlyRate: summary.nightlyRate ? legacyAmountString(summary.nightlyRate) : null,
          totalPrice: legacyAmountString(reviewedTotal),
          currency: reviewedTotal.currency,
          confirmationCode: stayBooking?.reference ?? null,
          notes: stayNotes(summary),
        })
        .returning();

      // Splits: equal shares in the charge currency, organizer first
      // (the remainder lands on the first share — §5.4).
      const orderedCoverage = orderCoverageForSplits(coverage, attempt.confirmedByUserId);
      const shares = computeBookingSplits(reviewedTotal, orderedCoverage.length);
      for (const [i, covered] of orderedCoverage.entries()) {
        await tx.insert(bookingSplitsTable).values({
          bookingId: booking.id,
          userId: covered.userId,
          rosterEntryId: covered.rosterEntryId,
          shareAmountMinor: shares[i]?.amountMinor ?? 0,
          shareCurrency: reviewedTotal.currency,
        });
      }

      // Commission: Duffel Stays pays a profit share on completed
      // stays (api-ecosystem-map: monthly, above a $25 threshold) —
      // no per-booking amount or rate is stated anywhere in the
      // payload, so the record is "expected" with NO amount rather
      // than an invented figure (Story 7.2/7.4). The explanation is
      // carried in costAttribution below.
      await tx.insert(commissionRecordsTable).values({
        bookingId: booking.id,
        partnerProgram: "duffel_stays",
        basis: null,
        rateBps: null,
        expectedAmountMinor: null,
        expectedCurrency: null,
        status: "expected",
        noRailReason: null,
      });

      const [updatedBooking] = await tx
        .update(bookingsTable)
        .set({
          status: pendingConfirmation ? "pending" : "confirmed",
          confirmationCode: stayBooking?.reference ?? null,
          providerOrderId: stayBooking?.id ?? null,
          amountActuallyChargedMinor: charged?.amountMinor ?? null,
          railProvider: null,
          railOrderFeeMinor: null,
          railPctFeeMinor: null,
          railFeeCurrency: null,
          processingFeeMinor: null,
          costAttribution: {
            commissionNote:
              "Duffel Stays pays a profit share on completed stays, settled monthly above a $25 threshold; no per-booking commission amount or rate is stated by the provider, so the commission record carries no amount rather than an invented one.",
            ...(charged && charged.amountMinor !== reviewedTotal.amountMinor
              ? {
                  chargeDiscrepancy:
                    "The supplier reported a different charged total than the reviewed total; the reviewed total is what was authorized.",
                }
              : {}),
          },
          accommodationId: acc?.id ?? null,
          projection: { accommodationIds: acc ? [acc.id] : [] },
          updatedAt: this.now(),
        })
        .where(eq(bookingsTable.id, booking.id))
        .returning();

      const bookedAttempt = await this.transition(
        { ...attempt, state: "executing" },
        "booked",
        { bookingId: booking.id },
        tx,
      );
      return { booking: updatedBooking ?? booking, bookedAttempt };
    });

    logger.info(
      { attemptId, bookingId: booking.id, pendingConfirmation },
      "[BookingGate] stay booking executed",
    );
    return {
      executed: true,
      pendingConfirmation,
      attempt: finalized.bookedAttempt,
      booking: finalized.booking,
    };
  }

  /** Guests for a stay booking, from the vault — the flight-passenger
   * discipline, verbatim in spirit: legal name + DOB per traveler or
   * the booking refuses before any provider call. */
  private async buildStayGuests(
    coverage: BookingAttemptTraveler[],
    bookingId: number,
  ): Promise<StayGuest[]> {
    const guests: StayGuest[] = [];
    for (const [i, covered] of coverage.entries()) {
      if (!covered.userId) {
        throw new BookingRefused(
          `Traveler ${i + 1} hasn't set up their travel profile yet, so their booking details aren't available. Nothing was booked.`,
        );
      }
      const values = await this.readProfile(
        covered.userId,
        PASSENGER_FIELDS,
        { kind: "agent" },
        "booking_execution",
        bookingId,
      );
      const first = (values.legal_first_name as string | null | undefined) ?? null;
      const last = (values.legal_last_name as string | null | undefined) ?? null;
      const dob = (values.date_of_birth as string | null | undefined) ?? null;
      if (!first || !last || !dob) {
        const missing = [
          !first || !last ? "legal name" : null,
          !dob ? "date of birth" : null,
        ].filter(Boolean);
        throw new BookingRefused(
          `Traveler ${i + 1}'s profile is missing their ${missing.join(" and ")}, which the property requires. Nothing was booked.`,
        );
      }
      guests.push({
        userId: covered.userId,
        givenName: first,
        familyName: last,
        bornOn: dob,
        phone: (values.phone as string | null | undefined) ?? null,
      });
    }
    return guests;
  }

  // ── Change execution (the change offer IS the option, E-3.4) ──────────────

  private async executeChangeAttempt(
    attempt: BookingAttempt,
    info: RequoteInfo,
  ): Promise<ExecuteResult> {
    const attemptId = attempt.id;
    const ordersClient = this.ordersClient;
    const changeCtx = attempt.optionSnapshot.change;
    if (!ordersClient || !changeCtx) {
      return {
        executed: false,
        attempt,
        reason: "Duffel isn't configured (no DUFFEL_API_TOKEN), so changes can't be executed. Your original booking is unchanged.",
      };
    }
    const [original] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, changeCtx.bookingId));
    if (!original || !original.providerOrderId) {
      const reason = "The booking this change applies to couldn't be found, so nothing was changed.";
      const failed = await this.transition(attempt, "failed", { failureReason: reason });
      return { executed: false, attempt: failed, reason };
    }

    const reviewedDelta = money(
      attempt.reviewedAmountMinor ?? attempt.presentedAmountMinor,
      attempt.reviewedCurrency ?? attempt.presentedCurrency,
    );

    const failChange = async (reason: string, detail?: Record<string, unknown>): Promise<ExecuteResult> => {
      await db.insert(bookingOperationsTable).values({
        bookingId: original.id,
        tripId: attempt.tripId,
        attemptId: attempt.id,
        kind: "change",
        state: "failed",
        deltaAmountMinor: reviewedDelta.amountMinor,
        deltaCurrency: reviewedDelta.currency,
        newTotalAmountMinor: changeCtx.newTotalAmountMinor,
        newTotalCurrency: changeCtx.newTotalCurrency,
        penaltyAmountMinor: changeCtx.penaltyAmountMinor,
        penaltyCurrency: changeCtx.penaltyCurrency,
        termsText: attempt.changeTerms,
        details: detail ?? {},
        confirmedByUserId: attempt.confirmedByUserId,
        confirmedAt: attempt.confirmedAt,
        failureReason: reason,
      });
      await this.restoreChangePending(original.id);
      const failed = await this.transition(attempt, "failed", { failureReason: reason });
      logger.warn({ attemptId, bookingId: original.id, reason }, "[BookingGate] change execution failed");
      return { executed: false, attempt: failed, reason };
    };

    // Step 1: create the PENDING change from the confirmed offer —
    // sent exactly once. Nothing about the booking has changed yet.
    let pending: DuffelOrderChange;
    try {
      pending = await ordersClient.createOrderChange(attempt.optionId);
    } catch (err) {
      const detail = err instanceof DuffelError ? err.message : err instanceof Error ? err.message : String(err);
      return failChange(
        `The change didn't go through: ${detail} Your original flights are unchanged — nothing was charged or changed.`,
      );
    }
    if (!pending.id) {
      return failChange("The provider didn't return a change to confirm, so nothing was changed. Your original flights are unchanged.");
    }

    // The pending change restates its own price. If it moved against
    // the reviewed delta, do NOT confirm it — an unconfirmed pending
    // change expires on its own and the original booking stands.
    const pendingDelta = parseMoneyPair(pending.change_total_amount, pending.change_total_currency);
    if (
      pendingDelta &&
      (pendingDelta.amountMinor !== reviewedDelta.amountMinor ||
        pendingDelta.currency !== reviewedDelta.currency)
    ) {
      return failChange(
        `The change price moved from ${formatMoney(reviewedDelta)} to ${formatMoney(pendingDelta)} before confirmation, so it was NOT confirmed — the pending change will expire on its own and your original flights are unchanged. Review the new price and confirm again if you'd like to go ahead.`,
        { unconfirmedProviderChangeId: pending.id },
      );
    }
    const delta = pendingDelta ?? reviewedDelta;

    // Step 2: confirm — paying the change total from balance when it
    // is positive. This is the executing act, sent exactly once.
    let confirmedChange: DuffelOrderChange;
    try {
      confirmedChange = await ordersClient.confirmOrderChange(
        pending.id,
        delta.amountMinor > 0 ? delta : null,
      );
    } catch (err) {
      const detail = err instanceof DuffelError ? err.message : err instanceof Error ? err.message : String(err);
      return failChange(
        `The change wasn't confirmed: ${detail} A pending change was created but left unconfirmed — it will expire on its own, and your original flights are unchanged.`,
        { unconfirmedProviderChangeId: pending.id },
      );
    }
    if (!confirmedChange.confirmed_at) {
      return failChange(
        "The provider didn't confirm the change, so your original flights are unchanged.",
        { unconfirmedProviderChangeId: pending.id },
      );
    }

    // Re-read the order for its new state (best-effort: the change IS
    // confirmed provider-side either way; if the re-read fails the
    // ledger still records the change with the offer's stated total
    // and the stale projection is flagged in the operation details).
    let order: DuffelOrder | null = null;
    try {
      order = await ordersClient.getOrder(original.providerOrderId);
    } catch (err) {
      logger.warn({ attemptId, bookingId: original.id, err }, "[BookingGate] post-change order re-read failed");
    }
    const rows = order ? mapOrderToFlightRows(order) : [];
    const newTotal =
      parseOrderTotal(order) ??
      parseMoneyPair(confirmedChange.new_total_amount, confirmedChange.new_total_currency) ??
      money(changeCtx.newTotalAmountMinor, changeCtx.newTotalCurrency);

    // Watches: the old legs' watches deregister BEFORE re-projection
    // (§6.1) — best-effort, like registration.
    const projectedIds = (original.projection as { flightIds?: unknown } | null)?.flightIds;
    const oldFlightIds: number[] = Array.isArray(projectedIds)
      ? projectedIds.filter((id): id is number => typeof id === "number")
      : original.flightId
        ? [original.flightId]
        : [];
    for (const flightId of oldFlightIds) {
      try {
        await this.deregisterWatch(flightId);
      } catch (err) {
        logger.warn({ attemptId, flightId, err }, "[BookingGate] watch deregistration failed (best-effort)");
      }
    }

    const finalized = await db.transaction(async (tx) => {
      // Re-project the legacy flight rows from the changed order:
      // update in place by position, insert extras, and copy any
      // surplus rows into the operation record BEFORE deleting them —
      // the old state stays visible in the trip's history (in the
      // canonical layer) even though it leaves the itinerary.
      const currentRows: Array<typeof flightsTable.$inferSelect> = [];
      for (const flightId of oldFlightIds) {
        const [row] = await tx
          .select()
          .from(flightsTable)
          .where(eq(flightsTable.id, flightId));
        if (row) currentRows.push(row);
      }
      const removedRows: unknown[] = [];
      const newFlightIds: number[] = [];
      for (const [i, row] of rows.entries()) {
        const existing = currentRows[i];
        const values = {
          flightNumber: row.flightNumber,
          airline: row.airline,
          departureAirport: row.departureAirport,
          arrivalAirport: row.arrivalAirport,
          departureDatetime: row.departureDatetime,
          arrivalDatetime: row.arrivalDatetime,
          departureTimezone: row.departureTimezone,
          arrivalTimezone: row.arrivalTimezone,
          confirmationCode: order?.booking_reference ?? original.confirmationCode,
          notes: row.notes,
          direction: row.direction,
          totalPrice: i === 0 ? legacyAmountString(newTotal) : null,
          currency: newTotal.currency,
          fareBrand: info.option?.kind === "flight" ? info.option.summary.fareClass : null,
          refundable: info.option?.kind === "flight" ? (info.option.summary.refundable ?? null) : null,
          changeable: info.option?.kind === "flight" ? (info.option.summary.changeable ?? null) : null,
          passengerCount: existing?.passengerCount ?? null,
        };
        if (existing) {
          await tx.update(flightsTable).set(values).where(eq(flightsTable.id, existing.id));
          newFlightIds.push(existing.id);
        } else {
          const [inserted] = await tx
            .insert(flightsTable)
            .values({ tripId: attempt.tripId, ...values })
            .returning();
          if (inserted) newFlightIds.push(inserted.id);
        }
      }
      for (const surplus of currentRows.slice(rows.length)) {
        removedRows.push(surplus);
        await tx.delete(flightsTable).where(eq(flightsTable.id, surplus.id));
      }

      const [operation] = await tx
        .insert(bookingOperationsTable)
        .values({
          bookingId: original.id,
          tripId: attempt.tripId,
          attemptId: attempt.id,
          kind: "change",
          state: "executed",
          providerOperationId: confirmedChange.id ?? pending.id,
          deltaAmountMinor: delta.amountMinor,
          deltaCurrency: delta.currency,
          newTotalAmountMinor: newTotal.amountMinor,
          newTotalCurrency: newTotal.currency,
          penaltyAmountMinor: changeCtx.penaltyAmountMinor,
          penaltyCurrency: changeCtx.penaltyCurrency,
          termsText: attempt.changeTerms,
          details: {
            removedRows,
            previousTotalAmountMinor: original.chargeAmountMinor,
            previousTotalCurrency: original.chargeCurrency,
            providerOrderId: original.providerOrderId,
            ...(order ? {} : { orderReReadFailed: true }),
          },
          confirmedByUserId: attempt.confirmedByUserId,
          confirmedAt: attempt.confirmedAt,
          executedAt: this.now(),
        })
        .returning();

      const priorChanges =
        (original.costAttribution as { changes?: unknown[] } | null)?.changes ?? [];
      const [updatedBooking] = await tx
        .update(bookingsTable)
        .set({
          status: "changed",
          chargeAmountMinor: newTotal.amountMinor,
          chargeCurrency: newTotal.currency,
          amountActuallyChargedMinor:
            original.amountActuallyChargedMinor !== null &&
            original.amountActuallyChargedMinor !== undefined
              ? original.amountActuallyChargedMinor + delta.amountMinor
              : null,
          confirmationCode: order?.booking_reference ?? original.confirmationCode,
          costAttribution: {
            ...(original.costAttribution ?? {}),
            changes: [
              ...priorChanges,
              {
                operationId: operation?.id ?? null,
                attemptId: attempt.id,
                deltaAmountMinor: delta.amountMinor,
                deltaCurrency: delta.currency,
                at: this.now().toISOString(),
              },
            ],
          },
          flightId: newFlightIds[0] ?? null,
          projection: { flightIds: newFlightIds },
          updatedAt: this.now(),
        })
        .where(eq(bookingsTable.id, original.id))
        .returning();

      const bookedAttempt = await this.transition(
        { ...attempt, state: "executing" },
        "booked",
        { bookingId: original.id },
        tx,
      );
      return { booking: updatedBooking ?? original, flightIds: newFlightIds, bookedAttempt };
    });

    // Watching: register watches for the new legs — best-effort, the
    // same tail as a fresh booking (§6.1).
    let firstWatch: { ident?: string; alertId?: string } | null = null;
    for (const flightId of finalized.flightIds) {
      try {
        const result = (await this.registerWatch(flightId)) as {
          created?: boolean;
          watch?: { ident?: string; alertId?: string | null };
        } | null;
        if (!firstWatch && result?.watch) {
          firstWatch = { ident: result.watch.ident, alertId: result.watch.alertId ?? undefined };
        }
      } catch (err) {
        logger.warn({ attemptId, flightId, err }, "[BookingGate] watch registration failed (best-effort)");
      }
    }
    if (firstWatch) {
      await db
        .update(bookingsTable)
        .set({
          flightawareIdent: firstWatch.ident ?? null,
          alertRegistrationId: firstWatch.alertId ?? null,
          updatedAt: this.now(),
        })
        .where(eq(bookingsTable.id, original.id));
    }

    logger.info({ attemptId, bookingId: original.id }, "[BookingGate] flight change executed");
    return { executed: true, attempt: finalized.bookedAttempt, booking: finalized.booking };
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  async getAttemptView(
    attemptId: number,
    actor: { userId: number; role: string },
  ): Promise<{ attempt: BookingAttempt; coverage: BookingAttemptTraveler[] }> {
    const attempt = await this.loadAttempt(attemptId);
    await this.assertTripAccess(actor.userId, actor.role, attempt.tripId);
    return { attempt, coverage: await this.loadCoverage(attemptId) };
  }

  // ── Passengers from the vault ─────────────────────────────────────────────

  private async buildPassengers(
    coverage: BookingAttemptTraveler[],
    offerPassengerIds: string[],
    bookingId: number,
  ): Promise<DuffelPassengerInput[]> {
    if (offerPassengerIds.length === 0) {
      throw new BookingRefused(
        "The supplier's offer didn't carry passenger references, so the booking can't be completed safely. Nothing was booked.",
      );
    }
    if (coverage.length !== offerPassengerIds.length) {
      throw new BookingRefused(
        `The offer covers ${offerPassengerIds.length} passenger${offerPassengerIds.length === 1 ? "" : "s"} but this booking covers ${coverage.length} traveler${coverage.length === 1 ? "" : "s"} — the two must match before anything is booked. Nothing was booked.`,
      );
    }
    const passengers: DuffelPassengerInput[] = [];
    for (const [i, covered] of coverage.entries()) {
      if (!covered.userId) {
        throw new BookingRefused(
          `Traveler ${i + 1} hasn't set up their travel profile yet, so their booking details aren't available. Nothing was booked.`,
        );
      }
      const values = await this.readProfile(
        covered.userId,
        PASSENGER_FIELDS,
        { kind: "agent" },
        "booking_execution",
        bookingId,
      );
      const first = (values.legal_first_name as string | null | undefined) ?? null;
      const last = (values.legal_last_name as string | null | undefined) ?? null;
      const dob = (values.date_of_birth as string | null | undefined) ?? null;
      if (!first || !last || !dob) {
        const missing = [
          !first || !last ? "legal name" : null,
          !dob ? "date of birth" : null,
        ].filter(Boolean);
        throw new BookingRefused(
          `Traveler ${i + 1}'s profile is missing their ${missing.join(" and ")}, which the airline requires. Nothing was booked.`,
        );
      }
      passengers.push({
        id: offerPassengerIds[i],
        givenName: first,
        familyName: last,
        bornOn: dob,
        phoneNumber: (values.phone as string | null | undefined) ?? undefined,
      });
    }
    return passengers;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function toCoverageEntry(row: BookingAttemptTraveler): CoverageEntry {
  return {
    userId: row.userId,
    rosterEntryId: row.rosterEntryId,
    isPayer: row.isPayer,
    confirmedAt: row.confirmedAt,
  };
}

/** Organizer (the confirmer) first — splitEqually's remainder lands on
 * the first share, which is §5.4's remainder-to-organizer rule. */
function orderCoverageForSplits(
  coverage: BookingAttemptTraveler[],
  organizerUserId: number | null,
): BookingAttemptTraveler[] {
  if (!organizerUserId) return [...coverage];
  const organizer = coverage.filter((c) => c.userId === organizerUserId);
  const rest = coverage.filter((c) => c.userId !== organizerUserId);
  return [...organizer, ...rest];
}

function parseOrderTotal(order: { total_amount?: string; total_currency?: string } | null): Money | null {
  if (!order?.total_amount || !order.total_currency) return null;
  try {
    return fromMajorDecimal(order.total_amount, order.total_currency);
  } catch {
    return null;
  }
}

/** Legacy numeric(12,2) projection string via the sanctioned money
 * boundary converter (exponent-aware, ADR-6). */
function legacyAmountString(m: Money): string {
  return toLegacyPrice(m).amount;
}

/**
 * The default re-verification provider: a fresh GET of the Duffel
 * offer (Duffel's quote step). No client → unverifiable, stated
 * plainly. A 404/expired offer → unavailable. Any money or fare-class
 * drift → changed, with the delta in plain language.
 */
export function makeDuffelRequote(client: DuffelOrdersClient | null): RequoteProvider {
  return async (option: WanderOption): Promise<RequoteInfo> => {
    if (option.kind !== "flight" || option.adapter !== "duffel") {
      return {
        outcome: "unverifiable",
        reason: "Live re-verification isn't wired for this kind of option yet.",
      };
    }
    if (!client) {
      return {
        outcome: "unverifiable",
        reason: "Duffel isn't configured (no DUFFEL_API_TOKEN), so the price can't be re-verified live.",
      };
    }
    let offer: DuffelOffer;
    try {
      offer = await client.getOffer(option.id);
    } catch (err) {
      if (err instanceof DuffelError && err.status === 404) {
        return {
          outcome: "unavailable",
          reason: "That flight is no longer available — it sold out or the offer expired. Nothing was booked.",
        };
      }
      return {
        outcome: "unverifiable",
        reason: `The live price check failed (${err instanceof Error ? err.message : String(err)}). Nothing was booked.`,
      };
    }
    if (offer.expires_at && Date.parse(offer.expires_at) < Date.now()) {
      return {
        outcome: "unavailable",
        reason: "That flight offer has expired. Nothing was booked — a fresh search will find current options.",
      };
    }
    const fresh = mapDuffelOffer(offer, offer.created_at ?? new Date().toISOString());
    if (!fresh) {
      return {
        outcome: "unavailable",
        reason: "That flight is no longer available in a form we can state exactly. Nothing was booked.",
      };
    }
    const offerPassengerIds = (offer.passengers ?? [])
      .map((p) => p.id)
      .filter((id): id is string => typeof id === "string" && id !== "");
    const presented = money(option.money.amountMinor, option.money.currency);
    const fareChanged =
      fresh.kind === "flight" &&
      option.kind === "flight" &&
      fresh.summary.fareClass !== option.summary.fareClass;
    if (fresh.money.amountMinor !== presented.amountMinor || fresh.money.currency !== presented.currency || fareChanged) {
      const deltaText = fareChanged && fresh.money.amountMinor === presented.amountMinor
        ? `${fresh.summary.label}: the fare changed to ${fresh.summary.fareClass ?? "a different fare class"} since it was shown. Nothing was booked — review before confirming.`
        : describePriceDelta(presented, fresh.money, fresh.summary.label);
      return { outcome: "changed", option: fresh, deltaText, offerPassengerIds };
    }
    return { outcome: "same", option: fresh, offerPassengerIds };
  };
}

/** Parse a provider decimal amount pair; null unless both parse. */
function parseMoneyPair(amount: string | undefined, currency: string | undefined): Money | null {
  if (!amount || !currency) return null;
  try {
    return fromMajorDecimal(amount, currency);
  } catch {
    return null;
  }
}

/** Parse a payload amount only when it is stated in `currency`. */
function parseStatedMoney(
  amount: string | undefined,
  amountCurrency: string | undefined,
  currency: string,
): Money | null {
  if (!amount || !amountCurrency || amountCurrency.toUpperCase() !== currency) return null;
  return parseMoneyPair(amount, amountCurrency);
}

/**
 * Map a Duffel Stays quote onto the presented option (E-3.2): the
 * quote total is FIRM, the quote id lands on the summary (execution
 * books against it), cancellation terms refresh from the quote's own
 * timeline with the adapter's derivation, and the breakdown is
 * rebuilt from quote-stated figures only (a complete split that sums,
 * else base + combined remainder — the adapter's honesty rule).
 */
export function stayQuoteToRequoteInfo(
  quote: DuffelStayQuote,
  presented: StayOption,
  pricedAt: string,
): RequoteInfo {
  const total = parseMoneyPair(quote.total_amount, quote.total_currency);
  if (!quote.id || !total) {
    return {
      outcome: "unavailable",
      reason: "That stay is no longer available in a form we can state exactly. Nothing was booked.",
    };
  }
  const terms = stayCancellationTermsFromTimeline(
    { cancellation_timeline: quote.cancellation_timeline },
    total,
  );
  const fresh: StayOption = {
    ...presented,
    money: total,
    homeEquivalent: null,
    pricedAt,
    priceNature: "firm",
    summary: {
      ...presented.summary,
      quoteId: quote.id,
      cancellationTerms: terms.terms ?? presented.summary.cancellationTerms,
      freeCancellation: terms.free,
      breakdown: quoteBreakdown(quote, total),
    },
  };
  if (
    total.amountMinor === presented.money.amountMinor &&
    total.currency === presented.money.currency
  ) {
    return { outcome: "same", option: fresh };
  }
  return {
    outcome: "changed",
    option: fresh,
    deltaText: describeStayQuoteDelta(presented.money, total, presented.summary.label),
  };
}

function quoteBreakdown(quote: DuffelStayQuote, total: Money): StayRateBreakdown {
  const base = parseStatedMoney(quote.base_amount, quote.base_currency, total.currency);
  let tax = parseStatedMoney(quote.tax_amount, quote.tax_currency, total.currency);
  let fee = parseStatedMoney(quote.fee_amount, quote.fee_currency, total.currency);
  const fullSplit =
    !!base && !!tax && !!fee &&
    base.amountMinor + tax.amountMinor + fee.amountMinor === total.amountMinor;
  if (!fullSplit) {
    tax = null;
    fee = null;
  }
  const remainder = base && !fullSplit ? subtract(total, base) : null;
  const due = parseStatedMoney(
    quote.due_at_accommodation_amount,
    quote.due_at_accommodation_currency,
    total.currency,
  );
  return {
    base,
    tax,
    fee,
    taxesAndFees: remainder && remainder.amountMinor > 0 ? remainder : null,
    dueAtAccommodation: due && due.amountMinor > 0 ? due : null,
  };
}

/** Legacy accommodations.type for a stay summary. */
function stayAccommodationType(
  summary: StayOption["summary"],
): "hotel" | "airbnb" | "hostel" | "resort" | "other" {
  if (summary.isWholeHome) return "airbnb";
  if (summary.propertyType === "hostel") return "hostel";
  if (summary.propertyType === "resort") return "resort";
  return "hotel";
}

/** Projection notes for a stay: room, beds, board — display facts only. */
function stayNotes(summary: StayOption["summary"]): string | null {
  const parts = [
    summary.roomName,
    summary.beds,
    summary.boardType ? `Board: ${summary.boardType}` : null,
  ].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The default change re-verification: re-read the change request and
 * find the attempt's offer among its priced change offers. Gone or
 * expired → unavailable (the original booking is untouched); a moved
 * delta → changed, with the delta restated. The refreshed change
 * context (resulting total, penalty) rides back on the result.
 */
export function makeDuffelChangeRequote(client: DuffelOrdersClient | null): ChangeRequoteProvider {
  return async (option: WanderOption, change: BookingChangeContext): Promise<RequoteInfo> => {
    if (!client) {
      return {
        outcome: "unverifiable",
        reason: "Duffel isn't configured (no DUFFEL_API_TOKEN), so the change price can't be re-verified live.",
      };
    }
    let request: DuffelOrderChangeRequest;
    try {
      request = await client.getOrderChangeRequest(change.orderChangeRequestId);
    } catch (err) {
      return {
        outcome: "unverifiable",
        reason: `The live change check failed (${err instanceof Error ? err.message : String(err)}). Nothing was changed.`,
      };
    }
    const offer = (request.order_change_offers ?? []).find((o) => o.id === option.id);
    if (!offer) {
      return {
        outcome: "unavailable",
        reason: "That change is no longer available — the change offer expired or was withdrawn. Your original flights are unchanged.",
      };
    }
    if (offer.expires_at && Date.parse(offer.expires_at) < Date.now()) {
      return {
        outcome: "unavailable",
        reason: "That change offer has expired. Your original flights are unchanged — a fresh change request will price current options.",
      };
    }
    const fresh = mapChangeOfferToOption(offer, offer.created_at ?? new Date().toISOString());
    if (!fresh) {
      return {
        outcome: "unavailable",
        reason: "That change is no longer available in a form we can state exactly. Your original flights are unchanged.",
      };
    }
    const newTotal = parseMoneyPair(offer.new_total_amount, offer.new_total_currency);
    const penalty = parseMoneyPair(offer.penalty_total_amount, offer.penalty_total_currency);
    const changeContext: BookingChangeContext = {
      ...change,
      newTotalAmountMinor: newTotal?.amountMinor ?? change.newTotalAmountMinor,
      newTotalCurrency: newTotal?.currency ?? change.newTotalCurrency,
      penaltyAmountMinor: penalty ? penalty.amountMinor : change.penaltyAmountMinor,
      penaltyCurrency: penalty ? penalty.currency : change.penaltyCurrency,
    };
    const presented = money(option.money.amountMinor, option.money.currency);
    if (
      fresh.money.amountMinor !== presented.amountMinor ||
      fresh.money.currency !== presented.currency
    ) {
      return {
        outcome: "changed",
        option: fresh,
        deltaText: describePriceDelta(presented, fresh.money, fresh.summary.label),
        changeContext,
      };
    }
    return { outcome: "same", option: fresh, changeContext };
  };
}

// ─── Default wiring ──────────────────────────────────────────────────────────

let defaultGate: BookingGate | null = null;

export function getDefaultBookingGate(): BookingGate {
  if (!defaultGate) defaultGate = new BookingGate();
  return defaultGate;
}

/** Test seam: swap (or clear, with null) the lazily-built default gate. */
export function setDefaultBookingGateForTests(gate: BookingGate | null): void {
  defaultGate = gate;
}
