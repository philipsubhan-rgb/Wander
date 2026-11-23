/**
 * Booking Gate — the on-screen REVIEW surface endpoints
 * (architecture-north-star §5.2, design decision 6).
 *
 *   GET  /trips/:tripId/booking-attempts?state=review
 *   GET  /trips/:tripId/booking-attempts/:attemptId/review
 *   POST /trips/:tripId/booking-attempts/:attemptId/confirm
 *
 * The review GETs serve the BookingReviewCard (in Marco's conversation
 * and mirrored on the trip page); the confirm POST is the distinct UI
 * action the architecture binds the money moment to. It runs the
 * gate's EXISTING confirm path explicitly as a text-channel act — the
 * gate's voice guard is not bypassed or special-cased, it simply does
 * not apply to a screen act, exactly as the voice gateway's
 * confirmOnScreen already established.
 *
 * Drift discipline: a confirm may carry the reviewVersion the card
 * displayed. If the attempt's version has moved since (the price was
 * re-verified and changed), the confirm fails closed with 409 and the
 * CURRENT projection — nothing is confirmed against a stale total.
 *
 * Access: trip participants only, via requireTripParticipant (the
 * same 401/403 shapes as every other trip route); the gate re-checks
 * access per attempt. An attempt that belongs to another trip reads
 * as not found — cross-trip existence is never leaked.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { getAuthRole, getAuthUserId, requireTripParticipant } from "../middlewares/auth";
import {
  BookingAccessDenied,
  BookingNotFound,
  BookingRefused,
  getDefaultBookingGate,
  type ConfirmResult,
} from "../lib/bookingGate";
import { GateTransitionError } from "../lib/bookingGateLogic";
import {
  buildBookingReviewProjection,
  listBookingReviewProjections,
  type BookingReviewProjection,
} from "../lib/bookingReview";
import type { BookingGateState } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const GATE_STATES: readonly BookingGateState[] = [
  "presented",
  "reverifying",
  "review",
  "confirmed",
  "executing",
  "booked",
  "failed",
];

function actorOf(req: Request, res: Response): { userId: number; role: string } {
  return {
    userId: getAuthUserId(req, res) as number,
    role: getAuthRole(req, res) ?? "traveler",
  };
}

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Shared error mapping — the refusal shapes match the trip routes'. */
function sendGateError(res: Response, err: unknown): void {
  if (err instanceof BookingNotFound) {
    res.status(404).json({ error: "Booking attempt not found" });
    return;
  }
  if (err instanceof BookingAccessDenied) {
    res.status(403).json({ error: err.message });
    return;
  }
  if (err instanceof BookingRefused) {
    res.status(422).json({ error: err.reason });
    return;
  }
  logger.error({ err }, "[BookingAttempts] unexpected gate error");
  res.status(500).json({ error: "Internal server error" });
}

// ─── List (the trip page's mirror) ───────────────────────────────────────────

router.get(
  "/trips/:tripId/booking-attempts",
  requireTripParticipant(),
  async (req: Request, res: Response): Promise<void> => {
    const tripId = parseId(req.params.tripId);
    if (tripId === null) {
      res.status(400).json({ error: "Invalid tripId" });
      return;
    }
    const rawState = typeof req.query.state === "string" ? req.query.state : "review";
    if (!GATE_STATES.includes(rawState as BookingGateState)) {
      res.status(400).json({ error: `Unknown booking state: ${rawState}` });
      return;
    }
    try {
      const attempts = await listBookingReviewProjections(
        tripId,
        rawState as BookingGateState,
        actorOf(req, res),
      );
      res.json({ attempts });
    } catch (err) {
      sendGateError(res, err);
    }
  },
);

// ─── One attempt's review projection ─────────────────────────────────────────

router.get(
  "/trips/:tripId/booking-attempts/:attemptId/review",
  requireTripParticipant(),
  async (req: Request, res: Response): Promise<void> => {
    const tripId = parseId(req.params.tripId);
    const attemptId = parseId(req.params.attemptId);
    if (tripId === null || attemptId === null) {
      res.status(400).json({ error: "Invalid trip or attempt id" });
      return;
    }
    const actor = actorOf(req, res);
    try {
      const gate = getDefaultBookingGate();
      const { attempt, coverage } = await gate.getAttemptView(attemptId, actor);
      if (attempt.tripId !== tripId) {
        res.status(404).json({ error: "Booking attempt not found" });
        return;
      }
      const review = await buildBookingReviewProjection(gate, attempt, coverage, actor.userId);
      res.json({ review });
    } catch (err) {
      sendGateError(res, err);
    }
  },
);

// ─── The confirmation act (text channel, bound to the attempt id) ────────────

router.post(
  "/trips/:tripId/booking-attempts/:attemptId/confirm",
  requireTripParticipant(),
  async (req: Request, res: Response): Promise<void> => {
    const tripId = parseId(req.params.tripId);
    const attemptId = parseId(req.params.attemptId);
    if (tripId === null || attemptId === null) {
      res.status(400).json({ error: "Invalid trip or attempt id" });
      return;
    }
    const body = (req.body ?? {}) as { reviewVersion?: unknown };
    if (body.reviewVersion !== undefined && typeof body.reviewVersion !== "number") {
      res.status(400).json({ error: "reviewVersion must be a number" });
      return;
    }
    const actor = actorOf(req, res);
    const gate = getDefaultBookingGate();
    try {
      // Fail closed on a stale review BEFORE the gate is asked to
      // confirm anything: the version the card displayed must be the
      // version that is current, or the traveler reviews again.
      const view = await gate.getAttemptView(attemptId, actor);
      if (view.attempt.tripId !== tripId) {
        res.status(404).json({ error: "Booking attempt not found" });
        return;
      }
      if (
        typeof body.reviewVersion === "number" &&
        body.reviewVersion !== view.attempt.reviewVersion
      ) {
        const review = await buildBookingReviewProjection(
          gate,
          view.attempt,
          view.coverage,
          actor.userId,
        );
        res.status(409).json({
          error:
            "The price changed since this review was shown — nothing was confirmed. Review the current total and confirm again.",
          review,
        });
        return;
      }

      let result: ConfirmResult;
      try {
        result = await gate.confirmAttempt(attemptId, { ...actor, channel: "text" });
      } catch (err) {
        if (err instanceof GateTransitionError) {
          // Not in REVIEW (already booked/failed, or never reviewed):
          // a state conflict, answered with the current projection.
          const current = await gate.getAttemptView(attemptId, actor);
          const review = await buildBookingReviewProjection(
            gate,
            current.attempt,
            current.coverage,
            actor.userId,
          );
          res.status(409).json({
            error: `That booking can't be confirmed from its current state (${err.from}). Nothing was booked.`,
            review,
          });
          return;
        }
        throw err;
      }

      const review: BookingReviewProjection = await buildBookingReviewProjection(
        gate,
        result.attempt,
        result.coverage,
        actor.userId,
      );
      if (!result.confirmed) {
        // The gate's policy refusal, stated in the gate's own words —
        // a clear 4xx, never a 500, and the attempt stays at REVIEW.
        res.status(422).json({ error: result.reason, review });
        return;
      }
      res.json({ confirmed: true, review });
    } catch (err) {
      sendGateError(res, err);
    }
  },
);

export default router;
