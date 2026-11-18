/**
 * Booking Gate — pure logic tests (architecture §5.2–§5.4).
 *
 * The state machine's legality table is asserted EXHAUSTIVELY (every
 * from×to pair): the confirmation discipline is only as strong as the
 * guarantee that no path reaches EXECUTING except through CONFIRMED.
 * Plus the conservative ConfirmationPolicy, why-this-option derivation
 * (fit inputs only), re-verification delta language, charge-currency
 * splits with remainder-to-organizer, the Duffel rail fee model, and
 * concierge-default-private visibility.
 */

import { describe, it, expect } from "vitest";
import { money } from "@workspace/money";
import type { BookingGateState } from "@workspace/db";
import {
  assertTransition,
  canTransition,
  computeBookingSplits,
  ConservativeSelfOnlyPolicy,
  defaultVisibility,
  deriveWhyThisOption,
  describePriceDelta,
  duffelRailFees,
  flightTerms,
  GATE_TRANSITIONS,
  GateTransitionError,
  type CoverageEntry,
} from "./bookingGateLogic";

const ALL_STATES: BookingGateState[] = [
  "presented",
  "reverifying",
  "review",
  "confirmed",
  "executing",
  "booked",
  "failed",
];

const LEGAL: Array<[BookingGateState, BookingGateState]> = [
  ["presented", "reverifying"],
  ["reverifying", "review"],
  ["reverifying", "presented"],
  ["reverifying", "failed"],
  ["review", "confirmed"],
  ["review", "presented"],
  ["confirmed", "executing"],
  ["confirmed", "review"],
  ["confirmed", "failed"],
  ["executing", "booked"],
  ["executing", "failed"],
];

describe("gate state machine — exhaustive legality", () => {
  it("allows exactly the designed transitions and refuses every other pair", () => {
    const legalSet = new Set(LEGAL.map(([a, b]) => `${a}->${b}`));
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        const expected = legalSet.has(`${from}->${to}`);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
        if (expected) {
          expect(() => assertTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertTransition(from, to)).toThrow(GateTransitionError);
        }
      }
    }
    // The table and the expectation list agree — no drift between them.
    const tableCount = Object.values(GATE_TRANSITIONS).reduce((n, tos) => n + tos.length, 0);
    expect(tableCount).toBe(LEGAL.length);
  });

  it("has no path to EXECUTING except from CONFIRMED, and no exit from terminal states", () => {
    for (const from of ALL_STATES) {
      if (from !== "confirmed") expect(canTransition(from, "executing")).toBe(false);
    }
    expect(GATE_TRANSITIONS.booked).toEqual([]);
    expect(GATE_TRANSITIONS.failed).toEqual([]);
  });
});

describe("ConservativeSelfOnlyPolicy (the shipped default, §5.3)", () => {
  const policy = new ConservativeSelfOnlyPolicy();
  const entry = (userId: number | null, confirmed = false): CoverageEntry => ({
    userId,
    rosterEntryId: null,
    isPayer: false,
    confirmedAt: confirmed ? new Date() : null,
  });

  it("allows a traveler to confirm an item covering only themselves", () => {
    const d = policy.evaluateConfirm({ coverage: [entry(7, true)], confirmerUserId: 7 });
    expect(d.allowed).toBe(true);
  });

  it("refuses a confirmer the item does not cover", () => {
    const d = policy.evaluateConfirm({ coverage: [entry(8, true)], confirmerUserId: 7 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/covers you/);
  });

  it("refuses shared items even when every covered traveler has confirmed their row", () => {
    const d = policy.evaluateConfirm({
      coverage: [entry(7, true), entry(8, true), entry(9, true)],
      confirmerUserId: 7,
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/Group confirmation is disabled/);
  });

  it("refuses a shared item the confirmer is not part of, with the not-covered reason first", () => {
    const d = policy.evaluateConfirm({ coverage: [entry(8), entry(9)], confirmerUserId: 7 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/covers you/);
  });
});

describe("deriveWhyThisOption — fit inputs only (§5.5)", () => {
  it("a valid hint wins", () => {
    const w = deriveWhyThisOption({ hint: "best_schedule", setSize: 5, fitReasons: [], label: "UA30" });
    expect(w.why).toBe("best_schedule");
    expect(w.text).toMatch(/fastest/);
  });

  it("an invalid hint is ignored, never stored", () => {
    const w = deriveWhyThisOption({ hint: "highest_commission", setSize: 5, fitReasons: [], label: "UA30" });
    expect(w.why).toBe("traveler_chose");
  });

  it("a one-option set is only_option", () => {
    expect(deriveWhyThisOption({ setSize: 1, label: "UA30" }).why).toBe("only_option");
  });

  it("cheapest/fastest fit reasons classify; otherwise the traveler chose", () => {
    expect(deriveWhyThisOption({ setSize: 3, fitReasons: ["Cheapest option that fits your rules"], label: "UA30" }).why).toBe("best_price");
    expect(deriveWhyThisOption({ setSize: 3, fitReasons: ["Fastest option"], label: "UA30" }).why).toBe("best_schedule");
    expect(deriveWhyThisOption({ setSize: 3, fitReasons: ["Window seat"], label: "UA30" }).why).toBe("traveler_chose");
  });
});

describe("describePriceDelta — drift in plain language", () => {
  it("price up names both totals and the increase", () => {
    const text = describePriceDelta(money(61200, "USD"), money(64000, "USD"), "UA30 Main Cabin");
    expect(text).toContain("$612.00");
    expect(text).toContain("$640.00");
    expect(text).toContain("+$28.00");
    expect(text).toMatch(/Nothing was booked/);
  });

  it("price down names both totals and the decrease", () => {
    const text = describePriceDelta(money(61200, "USD"), money(59000, "USD"), "UA30 Main Cabin");
    expect(text).toContain("DOWN");
    expect(text).toContain("−$22.00");
  });

  it("a currency change is stated as such, never converted silently", () => {
    const text = describePriceDelta(money(61200, "USD"), money(56304, "EUR"), "UA30 Main Cabin");
    expect(text).toMatch(/now quotes in EUR instead of USD/);
  });
});

describe("computeBookingSplits — charge currency, remainder to the first share", () => {
  it("splits equally with the remainder on the organizer's (first) share and sums exactly", () => {
    const shares = computeBookingSplits(money(10000, "USD"), 3);
    expect(shares.map((s) => s.amountMinor)).toEqual([3334, 3333, 3333]);
    expect(shares.reduce((n, s) => n + s.amountMinor, 0)).toBe(10000);
    expect(shares.every((s) => s.currency === "USD")).toBe(true);
  });

  it("a single traveler carries the whole total; zero travelers split nothing", () => {
    expect(computeBookingSplits(money(61200, "USD"), 1).map((s) => s.amountMinor)).toEqual([61200]);
    expect(computeBookingSplits(money(61200, "USD"), 0)).toEqual([]);
  });

  it("is exponent-aware (JPY has no minor subdivision)", () => {
    const shares = computeBookingSplits(money(15001, "JPY"), 2);
    expect(shares.reduce((n, s) => n + s.amountMinor, 0)).toBe(15001);
  });
});

describe("duffelRailFees — the ROI §1.2 model", () => {
  it("charges the $3.00 order fee + 1% Managed Content on the order value", () => {
    const fees = duffelRailFees(money(61200, "USD"));
    expect(fees).toEqual({
      railProvider: "duffel",
      orderFeeMinor: 300,
      pctFeeMinor: 612,
      feeCurrency: "USD",
    });
  });
});

describe("defaultVisibility — concierge items are private by default", () => {
  it("nightlife/spa/concierge categories default to private", () => {
    expect(defaultVisibility("nightlife")).toBe("private");
    expect(defaultVisibility("spa")).toBe("private");
    expect(defaultVisibility("concierge")).toBe("private");
  });

  it("ordinary and uncategorized items default to shared", () => {
    expect(defaultVisibility(null)).toBe("shared");
    expect(defaultVisibility(undefined)).toBe("shared");
    expect(defaultVisibility("flight")).toBe("shared");
  });
});

describe("flightTerms — plain language from the fare's own facts", () => {
  it("states changeable/refundable truthfully, and admits when unstated", () => {
    expect(flightTerms({ changeable: true, refundable: false }).changeTerms).toMatch(/allowed/);
    expect(flightTerms({ changeable: true, refundable: false }).cancelTerms).toMatch(/Non-refundable/);
    expect(flightTerms({}).changeTerms).toMatch(/weren't stated/);
    expect(flightTerms({ changeable: false }).changeTerms).toMatch(/does not allow/);
  });
});
