/**
 * Booking Gate — pure logic (architecture-north-star §5.2/§5.3/§5.4).
 *
 * Everything in this module is deterministic and I/O-free: the gate
 * state machine's transition table, the ConfirmationPolicy seam with
 * its shipped conservative default, the why-this-option derivation,
 * re-verification delta language, booking split computation, and the
 * Duffel rail fee model from the ROI doc. The service
 * (bookingGate.ts) wires these to the DB and the provider; the model
 * never touches any of it directly.
 */

import { createHash } from "node:crypto";
import { formatMoney, money, splitEqually, type Money } from "@workspace/money";
import type {
  BookingGateState,
  BookingVisibility,
  WhyThisOption,
} from "@workspace/db";

// ─── The state machine (§5.2) ────────────────────────────────────────────────

/**
 * The ONLY legal transitions. Every state change in the gate goes
 * through `assertTransition` — there is no code path that sets a state
 * ad hoc, and no path from any state to EXECUTING except CONFIRMED.
 */
export const GATE_TRANSITIONS: Record<BookingGateState, readonly BookingGateState[]> = {
  presented: ["reverifying"],
  reverifying: ["review", "presented", "failed"],
  review: ["confirmed", "presented"],
  confirmed: ["executing", "review", "failed"],
  executing: ["booked", "failed"],
  booked: [],
  failed: [],
};

export class GateTransitionError extends Error {
  constructor(
    readonly from: BookingGateState,
    readonly to: BookingGateState,
  ) {
    super(`Illegal booking-gate transition: ${from} → ${to}.`);
    this.name = "GateTransitionError";
  }
}

export function canTransition(from: BookingGateState, to: BookingGateState): boolean {
  return GATE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: BookingGateState, to: BookingGateState): void {
  if (!canTransition(from, to)) throw new GateTransitionError(from, to);
}

// ─── ConfirmationPolicy (§5.3 — the seam, not the decision) ──────────────────

export interface CoverageEntry {
  userId: number | null;
  rosterEntryId: number | null;
  isPayer: boolean;
  confirmedAt: Date | null;
}

export interface PolicyDecision {
  allowed: boolean;
  /** Plain-language reason — always stated when not allowed. */
  reason: string;
}

/**
 * Consulted at the REVIEW → CONFIRMED transition. Phil's group
 * approval + payment model is Packet #1 [OPEN]; until it lands, the
 * gate ships the conservative implementation below and the decision,
 * when it comes, is configuration — the seam (this interface + the
 * coverage rows + per-traveler confirmation tracking) is already built.
 */
export interface ConfirmationPolicy {
  readonly mode: string;
  /**
   * May this attempt leave REVIEW for CONFIRMED, given its coverage
   * and who is confirming? `coverage` reflects any confirmation the
   * caller just recorded for the confirmer's own row.
   */
  evaluateConfirm(input: { coverage: readonly CoverageEntry[]; confirmerUserId: number }): PolicyDecision;
}

/**
 * The shipped conservative default (§5.3): a traveler can confirm only
 * an item that covers THEMSELVES ALONE. Shared-item confirmation is
 * disabled — a multi-traveler attempt cannot leave REVIEW under this
 * policy, no matter how many covered travelers have individually
 * confirmed their rows (those confirmations are still tracked and
 * visible; they just don't unlock execution yet).
 */
export class ConservativeSelfOnlyPolicy implements ConfirmationPolicy {
  readonly mode = "conservative_self_only";

  evaluateConfirm(input: { coverage: readonly CoverageEntry[]; confirmerUserId: number }): PolicyDecision {
    const { coverage, confirmerUserId } = input;
    const own = coverage.filter((c) => c.userId === confirmerUserId);
    if (own.length === 0) {
      return {
        allowed: false,
        reason: "You can only confirm a booking that covers you — this one doesn't include you.",
      };
    }
    if (coverage.length > 1) {
      return {
        allowed: false,
        reason:
          "This booking covers more than one traveler. Group confirmation is disabled until the " +
          "group booking policy is decided, so it can't be confirmed yet — your own confirmation " +
          "is recorded and visible.",
      };
    }
    return { allowed: true, reason: "Confirmed — the booking covers only you." };
  }
}

// ─── Why this option (§5.4/§5.5 — fit inputs only) ───────────────────────────

export interface WhyDerivation {
  why: WhyThisOption;
  text: string;
}

/**
 * Derive the why-this-option classification from the presented set's
 * fit facts — never from partner/commission data (§5.5: those are
 * absent from ranking inputs, so they are absent here too). An
 * explicit traveler-facing hint (Marco saw the voiced reasons) wins
 * when it is a valid enum value; otherwise the set position decides.
 */
export function deriveWhyThisOption(input: {
  hint?: string | null;
  setSize?: number;
  fitReasons?: readonly string[];
  label: string;
}): WhyDerivation {
  const reasons = input.fitReasons ?? [];
  const hintValid =
    input.hint === "best_price" ||
    input.hint === "best_schedule" ||
    input.hint === "only_option" ||
    input.hint === "traveler_chose";
  let why: WhyThisOption;
  if (hintValid) why = input.hint as WhyThisOption;
  else if (input.setSize === 1) why = "only_option";
  else if (reasons.some((r) => /cheapest/i.test(r))) why = "best_price";
  else if (reasons.some((r) => /fastest/i.test(r))) why = "best_schedule";
  else why = "traveler_chose";
  const text =
    why === "only_option"
      ? `${input.label} was the only option that fit your rules.`
      : why === "best_price"
        ? `${input.label} was the cheapest option that fit your rules.`
        : why === "best_schedule"
          ? `${input.label} was the fastest option that fit your rules.`
          : `You picked ${input.label} from the options that fit your rules.`;
  return { why, text };
}

/** Reproducibility hash over the ranking inputs (§5.4). */
export function rankingInputsHash(parts: {
  optionId: string;
  pricedAt: string;
  amountMinor: number;
  currency: string;
  fitReasons?: readonly string[];
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        optionId: parts.optionId,
        pricedAt: parts.pricedAt,
        amountMinor: parts.amountMinor,
        currency: parts.currency,
        fitReasons: parts.fitReasons ?? [],
      }),
    )
    .digest("hex");
}

// ─── Re-verification deltas (§5.2 — drift is re-presented, never absorbed) ───

export type RequoteOutcome =
  | { outcome: "same"; amountMinor: number; currency: string }
  | { outcome: "changed"; amountMinor: number; currency: string; deltaText: string }
  | { outcome: "unavailable"; reason: string };

/** Plain-language price-drift statement for the re-presentation. */
export function describePriceDelta(
  presented: Money,
  current: Money,
  label: string,
): string {
  const fmt = (m: Money) => formatMoney(m, "en-US");
  if (current.currency !== presented.currency) {
    return (
      `${label}: the supplier now quotes in ${current.currency} instead of ${presented.currency} ` +
      `(${fmt(current)}). The total you reviewed is no longer available — review the new total before confirming.`
    );
  }
  const diff = current.amountMinor - presented.amountMinor;
  const diffMoney = money(Math.abs(diff), presented.currency);
  return diff > 0
    ? `${label}: the price went UP from ${fmt(presented)} to ${fmt(current)} (+${fmt(diffMoney)}) since it was shown. Nothing was booked — review the new total before confirming.`
    : `${label}: the price went DOWN from ${fmt(presented)} to ${fmt(current)} (−${fmt(diffMoney)}) since it was shown. Review the new total before confirming.`;
}

// ─── Terms (plain language, from the option's own facts) ─────────────────────

export function flightTerms(input: {
  changeable?: boolean;
  refundable?: boolean;
}): { changeTerms: string; cancelTerms: string } {
  return {
    changeTerms:
      input.changeable === true
        ? "Changes are allowed by the fare rules (any fare difference still applies)."
        : input.changeable === false
          ? "This fare does not allow changes."
          : "Change rules weren't stated by the supplier at search time.",
    cancelTerms:
      input.refundable === true
        ? "Refundable before departure under the fare rules."
        : input.refundable === false
          ? "Non-refundable — cancelling forfeits the fare."
          : "Refund rules weren't stated by the supplier at search time.",
  };
}

// ─── Splits (§5.4 — charge currency, remainder to the organizer) ─────────────

export interface SplitShare {
  index: number;
  share: Money;
}

/**
 * Equal split of a booking total across its covered travelers, in the
 * CHARGE currency. The money package's splitEqually puts the rounding
 * remainder on the FIRST share — callers order coverage with the
 * organizer first, which is exactly §5.4's remainder-to-organizer rule.
 * Display conversions share the booking's one FX snapshot and never
 * re-split in another currency.
 */
export function computeBookingSplits(total: Money, travelerCount: number): Money[] {
  if (travelerCount <= 0) return [];
  return splitEqually(total, travelerCount);
}

// ─── Rail economics (ROI §1.2 — cost attribution written at BOOKED) ──────────

/**
 * Duffel's published per-order economics (api-ecosystem-map [V]):
 * $3.00 per confirmed order + 1% of order value on Managed Content
 * (+ $2.00 per PAID ancillary — no ancillaries in this build, so the
 * ancillary term is 0 and named as such). Fees are USD-denominated in
 * Duffel's pricing; the percentage fee is computed on the order value
 * and recorded in the fee currency without converting the charge.
 * [Flagged in the ROI doc: one Duffel surface says 0.5% for Managed
 * Content vs 1% on the pricing page — confirm in the partner account;
 * the constant lives here so that confirmation is a one-line change.]
 */
export const DUFFEL_ORDER_FEE_MINOR = 300; // $3.00
export const DUFFEL_MANAGED_CONTENT_BPS = 100; // 1%
export const DUFFEL_FEE_CURRENCY = "USD";

export interface RailFeeBreakdown {
  railProvider: string;
  orderFeeMinor: number;
  pctFeeMinor: number;
  feeCurrency: string;
}

export function duffelRailFees(charge: Money): RailFeeBreakdown {
  const pctFeeMinor = Math.floor((charge.amountMinor * DUFFEL_MANAGED_CONTENT_BPS) / 10000);
  return {
    railProvider: "duffel",
    orderFeeMinor: DUFFEL_ORDER_FEE_MINOR,
    pctFeeMinor,
    feeCurrency: DUFFEL_FEE_CURRENCY,
  };
}

// ─── Visibility (§5.4 + QA flag — concierge items are private by default) ────

/** Concierge categories whose items never broadcast to a shared itinerary. */
export const CONCIERGE_CATEGORIES: ReadonlySet<string> = new Set([
  "nightlife",
  "adult_entertainment",
  "massage",
  "spa",
  "private_tour",
  "skip_the_line",
  "concierge",
]);

export function defaultVisibility(category: string | null | undefined): BookingVisibility {
  return category && CONCIERGE_CATEGORIES.has(category) ? "private" : "shared";
}
