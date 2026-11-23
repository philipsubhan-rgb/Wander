/**
 * Client for the Booking Gate REVIEW confirmation surface
 * (design decision 6 — architecture §5's on-screen confirmation).
 *
 * The projection types mirror the API's BookingReviewProjection
 * (artifacts/api-server/src/lib/bookingReview.ts). Money is always
 * the gate's money-typed shape — integer minor units + ISO currency —
 * formatted through @workspace/money, never recomputed client-side.
 * The home equivalent carries its FX snapshot provenance; when the
 * API has no snapshot-backed equivalent it sends null and the card
 * shows nothing — never a client-side guess.
 */
import { formatMoney, money } from "@workspace/money";

export interface ReviewMoney {
  amountMinor: number;
  currency: string;
}

export interface BookingReviewProjection {
  attemptId: number;
  tripId: number;
  kind: string;
  supplier: string;
  state: string;
  label: string | null;
  detailLines: string[];
  total: ReviewMoney;
  totalIsReviewed: boolean;
  homeEquivalent: {
    amountMinor: number;
    currency: string;
    fx: {
      snapshotId: number;
      baseCurrency: string;
      quoteCurrency: string;
      rate: string;
      asOf: string;
      source: string;
    } | null;
  } | null;
  terms: string[];
  coveredTravelers: { name: string; isPayer: boolean; confirmed: boolean }[];
  whyThisOption: { value: string; text: string | null } | null;
  reviewVersion: number;
  confirmable: boolean;
  confirmBlockedReason: string | null;
  confirmedBy: { name: string; at: string } | null;
  failureReason: string | null;
  bookingId: number | null;
  updatedAt: string;
}

/** A confirm/review call failed; carries the server's current projection when one came back (409 drift, 422 policy refusal). */
export class BookingReviewApiError extends Error {
  status: number;
  review: BookingReviewProjection | null;
  constructor(status: number, message: string, review: BookingReviewProjection | null) {
    super(message);
    this.name = "BookingReviewApiError";
    this.status = status;
    this.review = review;
  }
}

async function readReviewResponse(res: Response): Promise<BookingReviewProjection> {
  const body = (await res.json().catch(() => ({}))) as {
    review?: BookingReviewProjection;
    error?: string;
  };
  if (!res.ok || !body.review) {
    throw new BookingReviewApiError(
      res.status,
      body.error ?? "Couldn't load this booking review.",
      body.review ?? null,
    );
  }
  return body.review;
}

export async function fetchBookingReview(
  tripId: number,
  attemptId: number,
): Promise<BookingReviewProjection> {
  const res = await fetch(`/api/trips/${tripId}/booking-attempts/${attemptId}/review`, {
    credentials: "include",
  });
  return readReviewResponse(res);
}

export async function fetchPendingReviews(tripId: number): Promise<BookingReviewProjection[]> {
  const res = await fetch(`/api/trips/${tripId}/booking-attempts?state=review`, {
    credentials: "include",
  });
  const body = (await res.json().catch(() => ({}))) as {
    reviews?: BookingReviewProjection[];
    error?: string;
  };
  if (!res.ok || !body.reviews) {
    throw new BookingReviewApiError(
      res.status,
      body.error ?? "Couldn't load pending confirmations.",
      null,
    );
  }
  return body.reviews;
}

/**
 * Confirm an attempt on screen (the gate runs this as a TEXT-channel
 * act). Sends the reviewVersion the traveler is looking at — a stale
 * version fails closed server-side with the current projection,
 * which the thrown error carries.
 */
export async function confirmBookingAttempt(
  tripId: number,
  attemptId: number,
  reviewVersion: number,
): Promise<BookingReviewProjection> {
  const res = await fetch(`/api/trips/${tripId}/booking-attempts/${attemptId}/confirm`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reviewVersion }),
  });
  return readReviewResponse(res);
}

/**
 * Chat messages are plain text, so the card's trigger is the attempt
 * id in the booking_review tool's result text:
 * "Booking review — United (flight), attempt #42:". The
 * change-flight tool can emit several review sections in one
 * message; every id is returned (deduped, in order).
 */
const REVIEW_ATTEMPT_PATTERN = /Booking review — [^\n]*attempt #(\d+):/g;

export function extractReviewAttemptIds(content: string): number[] {
  const ids: number[] = [];
  for (const match of content.matchAll(REVIEW_ATTEMPT_PATTERN)) {
    const id = Number(match[1]);
    if (Number.isFinite(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function formatReviewMoney(m: ReviewMoney): string {
  return formatMoney(money(m.amountMinor, m.currency));
}

/** "1 USD = 0.8497 EUR · ECB/Frankfurter · Nov 18, 2026" — the FX provenance line, from the snapshot, never computed. */
export function formatFxStamp(review: BookingReviewProjection): string | null {
  const fx = review.homeEquivalent?.fx;
  if (!fx) return null;
  const rate = Number(fx.rate);
  const rateText = Number.isFinite(rate) ? rate.toFixed(4) : fx.rate;
  const asOf = new Date(fx.asOf);
  const dateText = Number.isNaN(asOf.getTime())
    ? fx.asOf
    : asOf.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `1 ${fx.baseCurrency} = ${rateText} ${fx.quoteCurrency} · ${fx.source} · ${dateText}`;
}
