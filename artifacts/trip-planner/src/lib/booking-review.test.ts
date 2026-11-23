/**
 * booking-review lib — the chat-card trigger (attempt ids in the
 * booking_review tool's result text) and the FX stamp line.
 */
import { describe, it, expect } from "vitest";
import {
  extractReviewAttemptIds,
  formatFxStamp,
  type BookingReviewProjection,
} from "./booking-review";

describe("extractReviewAttemptIds", () => {
  it("finds the attempt id in a booking_review result", () => {
    const text =
      "Booking review — United (flight), attempt #42:\nTotal: $612.00\nNothing is booked yet.";
    expect(extractReviewAttemptIds(text)).toEqual([42]);
  });

  it("finds several ids in one message (change-flight emits a section per offer)", () => {
    const text = [
      "Booking review — United (flight), attempt #7:",
      "Total: $40.00",
      "Booking review — United (flight), attempt #8:",
      "Total: $55.00",
    ].join("\n");
    expect(extractReviewAttemptIds(text)).toEqual([7, 8]);
  });

  it("dedupes a repeated section and ignores ordinary chat text", () => {
    const text =
      "Booking review — Delta (flight), attempt #3:\n…\nBooking review — Delta (flight), attempt #3:";
    expect(extractReviewAttemptIds(text)).toEqual([3]);
    expect(extractReviewAttemptIds("Your flight leaves at 6pm, attempt to relax.")).toEqual([]);
    expect(extractReviewAttemptIds("")).toEqual([]);
  });
});

describe("formatFxStamp", () => {
  const base: BookingReviewProjection = {
    attemptId: 42,
    tripId: 7,
    kind: "flight",
    supplier: "United",
    state: "review",
    label: "UA30",
    detailLines: [],
    total: { amountMinor: 61200, currency: "USD" },
    totalIsReviewed: true,
    homeEquivalent: null,
    terms: [],
    coveredTravelers: [],
    whyThisOption: null,
    reviewVersion: 1,
    confirmable: true,
    confirmBlockedReason: null,
    confirmedBy: null,
    failureReason: null,
    bookingId: null,
    updatedAt: "2026-11-18T10:00:00.000Z",
  };

  it("renders the snapshot's rate, source and date — from the snapshot, not computed", () => {
    const review: BookingReviewProjection = {
      ...base,
      homeEquivalent: {
        amountMinor: 52000,
        currency: "EUR",
        fx: {
          snapshotId: 5,
          baseCurrency: "USD",
          quoteCurrency: "EUR",
          rate: "0.8496730000",
          asOf: "2026-11-18T05:30:00.000Z",
          source: "ECB/Frankfurter",
        },
      },
    };
    expect(formatFxStamp(review)).toBe("1 USD = 0.8497 EUR · ECB/Frankfurter · Nov 18, 2026");
  });

  it("is null when there is no snapshot-backed equivalent", () => {
    expect(formatFxStamp(base)).toBeNull();
  });
});
