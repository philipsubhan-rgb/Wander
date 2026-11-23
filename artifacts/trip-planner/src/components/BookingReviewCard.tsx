/**
 * BookingReviewCard — the Booking Gate's on-screen confirmation
 * moment (architecture §5, design decision 6).
 *
 * Marco proposes; this card is where a booking is confirmed. It
 * renders the gate's review projection: what's being booked, the
 * exact total in the CHARGE currency as the hero figure, the
 * snapshot-backed home equivalent with its FX stamp when one
 * exists, plain-language terms, covered travelers (names only),
 * and why this option was picked.
 *
 * The Confirm action is bound to the attempt id and acts on the
 * CURRENT reviewVersion only: if the price drifted, the server
 * fails the confirm closed (409) and the card shows the delta and
 * the fresh review — nothing is ever confirmed against a stale
 * total. A shared item under the shipped conservative confirmation
 * policy renders an explanatory state with no confirm button.
 * Confirming does NOT book: after confirmation the card hands the
 * execute step back to Marco (the gate's booking_execute tool) —
 * there is deliberately no one-tap execute here.
 *
 * Dismiss is local only; it changes nothing server-side.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ShieldAlert, X, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  BookingReviewApiError,
  confirmBookingAttempt,
  fetchBookingReview,
  formatFxStamp,
  formatReviewMoney,
  type BookingReviewProjection,
  type ReviewMoney,
} from "@/lib/booking-review";

interface BookingReviewCardProps {
  tripId: number;
  attemptId: number;
  /** When the caller already holds the projection (trip-page list), skip the fetch. */
  initialReview?: BookingReviewProjection;
  /** Fired after a successful confirm (the trip-page list reloads itself). */
  onConfirmed?: () => void;
}

interface Drift {
  from: ReviewMoney;
  to: ReviewMoney;
}

export default function BookingReviewCard({
  tripId,
  attemptId,
  initialReview,
  onConfirmed,
}: BookingReviewCardProps) {
  const [review, setReview] = useState<BookingReviewProjection | null>(initialReview ?? null);
  const [loading, setLoading] = useState(!initialReview);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [drift, setDrift] = useState<Drift | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setReview(await fetchBookingReview(tripId, attemptId));
    } catch (err) {
      setLoadError(
        err instanceof Error ? err.message : "Couldn't load this booking review.",
      );
    } finally {
      setLoading(false);
    }
  }, [tripId, attemptId]);

  useEffect(() => {
    if (!initialReview) void load();
  }, [initialReview, load]);

  if (dismissed) return null;

  const shell = (children: React.ReactNode) => (
    <div
      data-testid="booking-review-card"
      className="relative w-full max-w-xl rounded-xl border bg-card p-4 shadow-sm"
    >
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="absolute right-2 top-2 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
      >
        <X className="h-4 w-4" />
      </button>
      {children}
    </div>
  );

  if (loading) {
    return shell(<p className="text-sm text-muted-foreground">Loading booking review…</p>);
  }

  if (!review) {
    return shell(
      <div className="space-y-2">
        <p className="text-sm text-destructive">{loadError ?? "Couldn't load this booking review."}</p>
        <Button type="button" variant="outline" className="min-h-[44px]" onClick={() => void load()}>
          Try again
        </Button>
      </div>,
    );
  }

  const heading = (
    <div className="pr-10">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Booking review — {review.supplier} ({review.kind})
      </p>
      {review.label && <p className="mt-1 text-base font-semibold">{review.label}</p>}
      {review.detailLines.map((line, i) => (
        <p key={i} className="text-sm text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );

  const totals = (
    <div className="mt-3">
      <p className="text-3xl font-bold tracking-tight">{formatReviewMoney(review.total)}</p>
      <p className="text-xs text-muted-foreground">
        Total in {review.total.currency}
        {review.totalIsReviewed ? " — the reviewed price" : ""}
      </p>
      {review.homeEquivalent && (
        <p className="mt-1 text-sm text-muted-foreground">
          ≈ {formatReviewMoney(review.homeEquivalent)}
          {formatFxStamp(review) && (
            <span className="block text-xs">Rate: {formatFxStamp(review)}</span>
          )}
        </p>
      )}
    </div>
  );

  const details = (
    <>
      {review.terms.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          {review.terms.map((term, i) => (
            <li key={i}>{term}</li>
          ))}
        </ul>
      )}
      {review.coveredTravelers.length > 0 && (
        <p className="mt-3 text-sm">
          <span className="text-muted-foreground">Covering: </span>
          {review.coveredTravelers
            .map(
              (t) =>
                `${t.name}${t.isPayer ? " (payer)" : ""}${t.confirmed ? " · confirmed" : ""}`,
            )
            .join(", ")}
        </p>
      )}
      {review.whyThisOption && (review.whyThisOption.text || review.whyThisOption.value) && (
        <p className="mt-2 text-sm text-muted-foreground">
          Why this option: {review.whyThisOption.text ?? review.whyThisOption.value}
        </p>
      )}
    </>
  );

  // — Confirmed: the confirmation moment is done; execution stays Marco's step.
  if (review.state === "confirmed") {
    return shell(
      <div>
        {heading}
        {totals}
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-primary/10 p-3 text-sm">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <p>
            Confirmed{review.confirmedBy ? ` by ${review.confirmedBy.name}` : ""}. Nothing is
            booked yet — tell Marco to go ahead and he'll complete the booking at this total.
          </p>
        </div>
        {details}
      </div>,
    );
  }

  // — Failed / expired.
  if (review.state === "failed") {
    return shell(
      <div>
        {heading}
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-sm">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p>
            This booking didn't go through — nothing was booked or charged.
            {review.failureReason ? ` ${review.failureReason}` : ""} Ask Marco for fresh
            options.
          </p>
        </div>
        {details}
      </div>,
    );
  }

  // — Past the confirmation moment (executing / booked / presented).
  if (review.state !== "review") {
    return shell(
      <div>
        {heading}
        {totals}
        <p className="mt-3 text-sm text-muted-foreground">
          {review.state === "booked"
            ? "Booked — you'll find it in your itinerary."
            : review.state === "executing"
              ? "Marco is completing this booking now…"
              : "Marco is preparing this booking for your review."}
        </p>
        {details}
      </div>,
    );
  }

  // — REVIEW: the live confirmation moment.
  const handleConfirm = async () => {
    setConfirming(true);
    setActionError(null);
    try {
      const updated = await confirmBookingAttempt(tripId, attemptId, review.reviewVersion);
      setReview(updated);
      setDrift(null);
      onConfirmed?.();
    } catch (err) {
      if (err instanceof BookingReviewApiError && err.review) {
        const fresh = err.review;
        if (err.status === 409 && fresh.reviewVersion !== review.reviewVersion) {
          // Drift: the price moved under the review. Show the delta
          // and the fresh review; confirming again acts on the NEW
          // version only.
          setDrift({ from: review.total, to: fresh.total });
        }
        setReview(fresh);
        setActionError(err.message);
      } else {
        setActionError(
          err instanceof Error ? err.message : "Couldn't confirm — please try again.",
        );
      }
    } finally {
      setConfirming(false);
    }
  };

  return shell(
    <div>
      {heading}
      {drift && (
        <div
          data-testid="booking-review-drift"
          className="mt-3 flex items-start gap-2 rounded-lg bg-amber-500/10 p-3 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p>
            The price changed from {formatReviewMoney(drift.from)} to{" "}
            {formatReviewMoney(drift.to)} since this review was first shown. Nothing was
            booked or confirmed — check the new total below and confirm again if it still
            works for you.
          </p>
        </div>
      )}
      {totals}
      {details}
      {actionError && !drift && <p className="mt-3 text-sm text-destructive">{actionError}</p>}
      {review.confirmable ? (
        <div className="mt-4 space-y-2">
          <Button
            type="button"
            className="min-h-[44px] w-full sm:w-auto"
            disabled={confirming}
            onClick={() => void handleConfirm()}
          >
            {confirming ? "Confirming…" : `Confirm — ${formatReviewMoney(review.total)}`}
          </Button>
          <p className="text-xs text-muted-foreground">
            Confirming doesn't book anything yet — Marco completes the booking only after
            you confirm, and re-checks the price first.
          </p>
        </div>
      ) : (
        <div
          data-testid="booking-review-blocked"
          className="mt-4 flex items-start gap-2 rounded-lg bg-muted p-3 text-sm"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <p>
            {review.confirmBlockedReason ??
              "This booking can't be confirmed on screen right now."}
          </p>
        </div>
      )}
    </div>,
  );
}
