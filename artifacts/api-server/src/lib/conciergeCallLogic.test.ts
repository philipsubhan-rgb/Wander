/**
 * Concierge-Call pure logic — completeness (no brief, no call), the
 * telephony cost model at published rates, the outcome evaluator
 * (spend-cap enforcement, info-only rejection, kind matching), the
 * retry pattern, provider status mapping, projection mapping, and
 * the brief's plain-language review surface.
 */

import { describe, expect, it } from "vitest";
import { money } from "@workspace/money";
import {
  CALL_RETRY_POLICY,
  billedMinutes,
  estimateCallCost,
  evaluateOutcome,
  formatBriefText,
  mapProviderStatus,
  reservationTypeForBrief,
  retryDecision,
  validateBriefCompleteness,
  type BriefAuthorityInput,
  type BriefCompletenessInput,
} from "./conciergeCallLogic";

function completenessInput(over: Partial<BriefCompletenessInput> = {}): BriefCompletenessInput {
  return {
    kind: "book",
    calleeName: "Le Comptoir",
    calleePhone: "+33 1 42 00 00 00",
    ask: "Book a table for 4",
    travelerNameOnReservation: "Philip Subhan",
    callbackNumber: "+1 555 0100",
    durationCapSeconds: 600,
    authorityKind: "spend",
    authorityLimit: money(20_000, "USD"),
    bookingId: null,
    reservationRefs: [],
    serviceDate: "2026-12-10",
    partySize: 4,
    ...over,
  };
}

function authority(over: Partial<BriefAuthorityInput> = {}): BriefAuthorityInput {
  return {
    kind: "book",
    authorityKind: "spend",
    authorityLimit: money(20_000, "USD"),
    ...over,
  };
}

describe("validateBriefCompleteness", () => {
  it("a complete spend brief has no problems", () => {
    expect(validateBriefCompleteness(completenessInput())).toEqual([]);
  });

  it("an empty brief is a wall of problems (no brief, no call)", () => {
    const problems = validateBriefCompleteness(
      completenessInput({
        calleeName: "",
        calleePhone: "",
        ask: "",
        travelerNameOnReservation: null,
        callbackNumber: null,
        authorityLimit: null,
        serviceDate: null,
        partySize: null,
      }),
    );
    expect(problems.length).toBeGreaterThanOrEqual(6);
    const joined = problems.join(" ");
    expect(joined).toMatch(/approved total cap/);
    expect(joined).toMatch(/traveler's name/);
    expect(joined).toMatch(/callback number/);
  });

  it("an information-only brief must not carry a cap — and an info-kind brief needs no cap, party, or date", () => {
    expect(
      validateBriefCompleteness(
        completenessInput({
          kind: "info",
          authorityKind: "info_only",
          authorityLimit: null,
          partySize: null,
          serviceDate: null,
        }),
      ),
    ).toEqual([]);
    const withCap = validateBriefCompleteness(
      completenessInput({ authorityKind: "info_only", authorityLimit: money(5_000, "USD") }),
    );
    expect(withCap.join(" ")).toMatch(/must not carry a spending cap/);
  });

  it("change and cancel briefs need an anchor booking or references", () => {
    expect(validateBriefCompleteness(completenessInput({ kind: "change" })).join(" ")).toMatch(
      /existing booking/,
    );
    expect(
      validateBriefCompleteness(completenessInput({ kind: "change", reservationRefs: ["ABC123"] })),
    ).toEqual([]);
    expect(validateBriefCompleteness(completenessInput({ kind: "cancel", bookingId: 9 }))).toEqual([]);
  });

  it("a special-request brief needs the reservation it concerns", () => {
    expect(
      validateBriefCompleteness(completenessInput({ kind: "special_request" })).join(" "),
    ).toMatch(/reference the reservation/);
    expect(
      validateBriefCompleteness(completenessInput({ kind: "special_request", bookingId: 9 })),
    ).toEqual([]);
  });

  it("a phone number with too few digits is not callable", () => {
    expect(validateBriefCompleteness(completenessInput({ calleePhone: "123" })).join(" ")).toMatch(
      /callable phone number/,
    );
  });

  it("a non-positive duration cap is a problem", () => {
    expect(
      validateBriefCompleteness(completenessInput({ durationCapSeconds: 0 })).join(" "),
    ).toMatch(/duration cap/);
  });
});

describe("call cost estimation (published rates, branded calling + AMD in every estimate)", () => {
  it("billed minutes round up, with a 1-minute floor for any real call", () => {
    expect(billedMinutes(0)).toBe(0);
    expect(billedMinutes(1)).toBe(1);
    expect(billedMinutes(60)).toBe(1);
    expect(billedMinutes(61)).toBe(2);
    expect(billedMinutes(480)).toBe(8);
  });

  it("an 8-minute call costs exactly $0.80 — the ROI model's brief-capped figure", () => {
    const cost = estimateCallCost(480);
    expect(cost.currency).toBe("USD");
    // 8 × (1.4¢ + 7¢) + 12¢ branded + 0.75¢ AMD = 79.95¢ → 80¢.
    expect(cost.amountMinor).toBe(80);
  });

  it("a zero-second call still carries the per-call fees (branded + AMD)", () => {
    // 12¢ + 0.75¢ = 12.75¢ → 13¢.
    expect(estimateCallCost(0).amountMinor).toBe(13);
  });

  it("a one-minute call: 8.4¢ + 12.75¢ of per-call fees → 21¢", () => {
    expect(estimateCallCost(60).amountMinor).toBe(21);
  });

  it("ten minutes: 84¢ + 12.75¢ → 97¢", () => {
    expect(estimateCallCost(600).amountMinor).toBe(97);
  });
});

describe("evaluateOutcome — the spending authority", () => {
  it("a booking within the cap books, carrying the agreed total", () => {
    const e = evaluateOutcome(authority(), {
      disposition: "booked",
      agreedAmountMinor: 18_000,
      agreedCurrency: "USD",
      confirmationCode: "XYZ",
    });
    expect(e.action).toBe("book");
    if (e.action === "book") expect(e.agreedTotal?.amountMinor).toBe(18_000);
  });

  it("a booking with no money discussed still books (no agreed total)", () => {
    const e = evaluateOutcome(authority(), { disposition: "booked" });
    expect(e.action).toBe("book");
    if (e.action === "book") expect(e.agreedTotal).toBeNull();
  });

  it("exactly at the cap books; one cent over never does", () => {
    expect(
      evaluateOutcome(authority(), {
        disposition: "booked",
        agreedAmountMinor: 20_000,
        agreedCurrency: "USD",
      }).action,
    ).toBe("book");
    expect(
      evaluateOutcome(authority(), {
        disposition: "booked",
        agreedAmountMinor: 20_001,
        agreedCurrency: "USD",
      }).action,
    ).toBe("over_cap");
  });

  it("an outcome above the cap NEVER books — it escalates with the offered price and the remedy", () => {
    const e = evaluateOutcome(authority(), {
      disposition: "booked",
      agreedAmountMinor: 25_000,
      agreedCurrency: "USD",
    });
    expect(e.action).toBe("over_cap");
    if (e.action === "over_cap") {
      expect(e.offeredTotal?.amountMinor).toBe(25_000);
      expect(e.reason).toContain("$250.00");
      expect(e.reason).toContain("$200.00");
      expect(e.reason).toMatch(/new brief and a fresh confirmation/);
    }
  });

  it("a total in a different currency than the cap fails closed as over-cap (never silently converted)", () => {
    const e = evaluateOutcome(authority(), {
      disposition: "booked",
      agreedAmountMinor: 100,
      agreedCurrency: "EUR",
    });
    expect(e.action).toBe("over_cap");
    if (e.action === "over_cap") expect(e.reason).toMatch(/can't be compared/);
  });

  it("an info-only brief's 'booked' claim is rejected, never booked", () => {
    const e = evaluateOutcome(authority({ authorityKind: "info_only", authorityLimit: null }), {
      disposition: "booked",
      agreedAmountMinor: 1_000,
      agreedCurrency: "USD",
    });
    expect(e.action).toBe("rejected_claim");
    if (e.action === "rejected_claim") expect(e.reason).toMatch(/information-only/);
  });

  it("info gathered on any brief books nothing", () => {
    expect(
      evaluateOutcome(authority(), { disposition: "info_gathered", infoGathered: "Open till 23:00" })
        .action,
    ).toBe("record_info");
    expect(
      evaluateOutcome(authority({ authorityKind: "info_only", authorityLimit: null }), {
        disposition: "info_gathered",
        infoGathered: "Kitchen closes at 22:00",
      }).action,
    ).toBe("record_info");
  });

  it("a booked claim against a change brief is rejected (kind mismatch)", () => {
    const e = evaluateOutcome(authority({ kind: "change" }), {
      disposition: "booked",
      agreedAmountMinor: 1_000,
      agreedCurrency: "USD",
    });
    expect(e.action).toBe("rejected_claim");
  });

  it("a change within its fee cap applies; above it escalates", () => {
    expect(
      evaluateOutcome(authority({ kind: "change" }), {
        disposition: "changed",
        agreedAmountMinor: 5_000,
        agreedCurrency: "USD",
      }).action,
    ).toBe("apply_change");
    expect(
      evaluateOutcome(authority({ kind: "change" }), {
        disposition: "changed",
        agreedAmountMinor: 50_000,
        agreedCurrency: "USD",
      }).action,
    ).toBe("over_cap");
  });

  it("a cancellation applies; a cancellation FEE above the cap escalates", () => {
    const applied = evaluateOutcome(authority({ kind: "cancel" }), {
      disposition: "cancelled",
      refundAmountMinor: 10_000,
      refundCurrency: "USD",
    });
    expect(applied.action).toBe("apply_cancel");
    if (applied.action === "apply_cancel") expect(applied.fee).toBeNull();
    expect(
      evaluateOutcome(authority({ kind: "cancel" }), {
        disposition: "cancelled",
        agreedAmountMinor: 99_999,
        agreedCurrency: "USD",
      }).action,
    ).toBe("over_cap");
  });

  it("special requests record their per-request outcome; a missing one fails the claim", () => {
    expect(
      evaluateOutcome(authority({ kind: "special_request" }), {
        disposition: "request_noted",
        requestOutcome: "noted_not_guaranteed",
      }).action,
    ).toBe("record_request");
    const bad = evaluateOutcome(authority({ kind: "special_request" }), {
      disposition: "request_noted",
    });
    expect(bad.action).toBe("failed");
    if (bad.action === "failed") expect(bad.retryable).toBe(false);
  });

  it("no-answer and voicemail fail retryable; refusal and ambiguity do not", () => {
    const na = evaluateOutcome(authority(), { disposition: "no_answer" });
    expect(na.action).toBe("failed");
    if (na.action === "failed") expect(na.retryable).toBe(true);
    const vm = evaluateOutcome(authority(), { disposition: "voicemail" });
    expect(vm.action).toBe("failed");
    if (vm.action === "failed") expect(vm.retryable).toBe(true);
    const refused = evaluateOutcome(authority(), { disposition: "refused_by_venue" });
    expect(refused.action).toBe("failed");
    if (refused.action === "failed") expect(refused.retryable).toBe(false);
    const amb = evaluateOutcome(authority(), { disposition: "ambiguous" });
    expect(amb.action).toBe("failed");
    if (amb.action === "failed") expect(amb.retryable).toBe(false);
  });
});

describe("retry policy (Story 4.5)", () => {
  it("attempts 1 and 2 retry with the stated spacing; attempt 3 escalates", () => {
    expect(retryDecision(1, true)).toEqual({ action: "retry", nextAttempt: 2, spacingMinutes: 30 });
    expect(retryDecision(2, true)).toEqual({ action: "retry", nextAttempt: 3, spacingMinutes: 240 });
    expect(retryDecision(3, true)).toEqual({ action: "escalate" });
    expect(CALL_RETRY_POLICY.maxAttempts).toBe(3);
    expect(CALL_RETRY_POLICY.spacingMinutes).toEqual([30, 240]);
  });

  it("a non-retryable failure escalates immediately at any attempt", () => {
    expect(retryDecision(1, false)).toEqual({ action: "escalate" });
  });
});

describe("provider status mapping", () => {
  it("maps Twilio statuses onto the seam's phases", () => {
    expect(mapProviderStatus("queued")).toBe("dialing");
    expect(mapProviderStatus("initiated")).toBe("dialing");
    expect(mapProviderStatus("ringing")).toBe("dialing");
    expect(mapProviderStatus("in-progress")).toBe("live");
    expect(mapProviderStatus("completed")).toBe("ended");
    expect(mapProviderStatus("no-answer")).toBe("no_answer");
    expect(mapProviderStatus("busy")).toBe("busy");
    expect(mapProviderStatus("failed")).toBe("failed");
    expect(mapProviderStatus("canceled")).toBe("failed");
    expect(mapProviderStatus("something-else")).toBe("failed");
  });
});

describe("reservation type mapping", () => {
  it("concierge categories land on the itinerary's reservation types", () => {
    expect(reservationTypeForBrief({ kind: "book", category: "spa" })).toBe("spa");
    expect(reservationTypeForBrief({ kind: "book", category: "massage" })).toBe("spa");
    expect(reservationTypeForBrief({ kind: "book", category: "private_tour" })).toBe("tour");
    expect(reservationTypeForBrief({ kind: "book", category: "skip_the_line" })).toBe("attraction");
    expect(reservationTypeForBrief({ kind: "book", category: "nightlife" })).toBe("event");
    expect(reservationTypeForBrief({ kind: "book", category: "adult_entertainment" })).toBe("event");
    expect(reservationTypeForBrief({ kind: "book", category: "transport" })).toBe("transport");
    expect(reservationTypeForBrief({ kind: "book", category: null })).toBe("restaurant");
    expect(reservationTypeForBrief({ kind: "info", category: null })).toBe("other");
  });
});

describe("formatBriefText — the confirmation surface", () => {
  const surface = {
    id: 7,
    version: 2,
    kind: "book" as const,
    state: "draft",
    calleeName: "Le Comptoir",
    calleePhone: "+33 1 42 00 00 00",
    ask: "Book a table for 4",
    travelerNameOnReservation: "Philip Subhan",
    partySize: 4,
    serviceDate: "2026-12-10",
    serviceTimeWindow: "19:00–20:30",
    fallbacks: ["The bar seats", "21:00 sitting"],
    mayNotAgree: ["No prix-fixe above the cap"],
    authorityKind: "spend" as const,
    authorityLimit: money(20_000, "USD"),
    durationCapSeconds: 600,
    callbackNumber: "+1 555 0100",
    visibility: "shared",
    category: null,
    reservationRefs: ["RES-1"],
  };

  it("states the ask, the fallbacks in order, the may-not list, and the cap", () => {
    const text = formatBriefText(surface);
    expect(text).toContain("Call brief #7 (v2)");
    expect(text).toContain("Ask: Book a table for 4");
    expect(text).toContain("Name on the reservation: Philip Subhan");
    expect(text).toContain("References: RES-1");
    expect(text).toContain("1. The bar seats");
    expect(text).toContain("2. 21:00 sitting");
    expect(text).toContain("May NOT agree to: No prix-fixe above the cap");
    expect(text).toContain("may commit up to $200.00");
    expect(text).toContain("not a cent more");
    expect(text).toContain("Duration cap: 10 minutes");
    expect(text).toContain("Callback: +1 555 0100");
    expect(text).toContain("Nothing has been called yet");
  });

  it("an info-only brief states it may commit NOTHING", () => {
    const text = formatBriefText({
      ...surface,
      id: 8,
      version: 1,
      kind: "info",
      ask: "Ask about opening hours",
      partySize: null,
      serviceDate: null,
      serviceTimeWindow: null,
      fallbacks: [],
      mayNotAgree: [],
      authorityKind: "info_only",
      authorityLimit: null,
      durationCapSeconds: 300,
      reservationRefs: [],
    });
    expect(text).toContain("information only");
    expect(text).toContain("may commit NOTHING");
  });

  it("a private brief says it won't be broadcast on the shared itinerary", () => {
    const text = formatBriefText({
      ...surface,
      id: 9,
      version: 1,
      calleeName: "Club Nuit",
      category: "nightlife",
      visibility: "private",
      authorityLimit: money(30_000, "USD"),
    });
    expect(text).toContain("Visibility: private");
    expect(text).toContain("won't be broadcast on the shared itinerary");
  });
});
