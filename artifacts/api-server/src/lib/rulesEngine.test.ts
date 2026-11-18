/**
 * Rules engine — pure-logic tests (architecture-north-star §4.2).
 *
 * The load-bearing cases are the tier test-case shapes:
 *  - TC-3: a no-Basic-Economy hard rule REMOVES the Basic fare and the
 *    casualty is reported with its rule; a route where only Basic
 *    exists returns the least-violating options LABELED, never an
 *    empty set and never a silent relaxation.
 *  - TC-5: a work-scoped Egencia booking_channel_required rule refuses
 *    off-channel EXECUTION with the reason stated — and does not touch
 *    the option list at all (policy rules filter channels, not options).
 *  - Scope: a work rule does not filter a personal trip.
 */

import { describe, it, expect } from "vitest";
import {
  RuleValidationError,
  applicableRules,
  applyHardRules,
  checkExecutionChannel,
  checkRideshareProfile,
  describeRule,
  optionViolations,
  rankOptions,
  scoreOption,
  validateRuleParams,
  type NormalizedOption,
  type RuleInput,
} from "./rulesEngine.js";

function rule(overrides: Partial<RuleInput> & Pick<RuleInput, "ruleType">): RuleInput {
  return {
    ruleClass: "hard",
    params: {},
    scope: "all",
    source: "explicit",
    active: true,
    ...overrides,
  };
}

function flight(overrides: Partial<NormalizedOption> = {}): NormalizedOption {
  return { kind: "flight", label: "UA30", ...overrides };
}

const noBasic = rule({
  id: 1,
  ruleType: "fare_class_ban",
  params: { banned: ["Basic Economy"] },
});
const changeableOnly = rule({
  id: 2,
  ruleType: "changeability_required",
});
const noMia = rule({
  id: 3,
  ruleType: "connection_airport_ban",
  params: { airport: "MIA" },
});
const egenciaWork = rule({
  id: 4,
  ruleType: "booking_channel_required",
  params: { channel: "Egencia" },
  scope: "work",
});
const uberBusinessWork = rule({
  id: 5,
  ruleType: "rideshare_profile",
  params: { profile: "Business" },
  scope: "work",
});

// ─── Validation ──────────────────────────────────────────────────────────────

describe("validateRuleParams", () => {
  it("normalizes each type and rejects malformed params", () => {
    expect(validateRuleParams("fare_class_ban", { banned: ["Basic Economy"] })).toEqual({
      banned: ["Basic Economy"],
    });
    expect(validateRuleParams("connection_airport_ban", { airport: "mia" })).toEqual({
      airports: ["MIA"],
    });
    expect(validateRuleParams("budget_cap", { capMinor: 200000, currency: "usd" })).toEqual({
      capMinor: 200000,
      currency: "USD",
    });
    expect(() => validateRuleParams("fare_class_ban", { banned: [] })).toThrow(RuleValidationError);
    expect(() => validateRuleParams("booking_channel_required", {})).toThrow(RuleValidationError);
    expect(() => validateRuleParams("budget_cap", { capMinor: -5, currency: "USD" })).toThrow(
      RuleValidationError,
    );
    expect(() => validateRuleParams("budget_cap", { capMinor: 100, currency: "US" })).toThrow(
      RuleValidationError,
    );
  });
});

describe("describeRule", () => {
  it("renders plain-language lines safe to voice to the owner", () => {
    expect(describeRule(noBasic)).toBe("Never Basic Economy");
    expect(describeRule(changeableOnly)).toBe("Changeable fares only");
    expect(describeRule(noMia)).toBe("No connections through MIA");
    expect(describeRule(egenciaWork)).toBe("Book through Egencia only");
    expect(describeRule(rule({ ruleType: "seat_preference", ruleClass: "preference", params: { seat: "aisle" } }))).toBe(
      "Aisle seat",
    );
  });
});

// ─── Scope ───────────────────────────────────────────────────────────────────

describe("applicableRules — scope", () => {
  it("a work rule does not apply to a personal trip; 'all' always applies", () => {
    const rules = [noBasic, egenciaWork];
    expect(applicableRules(rules, "personal").map((r) => r.ruleType)).toEqual(["fare_class_ban"]);
    expect(applicableRules(rules, "work").map((r) => r.ruleType)).toEqual([
      "fare_class_ban",
      "booking_channel_required",
    ]);
    // No trip scope known → only 'all' rules (never leak work onto personal).
    expect(applicableRules(rules).map((r) => r.ruleType)).toEqual(["fare_class_ban"]);
  });

  it("inactive rules never apply", () => {
    expect(applicableRules([{ ...noBasic, active: false }], "work")).toEqual([]);
  });
});

// ─── Hard filter — TC-3 ──────────────────────────────────────────────────────

describe("applyHardRules — TC-3 (no Basic Economy)", () => {
  it("removes the Basic fare and REPORTS it as a casualty with its rule", () => {
    const options = [
      flight({ label: "UA30 Main Cabin", fareClass: "Main Cabin", changeable: true, priceMinor: 45000, currency: "USD" }),
      flight({ label: "UA30 Basic Economy", fareClass: "Basic Economy", changeable: false, priceMinor: 31000, currency: "USD" }),
      flight({ label: "UA31 Main Cabin", fareClass: "Main Cabin", changeable: true, priceMinor: 52000, currency: "USD" }),
    ];
    const result = applyHardRules([noBasic], options);
    expect(result.relaxed).toBe(false);
    expect(result.kept.map((k) => k.option.label)).toEqual(["UA30 Main Cabin", "UA31 Main Cabin"]);
    expect(result.kept.every((k) => k.violations.length === 0)).toBe(true);
    expect(result.casualties).toHaveLength(1);
    expect(result.casualties[0].option.label).toBe("UA30 Basic Economy");
    expect(result.casualties[0].violations).toHaveLength(1);
    expect(result.casualties[0].violations[0].ruleType).toBe("fare_class_ban");
    expect(result.casualties[0].violations[0].message).toContain("Basic Economy");
  });

  it("only-Basic route: least-violating options return LABELED — never empty, never silent", () => {
    const options = [
      flight({ label: "AA Basic 1", fareClass: "Basic Economy", priceMinor: 31000, currency: "USD" }),
      flight({ label: "AA Basic 2", fareClass: "Basic Economy", priceMinor: 33000, currency: "USD" }),
    ];
    const result = applyHardRules([noBasic], options);
    expect(result.relaxed).toBe(true);
    expect(result.kept.map((k) => k.option.label)).toEqual(["AA Basic 1", "AA Basic 2"]);
    // The label travels with the option: the violation is ON the kept item.
    expect(result.kept[0].violations[0].ruleType).toBe("fare_class_ban");
    expect(result.casualties).toEqual([]);
  });

  it("least-violating means FEWEST broken rules when counts differ", () => {
    const options = [
      // Breaks both rules (Basic + not changeable).
      flight({ label: "Basic inflexible", fareClass: "Basic Economy", changeable: false }),
      // Breaks one (Basic, but changeable).
      flight({ label: "Basic changeable", fareClass: "Basic Economy", changeable: true }),
    ];
    const result = applyHardRules([noBasic, changeableOnly], options);
    expect(result.relaxed).toBe(true);
    expect(result.kept.map((k) => k.option.label)).toEqual(["Basic changeable"]);
    expect(result.kept[0].violations).toHaveLength(1);
    expect(result.casualties.map((c) => c.option.label)).toEqual(["Basic inflexible"]);
    expect(result.casualties[0].violations).toHaveLength(2);
  });
});

// ─── Hard filter — the other predicates ──────────────────────────────────────

describe("applyHardRules — changeability, connections, budget", () => {
  it("changeability_required removes non-changeable fares; unknown changeability is not a proven violation", () => {
    const result = applyHardRules(
      [changeableOnly],
      [
        flight({ label: "flex", changeable: true }),
        flight({ label: "stuck", changeable: false }),
        flight({ label: "unknown" }),
      ],
    );
    expect(result.kept.map((k) => k.option.label)).toEqual(["flex", "unknown"]);
    expect(result.casualties.map((c) => c.option.label)).toEqual(["stuck"]);
  });

  it("connection_airport_ban removes MIA connections only", () => {
    const result = applyHardRules(
      [noMia],
      [
        flight({ label: "via MIA", connectionAirports: ["MIA"] }),
        flight({ label: "via ORD", connectionAirports: ["ORD"] }),
        flight({ label: "nonstop", connectionAirports: [] }),
      ],
    );
    expect(result.kept.map((k) => k.option.label)).toEqual(["via ORD", "nonstop"]);
    expect(result.casualties[0].violations[0].message).toContain("MIA");
  });

  it("budget_cap (hard) removes over-cap options in the cap's currency only", () => {
    const cap = rule({ id: 6, ruleType: "budget_cap", params: { capMinor: 40000, currency: "USD" } });
    const result = applyHardRules(
      [cap],
      [
        flight({ label: "under", priceMinor: 39900, currency: "USD" }),
        flight({ label: "over", priceMinor: 40100, currency: "USD" }),
        // €450 against a USD cap: not comparable without FX — not a violation.
        flight({ label: "euros", priceMinor: 45000, currency: "EUR" }),
        flight({ label: "unpriced" }),
      ],
    );
    expect(result.kept.map((k) => k.option.label)).toEqual(["under", "euros", "unpriced"]);
    expect(result.casualties.map((c) => c.option.label)).toEqual(["over"]);
  });

  it("an empty option set stays empty and unrelaxed", () => {
    expect(applyHardRules([noBasic], [])).toEqual({ kept: [], casualties: [], relaxed: false });
  });
});

// ─── Policy rules — TC-5 ─────────────────────────────────────────────────────

describe("policy rules — TC-5 (Egencia-only work travel)", () => {
  it("a channel rule does NOT filter options — even off-channel ones", () => {
    const options = [
      flight({ label: "booked direct", channel: "direct" }),
      flight({ label: "booked via Egencia", channel: "Egencia" }),
    ];
    const result = applyHardRules([egenciaWork], options, "work");
    expect(result.kept.map((k) => k.option.label)).toEqual(["booked direct", "booked via Egencia"]);
    expect(result.casualties).toEqual([]);
    expect(optionViolations([egenciaWork], options[0], "work")).toEqual([]);
  });

  it("execution through the wrong channel is refused, with the reason stated", () => {
    const check = checkExecutionChannel([egenciaWork], { channel: "direct" }, "work");
    expect(check.allowed).toBe(false);
    expect(check.refusals).toHaveLength(1);
    expect(check.refusals[0].ruleType).toBe("booking_channel_required");
    expect(check.refusals[0].message).toContain("Egencia");
    expect(check.refusals[0].message).toContain("direct");
  });

  it("execution through Egencia is allowed; no channel given is refused", () => {
    expect(checkExecutionChannel([egenciaWork], { channel: "Egencia" }, "work").allowed).toBe(true);
    expect(checkExecutionChannel([egenciaWork], { channel: "egencia" }, "work").allowed).toBe(true);
    expect(checkExecutionChannel([egenciaWork], {}, "work").allowed).toBe(false);
  });

  it("the SAME execution on a personal trip is untouched by the work rule", () => {
    expect(checkExecutionChannel([egenciaWork], { channel: "direct" }, "personal").allowed).toBe(true);
    expect(checkExecutionChannel([egenciaWork], { channel: "direct" }).allowed).toBe(true);
  });

  it("rideshare profile: Business required at work, Personal refused — and only at work", () => {
    expect(checkRideshareProfile([uberBusinessWork], { profile: "Personal" }, "work").allowed).toBe(false);
    expect(checkRideshareProfile([uberBusinessWork], { profile: "Business" }, "work").allowed).toBe(true);
    expect(checkRideshareProfile([uberBusinessWork], { profile: "Personal" }, "personal").allowed).toBe(true);
    const refusal = checkRideshareProfile([uberBusinessWork], { profile: "Personal" }, "work");
    expect(refusal.refusals[0].message).toContain("Business");
  });
});

// ─── Preferences — ranking ───────────────────────────────────────────────────

describe("preferences — scoring and ranking (Story 6.4)", () => {
  const boutiqueTaste = rule({
    id: 7,
    ruleClass: "preference",
    ruleType: "stay_style",
    params: { style: "boutique" },
  });
  const aisleTaste = rule({
    id: 8,
    ruleClass: "preference",
    ruleType: "seat_preference",
    params: { seat: "aisle" },
  });

  it("a boutique stay outranks an equivalent chain stay, and says why", () => {
    const stays: NormalizedOption[] = [
      { kind: "stay", label: "Grand Chain Hotel", stayStyle: "chain" },
      { kind: "stay", label: "Little Local Inn", stayStyle: "boutique" },
    ];
    const ranked = rankOptions([boutiqueTaste], stays);
    expect(ranked[0].option.label).toBe("Little Local Inn");
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
    expect(ranked[0].reasons.join(" ")).toContain("boutique");
    expect(ranked[1].against.join(" ")).toContain("boutique");
  });

  it("seat preference scores the aisle seat up with a reason", () => {
    const scored = scoreOption([aisleTaste], flight({ label: "14A", seat: "aisle" }));
    expect(scored.score).toBe(10);
    expect(scored.reasons[0]).toContain("aisle");
    const window = scoreOption([aisleTaste], flight({ label: "14F", seat: "window" }));
    expect(window.score).toBeLessThan(scored.score);
    expect(window.against[0]).toContain("aisle");
  });

  it("hard rules never leak into scoring, and preferences never filter", () => {
    // A preference-class fare ban penalizes but cannot remove.
    const softBan = rule({ id: 9, ruleClass: "preference", ruleType: "fare_class_ban", params: { banned: ["Basic Economy"] } });
    const scored = scoreOption([softBan], flight({ fareClass: "Basic Economy" }));
    expect(scored.score).toBe(-10);
    expect(scored.against[0]).toContain("Basic Economy");
    // A hard rule contributes nothing to a score.
    expect(scoreOption([noBasic], flight({ fareClass: "Basic Economy" })).score).toBe(0);
  });

  it("ranking is stable on ties (original order preserved)", () => {
    const options = [flight({ label: "first" }), flight({ label: "second" })];
    expect(rankOptions([], options).map((r) => r.option.label)).toEqual(["first", "second"]);
  });
});
