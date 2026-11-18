/**
 * Concierge-Call Service — pure logic (architecture-north-star §6.5;
 * Stories 4.1–4.5).
 *
 * Everything here is deterministic and I/O-free: brief completeness
 * (no brief, no call), the telephony cost model, the outcome
 * evaluator that decides whether a call's reported outcome may write
 * to the Booking Ledger, the retry pattern, and the plain-language
 * brief/outcome surfaces. The service (conciergeCalls.ts) wires these
 * to the DB and the telephony provider; the model never touches any
 * of it directly.
 *
 * The evaluator is the safety core: a call outcome is a CLAIM by the
 * call driver about what a venue said, and it is checked against the
 * brief's authority before anything is booked —
 *   · a total above the brief's cap NEVER books (the venue's price is
 *     surfaced; accepting it needs a NEW brief + confirmation);
 *   · an info-only brief can never produce a booking, whatever the
 *     outcome claims;
 *   · a confirmation code is carried verbatim, and its absence is
 *     recorded as absence — never filled in.
 */

import { formatMoney, money, type Money } from "@workspace/money";
import type {
  CallBriefKind,
  CallOutcome,
} from "@workspace/db";

// ─── Telephony cost model (api-ecosystem-map §10 [V]; ROI §2) ────────────────

/**
 * Published Twilio rates for the White Glove call shape: outbound
 * voice $0.014/min + ConversationRelay $0.07/min (managed STT/TTS for
 * the agent) + Branded Calling $0.12/call + answering-machine
 * detection $0.0075/call. At the brief-capped ~8 minutes this lands
 * at ≈ $0.80/call — the ROI model's planning figure. Computed in
 * micro-dollars so the fractional cents stay exact until one final
 * rounding to minor units.
 */
export const TWILIO_OUTBOUND_PER_MIN_MICRO_USD = 14_000; // $0.014
export const CONVERSATION_RELAY_PER_MIN_MICRO_USD = 70_000; // $0.07
export const BRANDED_CALLING_PER_CALL_MICRO_USD = 120_000; // $0.12
export const AMD_PER_CALL_MICRO_USD = 7_500; // $0.0075
export const TELEPHONY_COST_CURRENCY = "USD";

/** Billed minutes: Twilio bills whole minutes, rounded up. */
export function billedMinutes(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return Math.max(1, Math.ceil(durationSeconds / 60));
}

/**
 * The per-call telephony cost estimate recorded on the task (ROI §7
 * attribution: call_minutes + telephony_cost per call record).
 */
export function estimateCallCost(durationSeconds: number): Money {
  const minutes = billedMinutes(durationSeconds);
  const perMinute = TWILIO_OUTBOUND_PER_MIN_MICRO_USD + CONVERSATION_RELAY_PER_MIN_MICRO_USD;
  const micro =
    minutes * perMinute + BRANDED_CALLING_PER_CALL_MICRO_USD + AMD_PER_CALL_MICRO_USD;
  // Micro-dollars → cents, half-up.
  return money(Math.round(micro / 10_000), TELEPHONY_COST_CURRENCY);
}

// ─── Brief completeness — no brief, no call (Story 4.1) ──────────────────────

export interface BriefCompletenessInput {
  kind: CallBriefKind;
  calleeName: string;
  calleePhone: string;
  ask: string;
  travelerNameOnReservation: string | null;
  callbackNumber: string | null;
  durationCapSeconds: number;
  authorityKind: "spend" | "info_only";
  authorityLimit: Money | null;
  bookingId: number | null;
  reservationRefs: readonly string[];
  serviceDate: string | null;
  partySize: number | null;
}

function phoneDigits(phone: string): number {
  return (phone.match(/\d/g) ?? []).length;
}

/**
 * The fields a brief must carry before ANY call may be placed against
 * it (Story 4.1's acceptance list, made executable). Returns problem
 * strings — an empty list means the brief is complete. The service
 * refuses to dial while this is non-empty.
 */
export function validateBriefCompleteness(brief: BriefCompletenessInput): string[] {
  const problems: string[] = [];
  if (!brief.calleeName.trim()) problems.push("the brief doesn't name who is being called");
  if (!brief.calleePhone.trim() || phoneDigits(brief.calleePhone) < 7) {
    problems.push("the brief doesn't carry a callable phone number for the venue");
  }
  if (!brief.ask.trim()) problems.push("the brief doesn't state the specific ask");
  if (!brief.travelerNameOnReservation?.trim()) {
    problems.push("the brief doesn't carry the traveler's name as it appears on the reservation");
  }
  if (!brief.callbackNumber?.trim()) {
    problems.push("the brief doesn't carry a callback number");
  }
  if (!Number.isFinite(brief.durationCapSeconds) || brief.durationCapSeconds <= 0) {
    problems.push("the brief doesn't carry a positive duration cap");
  }
  if (brief.authorityKind === "spend") {
    if (!brief.authorityLimit) {
      problems.push("a spend brief must carry its approved total cap");
    } else if (brief.authorityLimit.amountMinor <= 0) {
      problems.push("the brief's approved total cap must be positive");
    }
  } else if (brief.authorityLimit) {
    problems.push("an information-only brief must not carry a spending cap — it authorizes no spend");
  }
  if ((brief.kind === "change" || brief.kind === "cancel") && !brief.bookingId && brief.reservationRefs.length === 0) {
    problems.push("a change/cancel brief must reference the existing booking or its confirmation numbers");
  }
  if (brief.kind === "book") {
    if (!brief.serviceDate) problems.push("a booking brief must state the service date");
    if (!brief.partySize || brief.partySize <= 0) {
      problems.push("a booking brief must state the party size");
    }
  }
  if (brief.kind === "special_request" && !brief.bookingId && brief.reservationRefs.length === 0) {
    problems.push("a special-request brief must reference the reservation it concerns");
  }
  return problems;
}

// ─── The outcome evaluator — claims checked against authority ────────────────

export interface BriefAuthorityInput {
  kind: CallBriefKind;
  authorityKind: "spend" | "info_only";
  authorityLimit: Money | null;
}

export type OutcomeEvaluation =
  | { action: "book"; agreedTotal: Money | null }
  | { action: "apply_change"; agreedTotal: Money | null }
  | { action: "apply_cancel"; fee: Money | null }
  | { action: "record_request" }
  | { action: "record_info" }
  | { action: "rejected_claim"; reason: string }
  | { action: "over_cap"; offeredTotal: Money | null; reason: string }
  | { action: "failed"; reason: string; retryable: boolean };

function outcomeTotal(outcome: CallOutcome): Money | null {
  if (outcome.agreedAmountMinor == null || !outcome.agreedCurrency) return null;
  return money(outcome.agreedAmountMinor, outcome.agreedCurrency);
}

/**
 * Cap check shared by book/change/cancel-fee outcomes. A total in a
 * DIFFERENT currency than the cap cannot be verified against it —
 * that is an over-cap outcome (surface it; a new brief decides), not
 * a silent conversion.
 */
function checkAgainstCap(
  brief: BriefAuthorityInput,
  total: Money | null,
  what: string,
): OutcomeEvaluation | null {
  if (!total) return null;
  const cap = brief.authorityLimit;
  if (!cap) return null; // spend briefs always carry a cap (completeness); defensive
  if (total.currency !== cap.currency) {
    return {
      action: "over_cap",
      offeredTotal: total,
      reason:
        `The venue quoted the ${what} in ${total.currency} (${formatMoney(total, "en-US")}), ` +
        `but the approved cap is in ${cap.currency} — the two can't be compared, so nothing was committed. ` +
        `Approving it needs a new brief in the venue's currency.`,
    };
  }
  if (total.amountMinor > cap.amountMinor) {
    return {
      action: "over_cap",
      offeredTotal: total,
      reason:
        `The venue's ${what} of ${formatMoney(total, "en-US")} is above the approved cap of ` +
        `${formatMoney(cap, "en-US")}, so the agent did not commit. Approving the higher price ` +
        `needs a new brief and a fresh confirmation.`,
    };
  }
  return null;
}

const COMMIT_DISPOSITIONS = new Set(["booked", "changed", "cancelled"]);

export function evaluateOutcome(
  brief: BriefAuthorityInput,
  outcome: CallOutcome,
): OutcomeEvaluation {
  const d = outcome.disposition;

  // Non-commitment endings first — they never write to the ledger.
  if (d === "no_answer") return { action: "failed", reason: "No answer.", retryable: true };
  if (d === "voicemail") {
    return { action: "failed", reason: "Reached voicemail; a message was left where the venue accepts them.", retryable: true };
  }
  if (d === "refused_by_venue") {
    return { action: "failed", reason: "The venue refused the request.", retryable: false };
  }
  if (d === "ambiguous") {
    return {
      action: "failed",
      reason: "The call's outcome was ambiguous — nothing was committed, and a person should decide the next step.",
      retryable: false,
    };
  }

  // Information outcomes book nothing, on any brief.
  if (d === "info_gathered") return { action: "record_info" };

  // An info-only brief authorizes NO commitment: a claim that it
  // booked/changed/cancelled anything is rejected outright — the call
  // was placed to gather information, and its outcome is recorded as
  // information, never as a booking (Story 4.2's discipline, enforced
  // at the ledger's door).
  if (brief.authorityKind === "info_only") {
    if (COMMIT_DISPOSITIONS.has(d) || d === "request_noted") {
      return {
        action: "rejected_claim",
        reason:
          "The call reported a commitment, but the brief was information-only and authorized no " +
          "commitment — nothing was booked or changed. If the venue believes it took a booking, " +
          "that needs a person's attention.",
      };
    }
    return { action: "record_info" };
  }

  // Spend briefs: the disposition must match what the brief was for.
  if (d === "booked") {
    if (brief.kind !== "book") {
      return {
        action: "rejected_claim",
        reason: `The call reported a new booking, but the brief was a ${brief.kind} brief — the claim doesn't match the authorization, so nothing was written to the ledger.`,
      };
    }
    const total = outcomeTotal(outcome);
    const over = checkAgainstCap(brief, total, "total");
    if (over) return over;
    return { action: "book", agreedTotal: total };
  }
  if (d === "changed") {
    if (brief.kind !== "change") {
      return {
        action: "rejected_claim",
        reason: `The call reported a change, but the brief was a ${brief.kind} brief — the claim doesn't match the authorization, so nothing was written to the ledger.`,
      };
    }
    const total = outcomeTotal(outcome);
    const over = checkAgainstCap(brief, total, "change fee/difference");
    if (over) return over;
    return { action: "apply_change", agreedTotal: total };
  }
  if (d === "cancelled") {
    if (brief.kind !== "cancel" && brief.kind !== "change") {
      return {
        action: "rejected_claim",
        reason: `The call reported a cancellation, but the brief was a ${brief.kind} brief — the claim doesn't match the authorization, so nothing was written to the ledger.`,
      };
    }
    // A cancellation can itself carry a fee; the fee is a commitment
    // and is cap-checked like any other total.
    const fee = outcomeTotal(outcome);
    const over = checkAgainstCap(brief, fee, "cancellation fee");
    if (over) return over;
    return { action: "apply_cancel", fee };
  }
  if (d === "request_noted") {
    if (brief.kind !== "special_request") {
      return {
        action: "rejected_claim",
        reason: `The call reported a special-request outcome, but the brief was a ${brief.kind} brief — nothing was recorded against the ledger.`,
      };
    }
    if (!outcome.requestOutcome) {
      return {
        action: "failed",
        reason: "The outcome report didn't say whether the request was granted, denied, or noted — nothing was recorded as settled.",
        retryable: false,
      };
    }
    return { action: "record_request" };
  }
  return { action: "record_info" };
}

// ─── Retry pattern (Story 4.5 — stated attempts, then escalation) ────────────

/**
 * The stated attempt pattern: up to 3 attempts per brief, spaced
 * 30 minutes then 4 hours, then the task escalates to the traveler
 * with a proposed next step instead of retrying forever. (Attempt
 * counts are configuration per architecture §6.5; the pattern is
 * Phil's open question 4 — these defaults are the shipped starting
 * point, in one place.)
 */
export const CALL_RETRY_POLICY = {
  maxAttempts: 3,
  /** Wait before attempt N+1, indexed by the attempt that just failed. */
  spacingMinutes: [30, 240] as readonly number[],
} as const;

export type RetryDecision =
  | { action: "retry"; nextAttempt: number; spacingMinutes: number }
  | { action: "escalate" };

export function retryDecision(attemptNumber: number, retryable: boolean): RetryDecision {
  if (!retryable || attemptNumber >= CALL_RETRY_POLICY.maxAttempts) return { action: "escalate" };
  return {
    action: "retry",
    nextAttempt: attemptNumber + 1,
    spacingMinutes: CALL_RETRY_POLICY.spacingMinutes[attemptNumber - 1] ?? 240,
  };
}

// ─── Provider status mapping (Twilio call statuses) ──────────────────────────

export type ProviderCallPhase = "dialing" | "live" | "ended" | "no_answer" | "busy" | "failed";

export function mapProviderStatus(status: string): ProviderCallPhase {
  switch (status) {
    case "queued":
    case "initiated":
    case "ringing":
      return "dialing";
    case "in-progress":
      return "live";
    case "completed":
      return "ended";
    case "no-answer":
      return "no_answer";
    case "busy":
      return "busy";
    default:
      return "failed"; // "failed", "canceled", anything unrecognized
  }
}

// ─── Projection mapping ──────────────────────────────────────────────────────

/** Reservations-table type for a phone-booked item, from its category. */
export function reservationTypeForBrief(input: {
  kind: CallBriefKind;
  category: string | null;
}): "restaurant" | "attraction" | "tour" | "transport" | "event" | "spa" | "other" {
  switch (input.category) {
    case "spa":
    case "massage":
      return "spa";
    case "private_tour":
      return "tour";
    case "skip_the_line":
      return "attraction";
    case "nightlife":
    case "adult_entertainment":
      return "event";
    case "transport":
      return "transport";
    case "restaurant":
      return "restaurant";
    default:
      return input.kind === "book" ? "restaurant" : "other";
  }
}

// ─── Plain-language surfaces (the brief card + the outcome report) ──────────

export interface BriefSurfaceInput {
  id: number;
  version: number;
  kind: CallBriefKind;
  state: string;
  calleeName: string;
  calleePhone: string;
  ask: string;
  travelerNameOnReservation: string | null;
  partySize: number | null;
  serviceDate: string | null;
  serviceTimeWindow: string | null;
  fallbacks: readonly string[];
  mayNotAgree: readonly string[];
  authorityKind: "spend" | "info_only";
  authorityLimit: Money | null;
  durationCapSeconds: number;
  callbackNumber: string | null;
  visibility: string;
  category: string | null;
  reservationRefs: readonly string[];
}

/** The brief as the traveler reviews it before confirming (Story 4.1). */
export function formatBriefText(brief: BriefSurfaceInput): string {
  const lines: string[] = [];
  lines.push(`Call brief #${brief.id} (v${brief.version}) — ${brief.kind.replace("_", " ")} call to ${brief.calleeName} (${brief.calleePhone}):`);
  lines.push(`   Ask: ${brief.ask}`);
  if (brief.travelerNameOnReservation) {
    lines.push(`   Name on the reservation: ${brief.travelerNameOnReservation}`);
  }
  if (brief.reservationRefs.length > 0) {
    lines.push(`   References: ${brief.reservationRefs.join(", ")}`);
  }
  if (brief.partySize) lines.push(`   Party: ${brief.partySize}`);
  if (brief.serviceDate) {
    lines.push(`   Date: ${brief.serviceDate}${brief.serviceTimeWindow ? `, ${brief.serviceTimeWindow}` : ""}`);
  } else if (brief.serviceTimeWindow) {
    lines.push(`   Time: ${brief.serviceTimeWindow}`);
  }
  if (brief.fallbacks.length > 0) {
    lines.push(`   Fallbacks, in order: ${brief.fallbacks.map((f, i) => `${i + 1}. ${f}`).join("  ")}`);
  }
  if (brief.mayNotAgree.length > 0) {
    lines.push(`   May NOT agree to: ${brief.mayNotAgree.join("; ")}`);
  }
  if (brief.authorityKind === "info_only") {
    lines.push("   Authority: information only — this call may commit NOTHING.");
  } else if (brief.authorityLimit) {
    lines.push(
      `   Authority: may commit up to ${formatMoney(brief.authorityLimit, "en-US")} — not a cent more. Anything above that comes back to you.`,
    );
  }
  lines.push(`   Duration cap: ${Math.round(brief.durationCapSeconds / 60)} minutes.`);
  if (brief.callbackNumber) lines.push(`   Callback: ${brief.callbackNumber}`);
  if (brief.visibility === "private") {
    lines.push("   Visibility: private — this won't be broadcast on the shared itinerary.");
  }
  if (brief.state === "draft") {
    lines.push("");
    lines.push("Nothing has been called yet. Confirm this brief and the call can be placed.");
  }
  return lines.join("\n");
}
