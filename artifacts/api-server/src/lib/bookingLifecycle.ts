/**
 * Booking Lifecycle Service — change & cancel for BOOKED ledger
 * records (architecture-north-star §5.2/§5.4/§6.1; Story E-3.4).
 *
 * Attempts and bookings are different machines. The gate's state
 * machine governs attempts; this service governs what happens to a
 * booking AFTER it exists:
 *
 *   CANCEL — the provider's cancellation terms are fetched FIRST
 *   (refund amount, penalty, quote deadline) and presented as a
 *   REVIEW-equivalent step on a booking_operations row
 *   (quoted → confirmed → executed). Only a confirmed cancel executes:
 *   the provider confirm call is unreachable from the quoted state,
 *   and the confirmation itself is policy-checked exactly like a gate
 *   confirmation (voice refused, shared coverage refused under the
 *   shipped policy). On success the ledger records the cancellation
 *   and the refund expectation, the legacy flight rows are MARKED
 *   (never deleted — history), the FlightAware watch deregisters, and
 *   the calendar write-back deletes through its existing hook where
 *   it applies (reservation-linked bookings; gate flight bookings
 *   carry no calendar events today — see the note in execute).
 *
 *   CHANGE — never a direct mutation of a booked record. Where the
 *   provider's documented API supports order changes for the order,
 *   each priced change offer becomes its OWN gate attempt (new
 *   presentation, delta stated, fresh confirmation — execution lives
 *   in the gate). Where it doesn't, this service returns plain
 *   cancel-and-rebook / phone guidance and writes nothing.
 *
 * Failure honesty mirrors the gate: a failed provider call leaves a
 * plain-language reason and no phantom state.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  bookingOperationsTable,
  bookingsTable,
  bookingTravelersTable,
  flightsTable,
  tripParticipantsTable,
  type Booking,
  type BookingAttempt,
  type BookingOperation,
  type BookingTraveler,
} from "@workspace/db";
import { formatMoney, fromMajorDecimal, money, type Money } from "@workspace/money";
import {
  ConservativeSelfOnlyPolicy,
  type ConfirmationPolicy,
} from "./bookingGateLogic";
import {
  getDefaultBookingGate,
  type BookingGate,
} from "./bookingGate";
import {
  duffelOrdersClientFromEnv,
  mapChangeOfferToOption,
  type DuffelChangeSliceAdd,
  type DuffelOrderCancellation,
  type DuffelOrdersClient,
} from "./duffel";
import { deleteLinkedCalendarEvents } from "./calendarSync";
import { deregisterWatchForFlight } from "./watching";
import { logger } from "./logger";

// ─── Errors ──────────────────────────────────────────────────────────────────

export class LifecycleNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleNotFound";
  }
}

export class LifecycleAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleAccessDenied";
  }
}

/** An operational refusal — nothing was written or executed. */
export class LifecycleRefused extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "LifecycleRefused";
  }
}

// ─── Results ─────────────────────────────────────────────────────────────────

export interface CancelQuoteResult {
  supported: boolean;
  booking: Booking;
  operation?: BookingOperation;
  /** The exact terms text presented to the traveler (also stored). */
  termsText?: string;
  /** Plain guidance when the API path doesn't apply (nothing written). */
  guidance?: string;
}

export interface CancelConfirmResult {
  confirmed: boolean;
  reason: string;
  operation: BookingOperation;
}

export interface CancelExecuteResult {
  executed: boolean;
  reason?: string;
  operation: BookingOperation;
  booking?: Booking;
  alreadyExecuted?: boolean;
}

export interface ChangePrepareResult {
  supported: boolean;
  booking: Booking;
  /** Gate attempts in REVIEW, one per priced change offer. */
  attempts?: BookingAttempt[];
  guidance?: string;
}

export interface ChangeRequestInput {
  /** Order slice ids to remove (from the booked order's slices). */
  removeSliceIds: string[];
  /** Search criteria for the slices to add. */
  addSlices: DuffelChangeSliceAdd[];
}

// ─── Deps ────────────────────────────────────────────────────────────────────

export interface BookingLifecycleDeps {
  /** undefined = from env; null = no rail configured. */
  ordersClient?: DuffelOrdersClient | null;
  gate?: BookingGate;
  deregisterWatch?: (flightId: number) => Promise<unknown>;
  deleteCalendarEvents?: (reservationId: number) => Promise<unknown>;
  policy?: ConfirmationPolicy;
  now?: () => Date;
}

// ─── The service ─────────────────────────────────────────────────────────────

export class BookingLifecycle {
  private readonly ordersClient: DuffelOrdersClient | null;
  private readonly gate: BookingGate;
  private readonly deregisterWatch: (flightId: number) => Promise<unknown>;
  private readonly deleteCalendarEvents: (reservationId: number) => Promise<unknown>;
  private readonly policy: ConfirmationPolicy;
  private readonly now: () => Date;

  constructor(deps: BookingLifecycleDeps = {}) {
    this.ordersClient =
      deps.ordersClient !== undefined ? deps.ordersClient : duffelOrdersClientFromEnv();
    this.gate = deps.gate ?? getDefaultBookingGate();
    this.deregisterWatch =
      deps.deregisterWatch ?? (async (flightId) => deregisterWatchForFlight(flightId));
    this.deleteCalendarEvents =
      deps.deleteCalendarEvents ??
      (async (reservationId) => deleteLinkedCalendarEvents(reservationId));
    this.policy = deps.policy ?? new ConservativeSelfOnlyPolicy();
    this.now = deps.now ?? (() => new Date());
  }

  // ── Access & loads ────────────────────────────────────────────────────────

  private async assertTripAccess(userId: number, role: string, tripId: number): Promise<void> {
    if (role === "super_admin") return;
    const [participant] = await db
      .select()
      .from(tripParticipantsTable)
      .where(and(eq(tripParticipantsTable.tripId, tripId), eq(tripParticipantsTable.userId, userId)));
    if (!participant) {
      throw new LifecycleAccessDenied(`You are not a participant of trip ${tripId}.`);
    }
  }

  private async loadBooking(bookingId: number): Promise<Booking> {
    const [booking] = await db
      .select()
      .from(bookingsTable)
      .where(eq(bookingsTable.id, bookingId));
    if (!booking) throw new LifecycleNotFound(`No booking ${bookingId}.`);
    return booking;
  }

  private async loadOperation(operationId: number): Promise<BookingOperation> {
    const [operation] = await db
      .select()
      .from(bookingOperationsTable)
      .where(eq(bookingOperationsTable.id, operationId));
    if (!operation) throw new LifecycleNotFound(`No booking operation ${operationId}.`);
    return operation;
  }

  private async loadBookingCoverage(bookingId: number): Promise<BookingTraveler[]> {
    return db
      .select()
      .from(bookingTravelersTable)
      .where(eq(bookingTravelersTable.bookingId, bookingId));
  }

  // ── CANCEL: quote the terms (the REVIEW-equivalent step) ──────────────────

  /**
   * Fetch the provider's cancellation terms and record them as a
   * QUOTED operation. This performs exactly two provider reads/writes
   * of the safe kind: GET the order (does this order support cancel?)
   * and POST an UNCONFIRMED cancellation quote. Nothing is cancelled
   * by this method — the provider-side confirm call exists only in
   * executeCancellation, behind the traveler's confirmation.
   */
  async quoteCancellation(
    bookingId: number,
    actor: { userId: number; role: string },
  ): Promise<CancelQuoteResult> {
    const booking = await this.loadBooking(bookingId);
    await this.assertTripAccess(actor.userId, actor.role, booking.tripId);

    if (booking.kind !== "flight") {
      return {
        supported: false,
        booking,
        guidance: `Cancelling a ${booking.kind} booking through the provider isn't wired up yet — nothing was changed. The property/airline can be called to cancel directly in the meantime.`,
      };
    }
    if (booking.status === "cancelled") {
      return { supported: false, booking, guidance: "This booking is already cancelled." };
    }
    if (booking.status !== "confirmed" && booking.status !== "changed") {
      return {
        supported: false,
        booking,
        guidance: `This booking is ${booking.status}, so there's no confirmed booking to cancel right now. Nothing was changed.`,
      };
    }
    if (!booking.providerOrderId) {
      return {
        supported: false,
        booking,
        guidance:
          "This booking has no provider order reference, so its cancellation terms can't be fetched. Nothing was changed.",
      };
    }
    if (!this.ordersClient) {
      return {
        supported: false,
        booking,
        guidance:
          "Duffel isn't configured (no DUFFEL_API_TOKEN), so cancellation terms can't be fetched. Nothing was cancelled.",
      };
    }

    const order = await this.ordersClient.getOrder(booking.providerOrderId);
    if (!(order.available_actions ?? []).includes("cancel")) {
      return {
        supported: false,
        booking,
        guidance:
          "This airline doesn't allow cancelling this booking through the booking API. The phone path is the way: call the airline, quote the confirmation code, and get the refund/credit position stated before agreeing to anything. Nothing was cancelled here.",
      };
    }

    const quote = await this.ordersClient.createOrderCancellation(booking.providerOrderId);
    const refund = parseMoneyPair(quote.refund_amount, quote.refund_currency);
    if (!quote.id || !refund) {
      throw new LifecycleRefused(
        "The airline returned cancellation terms that couldn't be stated exactly, so nothing was cancelled. Try again in a moment.",
      );
    }
    // The penalty is what's kept: charged total − refund, and only
    // when both are the same currency (no silent FX, §4.3 discipline).
    const penalty =
      refund.currency === booking.chargeCurrency
        ? money(Math.max(0, booking.chargeAmountMinor - refund.amountMinor), refund.currency)
        : null;
    const expiresAt = quote.expires_at ? new Date(quote.expires_at) : null;
    const termsText = buildCancellationTermsText({ booking, refund, penalty, refundTo: quote.refund_to, expiresAt });

    const [operation] = await db
      .insert(bookingOperationsTable)
      .values({
        bookingId: booking.id,
        tripId: booking.tripId,
        kind: "cancel",
        state: "quoted",
        providerOperationId: quote.id,
        refundAmountMinor: refund.amountMinor,
        refundCurrency: refund.currency,
        refundTo: quote.refund_to ?? null,
        penaltyAmountMinor: penalty?.amountMinor ?? null,
        penaltyCurrency: penalty?.currency ?? null,
        termsText,
        details: { providerOrderId: booking.providerOrderId },
        expiresAt,
      })
      .returning();
    if (!operation) throw new Error("booking operation insert returned no row");
    logger.info(
      { bookingId: booking.id, operationId: operation.id },
      "[BookingLifecycle] cancellation quoted",
    );
    return { supported: true, booking, operation, termsText };
  }

  // ── CANCEL: the traveler's confirmation ───────────────────────────────────

  /**
   * Record the traveler's explicit confirmation of the quoted
   * cancellation terms. Same discipline as the gate: voice cannot
   * confirm (refused before any write), and the ConfirmationPolicy
   * decides — under the shipped conservative policy a shared booking
   * cannot be cancelled by one traveler alone.
   */
  async confirmCancellation(
    operationId: number,
    actor: { userId: number; role: string; channel?: "text" | "voice" },
  ): Promise<CancelConfirmResult> {
    const operation = await this.loadOperation(operationId);
    const booking = await this.loadBooking(operation.bookingId);
    await this.assertTripAccess(actor.userId, actor.role, booking.tripId);

    if (actor.channel === "voice") {
      logger.info(
        { operationId, userId: actor.userId },
        "[BookingLifecycle] voice-channel cancellation confirmation refused — screen confirmation required",
      );
      return {
        confirmed: false,
        reason:
          "Voice can't confirm a cancellation. Confirmation has to happen on screen, with the refund and penalty terms in front of you — tap Confirm there, then tell me to go ahead.",
        operation,
      };
    }
    if (operation.kind !== "cancel") {
      return { confirmed: false, reason: "That record isn't a cancellation.", operation };
    }
    if (operation.state === "confirmed") {
      return { confirmed: true, reason: "Already confirmed.", operation };
    }
    if (operation.state !== "quoted") {
      return {
        confirmed: false,
        reason: `This cancellation is ${operation.state} and can't be confirmed.`,
        operation,
      };
    }
    if (operation.expiresAt && operation.expiresAt.getTime() < this.now().getTime()) {
      const [expired] = await db
        .update(bookingOperationsTable)
        .set({ state: "expired", updatedAt: this.now() })
        .where(eq(bookingOperationsTable.id, operation.id))
        .returning();
      return {
        confirmed: false,
        reason:
          "That cancellation quote has expired — the refund terms may have changed. Ask for a fresh quote first; nothing was cancelled.",
        operation: expired ?? { ...operation, state: "expired" as const },
      };
    }

    const coverage = await this.loadBookingCoverage(booking.id);
    const now = this.now();
    const decision = this.policy.evaluateConfirm({
      coverage: coverage.map((c) => ({
        userId: c.userId,
        rosterEntryId: c.rosterEntryId,
        isPayer: c.isPayer,
        confirmedAt: c.userId === actor.userId ? now : null,
      })),
      confirmerUserId: actor.userId,
    });
    if (!decision.allowed) {
      logger.info(
        { operationId, userId: actor.userId, policy: this.policy.mode },
        "[BookingLifecycle] cancellation confirmation refused by policy",
      );
      return { confirmed: false, reason: decision.reason, operation };
    }

    const [updated] = await db
      .update(bookingOperationsTable)
      .set({
        state: "confirmed",
        confirmedByUserId: actor.userId,
        confirmedAt: now,
        updatedAt: now,
      })
      .where(eq(bookingOperationsTable.id, operation.id))
      .returning();
    logger.info({ operationId, userId: actor.userId }, "[BookingLifecycle] cancellation confirmed");
    return {
      confirmed: true,
      reason: "Cancellation confirmed — it hasn't been executed yet.",
      operation: updated ?? { ...operation, state: "confirmed" as const },
    };
  }

  // ── CANCEL: execution (reachable only from CONFIRMED) ─────────────────────

  async executeCancellation(
    operationId: number,
    actor: { userId: number; role: string },
  ): Promise<CancelExecuteResult> {
    const operation = await this.loadOperation(operationId);
    const booking = await this.loadBooking(operation.bookingId);
    await this.assertTripAccess(actor.userId, actor.role, booking.tripId);

    if (operation.kind !== "cancel") {
      return { executed: false, reason: "That record isn't a cancellation.", operation };
    }
    if (operation.state === "executed") {
      return { executed: true, alreadyExecuted: true, operation, booking };
    }
    if (operation.state !== "confirmed") {
      // THE invariant: the provider confirm call is unreachable from
      // the quoted state. Terms first, confirmation second, execution
      // third — no other order exists.
      return {
        executed: false,
        operation,
        reason:
          operation.state === "quoted"
            ? "This cancellation hasn't been confirmed yet — the refund terms have to be confirmed first. Nothing was cancelled."
            : `This cancellation is ${operation.state} and can't be executed.`,
      };
    }
    if (operation.expiresAt && operation.expiresAt.getTime() < this.now().getTime()) {
      const [expired] = await db
        .update(bookingOperationsTable)
        .set({ state: "expired", updatedAt: this.now() })
        .where(eq(bookingOperationsTable.id, operation.id))
        .returning();
      return {
        executed: false,
        operation: expired ?? { ...operation, state: "expired" as const },
        reason:
          "That cancellation quote expired before it could be executed, so nothing was cancelled. Ask for a fresh quote — the terms may have changed.",
      };
    }
    if (!this.ordersClient || !operation.providerOperationId) {
      return {
        executed: false,
        operation,
        reason:
          "Duffel isn't configured (no DUFFEL_API_TOKEN), so the cancellation can't be executed. Nothing was cancelled.",
      };
    }

    // The provider confirm — sent exactly once.
    let confirmed: DuffelOrderCancellation;
    try {
      confirmed = await this.ordersClient.confirmOrderCancellation(operation.providerOperationId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const [failed] = await db
        .update(bookingOperationsTable)
        .set({ state: "failed", failureReason: detail, updatedAt: this.now() })
        .where(eq(bookingOperationsTable.id, operation.id))
        .returning();
      return {
        executed: false,
        operation: failed ?? { ...operation, state: "failed" as const },
        reason: `The cancellation didn't go through: ${detail} Nothing was cancelled — ask for a fresh quote to see the current terms.`,
      };
    }
    if (!confirmed.confirmed_at) {
      const [failed] = await db
        .update(bookingOperationsTable)
        .set({
          state: "failed",
          failureReason: "The provider didn't confirm the cancellation.",
          updatedAt: this.now(),
        })
        .where(eq(bookingOperationsTable.id, operation.id))
        .returning();
      return {
        executed: false,
        operation: failed ?? { ...operation, state: "failed" as const },
        reason: "The airline didn't confirm the cancellation, so the booking still stands. Nothing was cancelled.",
      };
    }

    const refund =
      parseMoneyPair(confirmed.refund_amount, confirmed.refund_currency) ??
      (operation.refundAmountMinor !== null && operation.refundCurrency
        ? money(operation.refundAmountMinor, operation.refundCurrency)
        : null);
    const refundTo = confirmed.refund_to ?? operation.refundTo;
    const now = this.now();
    const flightIds = projectedFlightIds(booking);

    const updatedBooking = await db.transaction(async (tx) => {
      const [updated] = await tx
        .update(bookingsTable)
        .set({
          status: "cancelled",
          costAttribution: {
            ...(booking.costAttribution ?? {}),
            cancellation: {
              operationId: operation.id,
              providerCancellationId: operation.providerOperationId,
              refundAmountMinor: refund?.amountMinor ?? null,
              refundCurrency: refund?.currency ?? null,
              refundTo,
              penaltyAmountMinor: operation.penaltyAmountMinor,
              penaltyCurrency: operation.penaltyCurrency,
              confirmedAt: confirmed.confirmed_at,
            },
          },
          updatedAt: now,
        })
        .where(eq(bookingsTable.id, booking.id))
        .returning();
      await tx
        .update(bookingOperationsTable)
        .set({
          state: "executed",
          executedAt: now,
          refundAmountMinor: refund?.amountMinor ?? operation.refundAmountMinor,
          refundCurrency: refund?.currency ?? operation.refundCurrency,
          refundTo,
          updatedAt: now,
        })
        .where(eq(bookingOperationsTable.id, operation.id));

      // Legacy rows are MARKED, never deleted — the trip's history
      // keeps the flight, visibly cancelled (idempotent marker).
      for (const flightId of flightIds) {
        const [row] = await tx
          .select()
          .from(flightsTable)
          .where(eq(flightsTable.id, flightId));
        if (!row) continue;
        const note = cancellationNote(now, refund, refundTo);
        if ((row.notes ?? "").includes(note)) continue;
        await tx
          .update(flightsTable)
          .set({ notes: row.notes ? `${row.notes} ${note}` : note })
          .where(eq(flightsTable.id, flightId));
      }
      return updated ?? { ...booking, status: "cancelled" as const };
    });

    // Watching deregisters (§6.1) — best-effort; a stranded watch
    // never un-cancels a cancellation.
    for (const flightId of flightIds) {
      try {
        await this.deregisterWatch(flightId);
      } catch (err) {
        logger.warn({ operationId, flightId, err }, "[BookingLifecycle] watch deregistration failed (best-effort)");
      }
    }
    // Calendar: the write-back hook deletes events for
    // RESERVATION-linked bookings. Gate flight bookings are not
    // reservation-linked (flight calendar write-back was never wired
    // — reservations only), so for them there are no calendar events
    // to delete today; when that wiring lands, this call covers it.
    if (booking.reservationId) {
      try {
        await this.deleteCalendarEvents(booking.reservationId);
      } catch (err) {
        logger.warn({ operationId, err }, "[BookingLifecycle] calendar cleanup failed (best-effort)");
      }
    }

    logger.info(
      { operationId, bookingId: booking.id },
      "[BookingLifecycle] cancellation executed",
    );
    return {
      executed: true,
      operation: { ...operation, state: "executed" as const, executedAt: now },
      booking: updatedBooking,
    };
  }

  // ── CHANGE: prepare priced change attempts through the gate ───────────────

  /**
   * Price a change of a booked flight. When the order supports API
   * changes, every priced change offer becomes its own gate attempt
   * (presented → reviewed here; confirmation and execution stay the
   * traveler's and the gate's). When it doesn't, plain guidance comes
   * back and NOTHING is written — a change never mutates a booked
   * record directly.
   */
  async prepareFlightChange(
    bookingId: number,
    actor: { userId: number; role: string },
    input: ChangeRequestInput,
  ): Promise<ChangePrepareResult> {
    const booking = await this.loadBooking(bookingId);
    await this.assertTripAccess(actor.userId, actor.role, booking.tripId);

    if (booking.kind !== "flight") {
      return {
        supported: false,
        booking,
        guidance: `Changing a ${booking.kind} booking through the provider isn't wired up yet — nothing was changed.`,
      };
    }
    if (booking.status !== "confirmed" && booking.status !== "changed") {
      return {
        supported: false,
        booking,
        guidance: `This booking is ${booking.status}, so it can't be changed right now. Nothing was changed.`,
      };
    }
    if (!booking.providerOrderId || !this.ordersClient) {
      return {
        supported: false,
        booking,
        guidance:
          "Duffel isn't configured (no DUFFEL_API_TOKEN), so change options can't be priced. Nothing was changed.",
      };
    }

    const order = await this.ordersClient.getOrder(booking.providerOrderId);
    if (!(order.available_actions ?? []).includes("change")) {
      return {
        supported: false,
        booking,
        guidance:
          "This airline doesn't allow changing this booking through the booking API. Two paths: (1) cancel-and-rebook — ask for the cancellation terms first, confirm them only once the replacement flights are ready to book, since cancelling is final; or (2) the phone path — call the airline and change it directly. Nothing was changed here.",
      };
    }
    const orderSliceIds = (order.slices ?? [])
      .map((s) => s.id)
      .filter((id): id is string => typeof id === "string" && id !== "");
    if (orderSliceIds.length > 0) {
      const unknown = input.removeSliceIds.filter((id) => !orderSliceIds.includes(id));
      if (unknown.length > 0) {
        return {
          supported: false,
          booking,
          guidance: `Those flights aren't part of this booking: ${unknown.join(", ")}. Nothing was changed.`,
        };
      }
    }

    const request = await this.ordersClient.createOrderChangeRequest({
      orderId: booking.providerOrderId,
      removeSliceIds: input.removeSliceIds,
      addSlices: input.addSlices,
    });
    if (!request.id) {
      throw new LifecycleRefused(
        "The airline didn't return a change request, so no change options could be priced. Your original flights are unchanged.",
      );
    }
    const full = await this.ordersClient.getOrderChangeRequest(request.id);
    const offers = full.order_change_offers ?? [];

    const coverage = (await this.loadBookingCoverage(booking.id)).map((c) => ({
      userId: c.userId,
      rosterEntryId: c.rosterEntryId,
      isPayer: c.isPayer,
    }));
    const coveredTravelers = coverage.length > 0 ? coverage : [{ userId: actor.userId, isPayer: true }];

    const attempts: BookingAttempt[] = [];
    for (const offer of offers) {
      const option = mapChangeOfferToOption(offer, offer.created_at ?? this.now().toISOString());
      if (!option) continue;
      const newTotal = parseMoneyPair(offer.new_total_amount, offer.new_total_currency);
      const penalty = parseMoneyPair(offer.penalty_total_amount, offer.penalty_total_currency);
      const attempt = await this.gate.createAttempt({
        userId: actor.userId,
        role: actor.role,
        tripId: booking.tripId,
        option,
        coveredTravelers,
        change: {
          bookingId: booking.id,
          orderChangeRequestId: request.id,
          newTotalAmountMinor: newTotal?.amountMinor ?? booking.chargeAmountMinor,
          newTotalCurrency: newTotal?.currency ?? booking.chargeCurrency,
          penaltyAmountMinor: penalty?.amountMinor ?? null,
          penaltyCurrency: penalty?.currency ?? null,
        },
      });
      const review = await this.gate.beginReview(attempt.id, {
        userId: actor.userId,
        role: actor.role,
      });
      attempts.push(review.attempt);
    }

    if (attempts.length === 0) {
      return {
        supported: true,
        booking,
        attempts: [],
        guidance:
          "The airline offered no priced way to make that change — no change options came back. Your original flights are unchanged.",
      };
    }
    logger.info(
      { bookingId: booking.id, changeOffers: attempts.length },
      "[BookingLifecycle] change options prepared as gate attempts",
    );
    return { supported: true, booking, attempts };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function parseMoneyPair(amount: string | undefined, currency: string | undefined): Money | null {
  if (!amount || !currency) return null;
  try {
    return fromMajorDecimal(amount, currency);
  } catch {
    return null;
  }
}

/** The booking's projected legacy flight ids (projection jsonb). */
function projectedFlightIds(booking: Booking): number[] {
  const ids = (booking.projection as { flightIds?: unknown } | null)?.flightIds;
  if (Array.isArray(ids)) {
    return ids.filter((id): id is number => typeof id === "number");
  }
  return booking.flightId ? [booking.flightId] : [];
}

/** Refund destination in plain words. */
export function refundDestinationText(refundTo: string | null | undefined): string {
  switch (refundTo) {
    case "original_form_of_payment":
      return "back to the original form of payment";
    case "airline_credits":
      return "as airline credit with the airline";
    case "duffel_balance":
      return "as a credit balance";
    default:
      return refundTo
        ? `via ${refundTo.replace(/_/g, " ")}`
        : "by the airline (destination not stated)";
  }
}

/**
 * The cancellation terms exactly as presented BEFORE confirmation
 * (E-3.4): refund amount, where it goes, the penalty the airline
 * keeps, and the quote deadline as the decision deadline.
 */
export function buildCancellationTermsText(input: {
  booking: Booking;
  refund: Money;
  penalty: Money | null;
  refundTo: string | null | undefined;
  expiresAt: Date | null;
}): string {
  const { booking, refund, penalty, refundTo, expiresAt } = input;
  const label = booking.confirmationCode
    ? `booking ${booking.confirmationCode}`
    : "this flight booking";
  const parts = [
    `Cancelling ${label}: refund of ${formatMoney(refund)} ${refundDestinationText(refundTo)}.`,
  ];
  if (penalty) {
    parts.push(
      `The airline keeps ${formatMoney(penalty)} of the ${formatMoney(money(booking.chargeAmountMinor, booking.chargeCurrency))} fare as the cancellation penalty.`,
    );
  } else {
    parts.push("No penalty could be computed from the stated figures.");
  }
  parts.push(
    expiresAt
      ? `These terms are a quote that expires at ${expiresAt.toISOString()} — confirm before then to cancel at exactly these terms.`
      : "These terms are a quote — confirm to cancel at exactly these terms.",
  );
  parts.push("Nothing is cancelled until the cancellation is confirmed.");
  return parts.join(" ");
}

/** The marker note appended to a cancelled booking's legacy rows. */
function cancellationNote(now: Date, refund: Money | null, refundTo: string | null): string {
  const day = now.toISOString().substring(0, 10);
  return refund
    ? `Cancelled ${day} — refund of ${formatMoney(refund)} expected ${refundDestinationText(refundTo)}.`
    : `Cancelled ${day}.`;
}

// ─── Default wiring ──────────────────────────────────────────────────────────

let defaultLifecycle: BookingLifecycle | null = null;

export function getDefaultBookingLifecycle(): BookingLifecycle {
  if (!defaultLifecycle) defaultLifecycle = new BookingLifecycle();
  return defaultLifecycle;
}

/** Test seam: swap (or clear, with null) the lazily-built default. */
export function setDefaultBookingLifecycleForTests(lifecycle: BookingLifecycle | null): void {
  defaultLifecycle = lifecycle;
}
