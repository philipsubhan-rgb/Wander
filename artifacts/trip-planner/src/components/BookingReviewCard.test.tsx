// @vitest-environment jsdom
/**
 * BookingReviewCard — the gate's on-screen confirmation moment
 * (design decision 6). Covers the three states the brief calls
 * out: confirmable (hero total in charge currency, FX-stamped home
 * equivalent, confirm flips the card to confirmed and hands the
 * execute step back to Marco — no execute button), drifted (409 →
 * delta banner + fresh review; the retry acts on the NEW
 * reviewVersion only), and policy-refused (explanatory state, no
 * confirm button).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import React from "react";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function installFetch(handler: (call: FetchCall) => Response) {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const call: FetchCall = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body) : undefined,
      };
      calls.push(call);
      return handler(call);
    }),
  );
  return calls;
}

import BookingReviewCard from "@/components/BookingReviewCard";
import type { BookingReviewProjection } from "@/lib/booking-review";

function reviewFixture(overrides: Partial<BookingReviewProjection> = {}): BookingReviewProjection {
  return {
    attemptId: 42,
    tripId: 7,
    kind: "flight",
    supplier: "United",
    state: "review",
    label: "UA30",
    detailLines: ["EWR → MUC · UA30 · departs 2026-09-23 · nonstop"],
    total: { amountMinor: 61200, currency: "USD" },
    totalIsReviewed: true,
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
    terms: ["Cancellation: Refundable until departure."],
    coveredTravelers: [{ name: "Phil", isPayer: true, confirmed: false }],
    whyThisOption: { value: "best_price", text: "Cheapest nonstop at a sane hour." },
    reviewVersion: 1,
    confirmable: true,
    confirmBlockedReason: null,
    confirmedBy: null,
    failureReason: null,
    bookingId: null,
    updatedAt: "2026-11-18T10:00:00.000Z",
    ...overrides,
  };
}

describe("BookingReviewCard", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("confirmable: hero total, FX stamp, and a confirm that flips to confirmed — execute stays Marco's", async () => {
    const confirmed = reviewFixture({
      state: "confirmed",
      confirmedBy: { name: "Phil", at: "2026-11-18T10:05:00.000Z" },
      coveredTravelers: [{ name: "Phil", isPayer: true, confirmed: true }],
    });
    const calls = installFetch(() => jsonResponse(200, { confirmed: true, review: confirmed }));

    render(<BookingReviewCard tripId={7} attemptId={42} initialReview={reviewFixture()} />);

    // Hero figure is the CHARGE-currency total; home equivalent rides with its stamp.
    expect(screen.getByText("$612.00")).toBeTruthy();
    expect(screen.getByText(/Total in USD/)).toBeTruthy();
    expect(screen.getByText(/€520\.00/)).toBeTruthy();
    expect(screen.getByText(/1 USD = 0\.8497 EUR · ECB\/Frankfurter/)).toBeTruthy();
    expect(screen.getByText(/Covering:/)).toBeTruthy();
    expect(screen.getByText(/Why this option: Cheapest nonstop/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Confirm — \$612\.00/ }));

    expect(await screen.findByText(/Nothing is booked yet — tell Marco to go ahead/)).toBeTruthy();
    // The confirm acted on the version the traveler was looking at.
    const confirmCall = calls.find((c) => c.url.endsWith("/confirm"));
    expect(confirmCall?.method).toBe("POST");
    expect(confirmCall?.body).toEqual({ reviewVersion: 1 });
    // No one-tap execute anywhere on the card.
    expect(screen.queryByRole("button", { name: /book|execute/i })).toBeNull();
  });

  it("drifted: a 409 shows the delta and the fresh review; the retry acts on the NEW version only", async () => {
    const drifted = reviewFixture({
      reviewVersion: 2,
      total: { amountMinor: 64000, currency: "USD" },
    });
    const confirmed = reviewFixture({
      state: "confirmed",
      reviewVersion: 2,
      total: { amountMinor: 64000, currency: "USD" },
      confirmedBy: { name: "Phil", at: "2026-11-18T10:06:00.000Z" },
    });
    let attempt = 0;
    const calls = installFetch(() => {
      attempt += 1;
      return attempt === 1
        ? jsonResponse(409, {
            error: "The price changed since this review was shown — nothing was confirmed.",
            review: drifted,
          })
        : jsonResponse(200, { confirmed: true, review: confirmed });
    });

    render(<BookingReviewCard tripId={7} attemptId={42} initialReview={reviewFixture()} />);
    fireEvent.click(screen.getByRole("button", { name: /Confirm — \$612\.00/ }));

    const banner = await screen.findByTestId("booking-review-drift");
    expect(banner.textContent).toContain("$612.00");
    expect(banner.textContent).toContain("$640.00");
    expect(banner.textContent).toMatch(/Nothing was booked or confirmed/);
    // The card now shows the fresh total and confirms THAT version.
    expect(screen.getByText("$640.00")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Confirm — \$640\.00/ }));
    expect(await screen.findByText(/Nothing is booked yet — tell Marco to go ahead/)).toBeTruthy();
    const versions = calls.filter((c) => c.url.endsWith("/confirm")).map((c) => c.body);
    expect(versions).toEqual([{ reviewVersion: 1 }, { reviewVersion: 2 }]);
  });

  it("policy-refused: explanatory state with the gate's reason and NO confirm button", async () => {
    const reason =
      "This booking covers more than one traveler. Group confirmation is disabled until the group booking policy is decided, so it can't be confirmed yet — your own confirmation is recorded and visible.";
    render(
      <BookingReviewCard
        tripId={7}
        attemptId={42}
        initialReview={reviewFixture({
          confirmable: false,
          confirmBlockedReason: reason,
          coveredTravelers: [
            { name: "Phil", isPayer: true, confirmed: true },
            { name: "Katie", isPayer: false, confirmed: false },
          ],
        })}
      />,
    );

    const blocked = screen.getByTestId("booking-review-blocked");
    expect(blocked.textContent).toContain("covers more than one traveler");
    expect(screen.queryByRole("button", { name: /Confirm/ })).toBeNull();
    // Both travelers still show, names only.
    expect(screen.getByText(/Phil \(payer\) · confirmed, Katie/)).toBeTruthy();
  });

  it("dismiss changes nothing server-side", async () => {
    const calls = installFetch(() => jsonResponse(200, {}));
    const { container } = render(
      <BookingReviewCard tripId={7} attemptId={42} initialReview={reviewFixture()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(calls).toEqual([]);
  });
});
