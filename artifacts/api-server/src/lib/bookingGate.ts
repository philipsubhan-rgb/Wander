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
  bookingAttemptsTable,
  bookingAttemptTravelersTable,
  bookingsTable,
  bookingTravelersTable,
  bookingSplitsTable,
  commissionRecordsTable,
  flightsTable,
  tripParticipantsTable,
  type Booking,
  type BookingAttempt,
  type BookingAttemptTraveler,
} from "@workspace/db";
import { fromMajorDecimal, money, toLegacyPrice, type Money } from "@workspace/money";
import {
  assertTransition,
  computeBookingSplits,
  ConservativeSelfOnlyPolicy,
  defaultVisibility,
  deriveWhyThisOption,
  describePriceDelta,
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
  mapDuffelOffer,
  mapOrderToFlightRows,
  type CreateOrderResult,
  type DuffelOffer,
  type DuffelOrdersClient,
  type DuffelPassengerInput,
} from "./duffel";
import type { WanderOption } from "./options";
import { checkExecutionChannel, type RuleInput } from "./rulesEngine";
import { listRules, ruleRowToInput } from "./travelerContext";
import { readProfileFields, type ProfileFieldName } from "./travelerProfile";
import { registerWatchForFlight } from "./watching";
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
}

export type RequoteProvider = (option: WanderOption) => Promise<RequoteInfo>;

// ─── Deps (injectable; tests drive everything through these) ─────────────────

export interface BookingGateDeps {
  /** undefined = from env; null = no rail configured. */
  ordersClient?: DuffelOrdersClient | null;
  requote?: RequoteProvider;
  readProfile?: typeof readProfileFields;
  registerWatch?: (flightId: number) => Promise<unknown>;
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

// ─── The service ─────────────────────────────────────────────────────────────

export class BookingGate {
  private readonly ordersClient: DuffelOrdersClient | null;
  private readonly requote: RequoteProvider;
  private readonly readProfile: typeof readProfileFields;
  private readonly registerWatch: (flightId: number) => Promise<unknown>;
  private readonly loadRules: (userId: number) => Promise<RuleInput[]>;
  private readonly policy: ConfirmationPolicy;
  private readonly now: () => Date;

  constructor(deps: BookingGateDeps = {}) {
    this.ordersClient = deps.ordersClient !== undefined ? deps.ordersClient : duffelOrdersClientFromEnv();
    this.requote = deps.requote ?? makeDuffelRequote(this.ordersClient);
    this.readProfile = deps.readProfile ?? readProfileFields;
    this.registerWatch = deps.registerWatch ?? (async (flightId) => registerWatchForFlight(flightId));
    this.loadRules =
      deps.loadRules ?? (async (userId) => (await listRules(userId)).map(ruleRowToInput));
    this.policy = deps.policy ?? new ConservativeSelfOnlyPolicy();
    this.now = deps.now ?? (() => new Date());
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
    const info = await this.requote(snapshotOption);

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
      optionSnapshot: { ...attempt.optionSnapshot, option: fresh as unknown as Record<string, unknown> },
      reviewedAmountMinor: fresh.money.amountMinor,
      reviewedCurrency: fresh.money.currency,
      homeEquivalentMinor: fresh.homeEquivalent?.money.amountMinor ?? attempt.homeEquivalentMinor,
      homeCurrency: fresh.homeEquivalent?.money.currency ?? attempt.homeCurrency,
      fxSnapshotId: fresh.homeEquivalent?.fxSnapshotId ?? attempt.fxSnapshotId,
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
    actor: { userId: number; role: string },
  ): Promise<ConfirmResult> {
    let attempt = await this.loadAttempt(attemptId);
    await this.assertTripAccess(actor.userId, actor.role, attempt.tripId);
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
    logger.info({ attemptId, userId: actor.userId }, "[BookingGate] attempt confirmed");
    return { confirmed: true, reason: decision.reason, attempt, coverage };
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

    if (attempt.kind !== "flight" || attempt.adapter !== "duffel") {
      return {
        executed: false,
        attempt,
        reason: `Execution for ${attempt.kind} options isn't wired to a booking rail yet — this attempt stays confirmed, nothing was booked.`,
      };
    }
    if (!this.ordersClient) {
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
    const info = await this.requote(snapshotOption);
    if (info.outcome === "unverifiable") {
      return {
        executed: false,
        attempt,
        reason: info.reason ?? "The price couldn't be re-verified live right now — nothing was booked.",
      };
    }
    if (info.outcome === "unavailable" || !info.option) {
      const reason = info.reason ?? "That flight is no longer available.";
      attempt = await this.transition(attempt, "failed", { failureReason: reason });
      return { executed: false, attempt, reason };
    }
    if (info.outcome === "changed") {
      attempt = await this.transition(attempt, "review", {
        optionSnapshot: { ...attempt.optionSnapshot, option: info.option as unknown as Record<string, unknown> },
        reviewedAmountMinor: info.option.money.amountMinor,
        reviewedCurrency: info.option.money.currency,
        reviewVersion: attempt.reviewVersion + 1,
        confirmedByUserId: null,
        confirmedAt: null,
      });
      return {
        executed: false,
        attempt,
        deltaText: info.deltaText,
        reason: "The price changed since you confirmed, so nothing was booked. Review the new total and confirm again if you'd like to go ahead.",
      };
    }

    attempt = await this.transition(attempt, "executing");

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
      createResult = await this.ordersClient.createOrder({
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
