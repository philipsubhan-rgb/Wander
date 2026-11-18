/**
 * Intake state machine — pure-logic unit tests (architecture §2, ADR-2).
 *
 * Covers: state transitions in the guided order, the one-next-ask rule,
 * skip semantics (a skip marks open, never blocks), slot provenance,
 * corrections as writes from any state (never a restart), Family Budget's
 * budget-cap sub-ask, and the materialization gate (no exact dates → no
 * fake trip). No DB, no model: the machine is pure.
 */

import { describe, it, expect } from "vitest";
import {
  emptyIntakeData,
  markIntent,
  deriveState,
  nextAsk,
  applySlotWrite,
  applySkip,
  buildReviewSummary,
  buildMaterializationPlan,
  partyEmailOpenItem,
  IntakeValidationError,
  type IntakeData,
} from "./intakeLogic.js";

function withIntent(): IntakeData {
  return markIntent(emptyIntakeData());
}

function munichIntent(): IntakeData {
  // The founder's defining case: destination arrives INSIDE the intent
  // ("I want to plan 5 days in Munich") — provenance `stated`.
  return applySlotWrite(withIntent(), {
    slot: "destination",
    value: { kind: "place", text: "Munich" },
    provenance: "stated",
  });
}

function fullIntake(): IntakeData {
  let d = munichIntent();
  d = applySlotWrite(d, {
    slot: "party",
    value: {
      solo: false,
      travelers: [
        { name: "Kurt", email: "kurt@example.com" },
        { name: "Pradip", email: "pradip@example.com" },
      ],
    },
    provenance: "asked",
  });
  d = applySlotWrite(d, {
    slot: "dates",
    value: { startDate: "2026-09-24", endDate: "2026-09-28" },
    provenance: "asked",
  });
  d = applySlotWrite(d, {
    slot: "style",
    value: { text: "guys' trip — Oktoberfest", tier: "premium" },
    provenance: "asked",
  });
  return d;
}

describe("opening", () => {
  it("a fresh session is OPENING and the next ask is the opening question", () => {
    const d = emptyIntakeData();
    expect(deriveState(d, null)).toBe("OPENING");
    const ask = nextAsk(d, null);
    expect(ask?.question).toBe("Ok, where are we going?");
    expect(ask?.slot).toBe("destination");
  });

  it("intent alone advances to DESTINATION with the same opening question", () => {
    const d = withIntent();
    expect(deriveState(d, null)).toBe("DESTINATION");
    expect(nextAsk(d, null)?.question).toBe("Ok, where are we going?");
  });
});

describe("guided sequence (Stories 1.2/1.3)", () => {
  it("a destination stated in the intent is not re-asked — next ask is who's going", () => {
    const d = munichIntent();
    expect(deriveState(d, null)).toBe("PARTY");
    const ask = nextAsk(d, null);
    expect(ask?.slot).toBe("party");
    expect(ask?.question).toContain("Who's going?");
    // Provenance survives: the destination was volunteered, not asked.
    expect(d.destination?.provenance).toBe("stated");
  });

  it("walks the full order destination → party → dates → style → review, one ask at a time", () => {
    let d = withIntent();
    expect(nextAsk(d, null)?.slot).toBe("destination");
    d = applySlotWrite(d, { slot: "destination", value: { kind: "place", text: "Lisbon" }, provenance: "asked" });
    expect(deriveState(d, null)).toBe("PARTY");
    expect(nextAsk(d, null)?.slot).toBe("party");
    d = applySlotWrite(d, { slot: "party", value: { solo: true, travelers: [] }, provenance: "asked" });
    expect(deriveState(d, null)).toBe("DATES");
    expect(nextAsk(d, null)?.slot).toBe("dates");
    d = applySlotWrite(d, { slot: "dates", value: { startDate: "2027-03-03", endDate: "2027-03-07" }, provenance: "asked" });
    expect(deriveState(d, null)).toBe("STYLE");
    expect(nextAsk(d, null)?.slot).toBe("style");
    d = applySlotWrite(d, { slot: "style", value: { text: "solo recharge" }, provenance: "asked" });
    expect(deriveState(d, null)).toBe("REVIEW");
    expect(nextAsk(d, null)?.slot).toBe("review");
  });

  it("a vibe or 'don't know' destination advances instead of erroring (Story 1.2)", () => {
    let d = withIntent();
    d = applySlotWrite(d, { slot: "destination", value: { kind: "vibe", text: "somewhere warm" }, provenance: "asked" });
    expect(deriveState(d, null)).toBe("PARTY");
    d = applySlotWrite(withIntent(), {
      slot: "destination",
      value: { kind: "unknown", text: "I don't know yet" },
      provenance: "asked",
    });
    expect(deriveState(d, null)).toBe("PARTY");
  });

  it("skipping dates marks them open and advances to style (Story 1.3)", () => {
    let d = munichIntent();
    d = applySlotWrite(d, { slot: "party", value: { solo: true, travelers: [] }, provenance: "asked" });
    d = applySkip(d, "dates");
    expect(d.openItems).toContain("dates");
    expect(deriveState(d, null)).toBe("STYLE");
    // …and the review summary lists the skip as open, not as a date.
    d = applySlotWrite(d, { slot: "style", value: { text: "food trip" }, provenance: "asked" });
    expect(deriveState(d, null)).toBe("REVIEW");
    const summary = buildReviewSummary(d).join("\n");
    expect(summary).toContain("Dates: not decided yet (open)");
    expect(summary).toContain("Still open: dates");
  });

  it("writing a previously skipped slot clears the skip", () => {
    let d = munichIntent();
    d = applySlotWrite(d, { slot: "party", value: { solo: true, travelers: [] }, provenance: "asked" });
    d = applySkip(d, "dates");
    d = applySlotWrite(d, {
      slot: "dates",
      value: { startDate: "2027-01-10", endDate: "2027-01-12" },
      provenance: "asked",
    });
    expect(d.openItems).not.toContain("dates");
    expect(deriveState(d, null)).toBe("STYLE");
  });
});

describe("party capture (Story 3.1)", () => {
  it("a named traveler without an email keeps PARTY open, asking for that email", () => {
    let d = munichIntent();
    d = applySlotWrite(d, {
      slot: "party",
      value: { solo: false, travelers: [{ name: "Kurt", email: "kurt@example.com" }, { name: "Manish" }] },
      provenance: "asked",
    });
    expect(deriveState(d, null)).toBe("PARTY");
    const ask = nextAsk(d, null);
    expect(ask?.key).toBe(partyEmailOpenItem("Manish"));
    expect(ask?.question).toBe("What's Manish's email address?");
  });

  it("explicitly skipping a traveler's email settles the party slot", () => {
    let d = munichIntent();
    d = applySlotWrite(d, {
      slot: "party",
      value: { solo: false, travelers: [{ name: "Manish" }] },
      provenance: "asked",
    });
    d = applySkip(d, partyEmailOpenItem("Manish"));
    expect(deriveState(d, null)).toBe("DATES");
    // The roster plan still carries Manish — with a null email.
    d = applySlotWrite(d, { slot: "dates", value: { startDate: "2026-09-24", endDate: "2026-09-28" }, provenance: "asked" });
    d = applySlotWrite(d, { slot: "style", value: { text: "guys' trip" }, provenance: "asked" });
    const check = buildMaterializationPlan(d);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.plan.roster).toEqual([{ invitedName: "Manish", invitedEmail: null }]);
  });

  it("rejects malformed emails and empty names", () => {
    const d = munichIntent();
    expect(() =>
      applySlotWrite(d, {
        slot: "party",
        value: { solo: false, travelers: [{ name: "Kurt", email: "not-an-email" }] },
        provenance: "asked",
      }),
    ).toThrow(IntakeValidationError);
    expect(() =>
      applySlotWrite(d, {
        slot: "party",
        value: { solo: false, travelers: [{ name: "  ", email: "a@b.com" }] },
        provenance: "asked",
      }),
    ).toThrow(IntakeValidationError);
    expect(() =>
      applySlotWrite(d, { slot: "party", value: { solo: false, travelers: [] }, provenance: "asked" }),
    ).toThrow(IntakeValidationError);
  });
});

describe("corrections (Story 1.3)", () => {
  it("a party correction from a later state updates the slot without restarting", () => {
    let d = fullIntake();
    expect(deriveState(d, null)).toBe("REVIEW");
    // Back up: pretend we are mid-DATES by removing the dates/style writes.
    d = { ...munichIntent(), openItems: [] };
    d = applySlotWrite(d, {
      slot: "party",
      value: { solo: false, travelers: [{ name: "Kurt", email: "kurt@example.com" }] },
      provenance: "asked",
    });
    expect(deriveState(d, null)).toBe("DATES");
    // "actually, make it two of them — add Pradip"
    d = applySlotWrite(d, {
      slot: "party",
      value: {
        solo: false,
        travelers: [
          { name: "Kurt", email: "kurt@example.com" },
          { name: "Pradip", email: "pradip@example.com" },
        ],
      },
      provenance: "stated",
    });
    // Still DATES — the machine did not fall back to PARTY or DESTINATION.
    expect(deriveState(d, null)).toBe("DATES");
    expect(nextAsk(d, null)?.slot).toBe("dates");
    expect(d.party?.value.travelers).toHaveLength(2);
    expect(d.party?.provenance).toBe("stated");
  });
});

describe("validation", () => {
  it("rejects impossible dates and reversed ranges", () => {
    const d = munichIntent();
    expect(() =>
      applySlotWrite(d, { slot: "dates", value: { startDate: "2026-02-30" }, provenance: "asked" }),
    ).toThrow(IntakeValidationError);
    expect(() =>
      applySlotWrite(d, {
        slot: "dates",
        value: { startDate: "2026-09-28", endDate: "2026-09-24" },
        provenance: "asked",
      }),
    ).toThrow(IntakeValidationError);
    expect(() => applySlotWrite(d, { slot: "dates", value: {}, provenance: "asked" })).toThrow(
      IntakeValidationError,
    );
  });

  it("rejects an empty destination and unknown provenance", () => {
    const d = withIntent();
    expect(() =>
      applySlotWrite(d, { slot: "destination", value: { kind: "place", text: " " }, provenance: "asked" }),
    ).toThrow(IntakeValidationError);
    expect(() =>
      applySlotWrite(d, {
        slot: "destination",
        value: { kind: "place", text: "Rome" },
        provenance: "guessed" as never,
      }),
    ).toThrow(IntakeValidationError);
  });
});

describe("style & the Family Budget cap (§2.2)", () => {
  it("family_budget style is incomplete until the cap is captured — the next ask is the cap", () => {
    let d = munichIntent();
    d = applySlotWrite(d, { slot: "party", value: { solo: true, travelers: [] }, provenance: "asked" });
    d = applySlotWrite(d, { slot: "dates", value: { startDate: "2027-06-01", endDate: "2027-06-05" }, provenance: "asked" });
    d = applySlotWrite(d, { slot: "style", value: { text: "family getaway", tier: "family_budget" }, provenance: "asked" });
    expect(deriveState(d, null)).toBe("STYLE");
    expect(nextAsk(d, null)?.question).toContain("budget cap");
    d = applySlotWrite(d, {
      slot: "style",
      value: { text: "family getaway", tier: "family_budget", budgetCapMinor: 250000, budgetCurrency: "USD" },
      provenance: "asked",
    });
    expect(deriveState(d, null)).toBe("REVIEW");
  });

  it("premium style needs no budget to complete", () => {
    expect(deriveState(fullIntake(), null)).toBe("REVIEW");
  });
});

describe("review summary", () => {
  it("lists every slot, flags context-filled assumptions, and names open items", () => {
    let d = applySlotWrite(withIntent(), {
      slot: "destination",
      value: { kind: "place", text: "Kyoto" },
      provenance: "from_context",
    });
    d = applySlotWrite(d, { slot: "party", value: { solo: true, travelers: [] }, provenance: "asked" });
    d = applySkip(d, "dates");
    d = applySlotWrite(d, { slot: "style", value: { text: "honeymoon" }, provenance: "asked" });
    const summary = buildReviewSummary(d).join("\n");
    expect(summary).toContain("Destination: Kyoto");
    expect(summary).toContain("from your profile");
    expect(summary).toContain("Who's going: just you");
    expect(summary).toContain("Still open: dates");
  });
});

describe("materialization gate (§2.3)", () => {
  it("a complete intake produces the trip + roster plan", () => {
    const check = buildMaterializationPlan(fullIntake());
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.plan.trip).toEqual({
      title: "Munich — guys' trip — Oktoberfest",
      destination: "Munich",
      startDate: "2026-09-24",
      endDate: "2026-09-28",
      status: "planning",
    });
    expect(check.plan.roster).toEqual([
      { invitedName: "Kurt", invitedEmail: "kurt@example.com" },
      { invitedName: "Pradip", invitedEmail: "pradip@example.com" },
    ]);
  });

  it("a window without exact dates cannot materialize — no fake trip", () => {
    let d = munichIntent();
    d = applySlotWrite(d, { slot: "party", value: { solo: true, travelers: [] }, provenance: "asked" });
    d = applySlotWrite(d, { slot: "dates", value: { windowText: "late September" }, provenance: "asked" });
    d = applySlotWrite(d, { slot: "style", value: { text: "guys' trip" }, provenance: "asked" });
    expect(deriveState(d, null)).toBe("REVIEW");
    const check = buildMaterializationPlan(d);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("Exact start and end dates");
  });

  it("skipped dates cannot materialize either", () => {
    let d = munichIntent();
    d = applySlotWrite(d, { slot: "party", value: { solo: true, travelers: [] }, provenance: "asked" });
    d = applySkip(d, "dates");
    d = applySlotWrite(d, { slot: "style", value: { text: "guys' trip" }, provenance: "asked" });
    const check = buildMaterializationPlan(d);
    expect(check.ok).toBe(false);
  });

  it("an incomplete intake cannot materialize", () => {
    const check = buildMaterializationPlan(munichIntent());
    expect(check.ok).toBe(false);
  });

  it("a materialized session reports MATERIALIZED and has no next ask", () => {
    const d = fullIntake();
    expect(deriveState(d, 77)).toBe("MATERIALIZED");
    expect(nextAsk(d, 77)).toBeNull();
  });
});
