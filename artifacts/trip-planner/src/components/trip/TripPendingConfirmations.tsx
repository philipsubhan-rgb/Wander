/**
 * "Waiting on your confirmation" — the trip page's mirror of the
 * booking-gate REVIEW state (design decision 6). Lists this trip's
 * attempts currently in REVIEW for a participant and renders each
 * as the same BookingReviewCard used in the Marco conversation, so
 * a confirmation moment is never trapped inside a chat scrollback.
 *
 * Renders nothing when there is nothing waiting (or the read
 * fails) — this section exists only while a decision is owed.
 * Event-driven: it loads on mount and reloads after a confirm;
 * no polling.
 */
import { useCallback, useEffect, useState } from "react";
import BookingReviewCard from "@/components/BookingReviewCard";
import { fetchPendingReviews, type BookingReviewProjection } from "@/lib/booking-review";

export default function TripPendingConfirmations({ tripId }: { tripId: number }) {
  const [reviews, setReviews] = useState<BookingReviewProjection[]>([]);

  const load = useCallback(async () => {
    try {
      setReviews(await fetchPendingReviews(tripId));
    } catch {
      setReviews([]);
    }
  }, [tripId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (reviews.length === 0) return null;

  return (
    <section aria-label="Waiting on your confirmation" className="mt-4 space-y-3">
      <h2 className="text-base font-semibold">Waiting on your confirmation</h2>
      {reviews.map((review) => (
        <BookingReviewCard
          key={review.attemptId}
          tripId={tripId}
          attemptId={review.attemptId}
          initialReview={review}
          onConfirmed={() => void load()}
        />
      ))}
    </section>
  );
}
