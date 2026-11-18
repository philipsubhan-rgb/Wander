/**
 * Rules engine — pure logic (architecture-north-star §4.2, Story 6.4).
 *
 * Hard rules and tastes are DIFFERENT MECHANISMS, not two labels on one
 * mechanism:
 *
 *  - HARD rules compile to deterministic filter predicates. Applying
 *    them returns { kept, casualties } — every removed option is
 *    reported WITH the rule it broke; nothing is ever silently dropped.
 *    If filtering empties the set, the least-violating options come
 *    back explicitly labeled with their violations (relaxed: true) —
 *    the filter reports its own casualties; it never quietly relaxes
 *    (Stories 1.1/6.4).
 *  - PREFERENCES compile to a scoring function: a fit score plus
 *    per-option reason strings, so ranking is explainable ("Picked
 *    this one — small, local, walkable to the old town").
 *  - POLICY rules (booking_channel_required, rideshare_profile) are
 *    hard rules whose enforcement point is EXECUTION, not option
 *    filtering (TC-5): they compile to channel checks the Booking Gate
 *    consults, never to option predicates.
 *
 * Scope: a rule applies when its scope is 'all' or matches the trip's
 * scope ('work' | 'personal'). With no trip scope known, only 'all'
 * rules apply — a work rule must never leak onto a personal trip.
 *
 * No DB, no I/O: the Context/Profile service loads rule rows, this
 * module compiles and applies them. The Options Service (Duffel spike)
 * will consume exactly these functions.
 */

import { formatMoney, money } from "@workspace/money";
import type { RuleClass, RuleScope, RuleType } from "@workspace/db";

// ─── Shapes ──────────────────────────────────────────────────────────────────

/** A rule as the engine sees it — the traveler_rules row, structurally. */
export interface RuleInput {
  id?: number;
  ruleClass: RuleClass;
  ruleType: RuleType;
  params: Record<string, unknown>;
  scope: RuleScope;
  source?: "explicit" | "learned";
  active: boolean;
}

/**
 * The normalized option shape predicates run against (§5.1's option,
 * reduced to what rules can judge). Absent fields mean "unknown" — an
 * unknown is never a proven violation.
 */
export interface NormalizedOption {
  kind: "flight" | "stay" | "car" | "rail" | "activity" | "transfer" | "charter";
  /** Human label used in casualty reports ("UA30 Basic Economy"). */
  label: string;
  fareClass?: string;
  changeable?: boolean;
  connectionAirports?: string[];
  priceMinor?: number;
  currency?: string;
  /** Execution/booking channel ("Egencia", "direct", …). */
  channel?: string;
  stayStyle?: string;
  seat?: string;
  rideshareProfile?: string;
}

export type TripScope = "work" | "personal";

export interface RuleViolation {
  ruleType: RuleType;
  ruleId: number | null;
  /** Plain-language, traveler-voiceable: "Breaks your rule: never Basic Economy." */
  message: string;
}

export interface JudgedOption {
  option: NormalizedOption;
  /** Rules this option breaks. Empty for a clean keep; non-empty ONLY
   *  on the relaxed (least-violating) path, where they are the labels. */
  violations: RuleViolation[];
}

export interface ApplyHardRulesResult {
  kept: JudgedOption[];
  /** Every removed option, with the rules it broke. Always reported. */
  casualties: JudgedOption[];
  /** True when filtering emptied the set and `kept` holds the
   *  least-violating options, labeled with their violations. */
  relaxed: boolean;
}

export interface ScoredOption {
  option: NormalizedOption;
  score: number;
  /** Why this fits the traveler ("Boutique stay — matches your taste"). */
  reasons: string[];
  /** Why this cuts against a stated preference. */
  against: string[];
}

export interface ExecutionCheck {
  allowed: boolean;
  refusals: RuleViolation[];
}

// ─── Validation (shared by the service, the tools, and tests) ────────────────

export class RuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuleValidationError";
  }
}

export const RULE_TYPES: readonly RuleType[] = [
  "fare_class_ban",
  "changeability_required",
  "connection_airport_ban",
  "booking_channel_required",
  "rideshare_profile",
  "budget_cap",
  "stay_style",
  "seat_preference",
];

/** Rule types enforced at execution (the gate), not by option filtering. */
export const POLICY_RULE_TYPES: readonly RuleType[] = [
  "booking_channel_required",
  "rideshare_profile",
];

function isPolicyRule(rule: RuleInput): boolean {
  return POLICY_RULE_TYPES.includes(rule.ruleType);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
}

/** Validate + normalize a rule's params for its type. Throws RuleValidationError. */
export function validateRuleParams(
  ruleType: RuleType,
  raw: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const params = raw ?? {};
  switch (ruleType) {
    case "fare_class_ban": {
      const banned = strList(params.banned);
      if (banned.length === 0) {
        throw new RuleValidationError("fare_class_ban needs params.banned: a non-empty list of fare class names.");
      }
      return { banned };
    }
    case "changeability_required":
      return {};
    case "connection_airport_ban": {
      const airports = [
        ...strList(params.airports),
        ...(str(params.airport) ? [str(params.airport) as string] : []),
      ].map((a) => a.toUpperCase());
      if (airports.length === 0 || airports.some((a) => !/^[A-Z]{3}$/.test(a))) {
        throw new RuleValidationError("connection_airport_ban needs params.airport (IATA) or params.airports.");
      }
      return { airports: [...new Set(airports)] };
    }
    case "booking_channel_required": {
      const channel = str(params.channel);
      if (!channel) throw new RuleValidationError("booking_channel_required needs params.channel.");
      return { channel };
    }
    case "rideshare_profile": {
      const profile = str(params.profile);
      if (!profile) throw new RuleValidationError("rideshare_profile needs params.profile (e.g. \"Business\").");
      return { profile };
    }
    case "budget_cap": {
      const capMinor = params.capMinor;
      const currency = str(params.currency)?.toUpperCase();
      if (typeof capMinor !== "number" || !Number.isInteger(capMinor) || capMinor <= 0) {
        throw new RuleValidationError("budget_cap needs params.capMinor: a positive integer of minor units.");
      }
      if (!currency || !/^[A-Z]{3}$/.test(currency)) {
        throw new RuleValidationError("budget_cap needs params.currency: an ISO 4217 code.");
      }
      return { capMinor, currency };
    }
    case "stay_style": {
      const style = str(params.style);
      if (!style) throw new RuleValidationError("stay_style needs params.style.");
      return withWeight({ style }, params);
    }
    case "seat_preference": {
      const seat = str(params.seat);
      if (!seat) throw new RuleValidationError("seat_preference needs params.seat.");
      return withWeight({ seat }, params);
    }
  }
}

function withWeight(
  base: Record<string, unknown>,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const w = params.weight;
  if (w === undefined) return base;
  if (typeof w !== "number" || !Number.isFinite(w) || w <= 0) {
    throw new RuleValidationError("params.weight must be a positive number when given.");
  }
  return { ...base, weight: w };
}

// ─── Plain-language description (planner snapshot, review surfaces) ──────────

function formatCap(capMinor: number, currency: string): string {
  try {
    return formatMoney(money(capMinor, currency));
  } catch {
    return `${currency} ${capMinor} minor units`;
  }
}

/** One plain-language line per rule — safe to voice to the rule's owner. */
export function describeRule(rule: RuleInput): string {
  const p = rule.params;
  switch (rule.ruleType) {
    case "fare_class_ban":
      return `Never ${strList(p.banned).join(" or ") || "a banned fare class"}`;
    case "changeability_required":
      return "Changeable fares only";
    case "connection_airport_ban": {
      const airports = [...strList(p.airports), ...(str(p.airport) ? [str(p.airport) as string] : [])];
      return `No connections through ${airports.join(", ")}`;
    }
    case "booking_channel_required":
      return `Book through ${str(p.channel) ?? "the required channel"} only`;
    case "rideshare_profile":
      return `Rideshare: ${str(p.profile) ?? "—"} profile`;
    case "budget_cap":
      return `Budget cap ${formatCap(Number(p.capMinor ?? 0), str(p.currency) ?? "")}`;
    case "stay_style":
      return `Stays: ${str(p.style) ?? "—"}`;
    case "seat_preference": {
      const seat = str(p.seat) ?? "—";
      return `${seat.charAt(0).toUpperCase()}${seat.slice(1)} seat`;
    }
  }
}

// ─── Scope ───────────────────────────────────────────────────────────────────

/**
 * The rules in force for a trip: active, and scope-compatible. A rule
 * scoped 'work' never applies to a personal trip (and vice versa); with
 * no trip scope known, only 'all' rules apply.
 */
export function applicableRules(
  rules: readonly RuleInput[],
  tripScope?: TripScope,
): RuleInput[] {
  return rules.filter(
    (r) => r.active && (r.scope === "all" || (tripScope !== undefined && r.scope === tripScope)),
  );
}

// ─── Hard rules → filter predicates ──────────────────────────────────────────

function hardViolation(rule: RuleInput, option: NormalizedOption): RuleViolation | null {
  const p = rule.params;
  const id = rule.id ?? null;
  const mk = (message: string): RuleViolation => ({ ruleType: rule.ruleType, ruleId: id, message });
  switch (rule.ruleType) {
    case "fare_class_ban": {
      const banned = strList(p.banned);
      if (option.fareClass && banned.some((b) => b.toLowerCase() === option.fareClass!.toLowerCase())) {
        return mk(`Breaks your rule: never ${option.fareClass}.`);
      }
      return null;
    }
    case "changeability_required":
      return option.changeable === false
        ? mk("Breaks your rule: changeable fares only — this one isn't changeable.")
        : null;
    case "connection_airport_ban": {
      const banned = new Set(
        [...strList(p.airports), ...(str(p.airport) ? [str(p.airport) as string] : [])].map((a) =>
          a.toUpperCase(),
        ),
      );
      const hit = (option.connectionAirports ?? []).find((a) => banned.has(a.toUpperCase()));
      return hit ? mk(`Breaks your rule: no connections through ${hit.toUpperCase()}.`) : null;
    }
    case "budget_cap": {
      const capMinor = Number(p.capMinor);
      const currency = str(p.currency)?.toUpperCase();
      // Cross-currency comparison without an FX snapshot is not
      // deterministic — an unpriced or foreign-currency option is not a
      // proven violation.
      if (
        option.priceMinor !== undefined &&
        currency &&
        option.currency?.toUpperCase() === currency &&
        option.priceMinor > capMinor
      ) {
        return mk(
          `Breaks your budget cap of ${formatCap(capMinor, currency)} — this is ${formatCap(option.priceMinor, currency)}.`,
        );
      }
      return null;
    }
    case "stay_style": {
      const style = str(p.style);
      if (style && option.stayStyle && option.stayStyle.toLowerCase() !== style.toLowerCase()) {
        return mk(`Breaks your rule: ${style} stays only — this is ${option.stayStyle}.`);
      }
      return null;
    }
    case "seat_preference": {
      const seat = str(p.seat);
      if (seat && option.seat && option.seat.toLowerCase() !== seat.toLowerCase()) {
        return mk(`Breaks your rule: ${seat} seat — this is ${option.seat}.`);
      }
      return null;
    }
    case "booking_channel_required":
    case "rideshare_profile":
      // Policy rules never filter options (§4.2) — execution checks below.
      return null;
  }
}

/** All hard-rule violations of one option (policy rules excluded). */
export function optionViolations(
  rules: readonly RuleInput[],
  option: NormalizedOption,
  tripScope?: TripScope,
): RuleViolation[] {
  const out: RuleViolation[] = [];
  for (const rule of applicableRules(rules, tripScope)) {
    if (rule.ruleClass !== "hard" || isPolicyRule(rule)) continue;
    const v = hardViolation(rule, option);
    if (v) out.push(v);
  }
  return out;
}

/**
 * Apply the traveler's hard rules to an option set. Clean options are
 * kept; violators are reported as casualties with their rules. If EVERY
 * option violates something, the least-violating ones (fewest broken
 * rules, original order on ties) are returned as kept — labeled with
 * their violations, relaxed: true — rather than an empty set or a
 * silent relaxation.
 */
export function applyHardRules(
  rules: readonly RuleInput[],
  options: readonly NormalizedOption[],
  tripScope?: TripScope,
): ApplyHardRulesResult {
  const judged = options.map((option) => ({
    option,
    violations: optionViolations(rules, option, tripScope),
  }));
  const kept = judged.filter((j) => j.violations.length === 0);
  if (kept.length > 0 || judged.length === 0) {
    return { kept, casualties: judged.filter((j) => j.violations.length > 0), relaxed: false };
  }
  const min = Math.min(...judged.map((j) => j.violations.length));
  return {
    kept: judged.filter((j) => j.violations.length === min),
    casualties: judged.filter((j) => j.violations.length > min),
    relaxed: true,
  };
}

// ─── Preferences → ranking ───────────────────────────────────────────────────

const DEFAULT_PREFERENCE_WEIGHT = 10;

function preferenceWeight(rule: RuleInput): number {
  const w = rule.params.weight;
  return typeof w === "number" && Number.isFinite(w) && w > 0 ? w : DEFAULT_PREFERENCE_WEIGHT;
}

/** Score one option against the traveler's preferences. */
export function scoreOption(
  rules: readonly RuleInput[],
  option: NormalizedOption,
  tripScope?: TripScope,
): ScoredOption {
  let score = 0;
  const reasons: string[] = [];
  const against: string[] = [];
  for (const rule of applicableRules(rules, tripScope)) {
    if (rule.ruleClass !== "preference") continue;
    const w = preferenceWeight(rule);
    const p = rule.params;
    switch (rule.ruleType) {
      case "stay_style": {
        const style = str(p.style);
        if (style && option.stayStyle) {
          if (option.stayStyle.toLowerCase() === style.toLowerCase()) {
            score += w;
            reasons.push(`${option.stayStyle} stay — matches your taste for ${style}.`);
          } else {
            score -= w / 2;
            against.push(`${option.stayStyle} stay — you lean ${style}.`);
          }
        }
        break;
      }
      case "seat_preference": {
        const seat = str(p.seat);
        if (seat && option.seat) {
          if (option.seat.toLowerCase() === seat.toLowerCase()) {
            score += w;
            reasons.push(`${seat} seat, as you prefer.`);
          } else {
            score -= w / 2;
            against.push(`${option.seat} seat — you prefer ${seat}.`);
          }
        }
        break;
      }
      case "changeability_required":
        if (option.changeable === true) {
          score += w;
          reasons.push("Changeable fare, as you prefer.");
        } else if (option.changeable === false) {
          score -= w / 2;
          against.push("Not changeable — you prefer changeable fares.");
        }
        break;
      case "fare_class_ban": {
        const banned = strList(p.banned);
        if (option.fareClass && banned.some((b) => b.toLowerCase() === option.fareClass!.toLowerCase())) {
          score -= w;
          against.push(`${option.fareClass} — against your preference.`);
        }
        break;
      }
      case "budget_cap": {
        const capMinor = Number(p.capMinor);
        const currency = str(p.currency)?.toUpperCase();
        if (
          option.priceMinor !== undefined &&
          currency &&
          option.currency?.toUpperCase() === currency
        ) {
          if (option.priceMinor <= capMinor) {
            score += w;
            reasons.push(`Within your ${formatCap(capMinor, currency)} budget.`);
          } else {
            score -= w;
            against.push(`Over your ${formatCap(capMinor, currency)} budget.`);
          }
        }
        break;
      }
      case "connection_airport_ban": {
        const banned = new Set(
          [...strList(p.airports), ...(str(p.airport) ? [str(p.airport) as string] : [])].map((a) =>
            a.toUpperCase(),
          ),
        );
        const hit = (option.connectionAirports ?? []).find((a) => banned.has(a.toUpperCase()));
        if (hit) {
          score -= w;
          against.push(`Connects through ${hit.toUpperCase()} — you'd rather avoid it.`);
        }
        break;
      }
      case "booking_channel_required":
      case "rideshare_profile":
        // Policy tastes don't rank options either.
        break;
    }
  }
  return { option, score, reasons, against };
}

/** Rank options by preference fit (desc; stable on ties). */
export function rankOptions(
  rules: readonly RuleInput[],
  options: readonly NormalizedOption[],
  tripScope?: TripScope,
): ScoredOption[] {
  return options
    .map((option, index) => ({ scored: scoreOption(rules, option, tripScope), index }))
    .sort((a, b) => b.scored.score - a.scored.score || a.index - b.index)
    .map(({ scored }) => scored);
}

// ─── Policy rules → execution checks (TC-5) ──────────────────────────────────

/**
 * The Booking Gate's policy check: when a booking_channel_required rule
 * is in force for this trip scope, execution through any other channel
 * is refused — with the reason stated. The rule filters the CHANNEL,
 * never the option list (§4.2).
 */
export function checkExecutionChannel(
  rules: readonly RuleInput[],
  execution: { channel?: string },
  tripScope?: TripScope,
): ExecutionCheck {
  const refusals: RuleViolation[] = [];
  for (const rule of applicableRules(rules, tripScope)) {
    if (rule.ruleType !== "booking_channel_required") continue;
    const required = str(rule.params.channel);
    if (!required) continue;
    if (!execution.channel || execution.channel.toLowerCase() !== required.toLowerCase()) {
      refusals.push({
        ruleType: rule.ruleType,
        ruleId: rule.id ?? null,
        message:
          `Refused: your rule requires booking through ${required}` +
          (execution.channel ? ` — ${execution.channel} is not that channel.` : " — no channel was given."),
      });
    }
  }
  return { allowed: refusals.length === 0, refusals };
}

/** The rideshare twin of the channel check (TC-5's Uber-Business rule). */
export function checkRideshareProfile(
  rules: readonly RuleInput[],
  execution: { profile?: string },
  tripScope?: TripScope,
): ExecutionCheck {
  const refusals: RuleViolation[] = [];
  for (const rule of applicableRules(rules, tripScope)) {
    if (rule.ruleType !== "rideshare_profile") continue;
    const required = str(rule.params.profile);
    if (!required) continue;
    if (!execution.profile || execution.profile.toLowerCase() !== required.toLowerCase()) {
      refusals.push({
        ruleType: rule.ruleType,
        ruleId: rule.id ?? null,
        message:
          `Refused: your rule requires the ${required} rideshare profile` +
          (execution.profile ? ` — ${execution.profile} was requested.` : " — no profile was given."),
      });
    }
  }
  return { allowed: refusals.length === 0, refusals };
}
