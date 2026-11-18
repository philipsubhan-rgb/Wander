/**
 * Options Service — core (architecture-north-star §5.1, §5.5, §8).
 *
 * One adapter interface, many providers: an adapter turns a search
 * context into normalized options; this module owns everything that
 * must be true of options no matter which adapter produced them:
 *
 *  - The normalized option shape (§5.1): money in the SUPPLIER's charge
 *    currency, untouched; a home-currency equivalent exists only when a
 *    real FX snapshot backs it, and is always labeled an estimate.
 *  - Freshness (§8): browse prices are NEAR-TIME — a shared cache keyed
 *    by search parameters (never per user), a TTL per kind, `priced_at`
 *    on every set, refresh on view-if-stale / parameter change /
 *    explicit request. There is no timer and no polling anywhere here:
 *    staleness is computed at read time, never pushed.
 *  - Ranking purity (§5.5 / ADR-8): the ranking function receives
 *    options with the `partner` field STRIPPED — partner status and
 *    commission are absent from its inputs, not weighted zero. A
 *    separate presentation step re-attaches partner disclosure labels
 *    AFTER ordering. Fit reasons are generated from fit inputs only.
 *  - Hard rules FILTER before ranking (rulesEngine, §4.2): casualties
 *    ride along in the OptionSet with the rules they broke; an emptied
 *    set comes back least-violating and labeled (relaxed), never
 *    silently relaxed.
 *
 * Pure module: no DB, no I/O. The orchestration that loads traveler
 * rules / home currency / FX snapshots lives in optionsService.ts.
 */

import { currencyExponent, formatMoney, money, type Money } from "@workspace/money";
import {
  applyHardRules,
  scoreOption,
  type NormalizedOption,
  type RuleInput,
  type RuleViolation,
  type TripScope,
} from "./rulesEngine";

// ─── Normalized option shape (§5.1) ──────────────────────────────────────────

export type OptionKind = "flight" | "rail" | "car" | "stay" | "activity" | "charter" | "transfer";
export type PriceNature = "firm" | "estimate" | "quote";
export type Fulfillment = "api_rail" | "quote_request" | "phone_only";

/** Display metadata ONLY (§5.5). Never a ranking input — see rankOptionSet. */
export interface PartnerRef {
  id: string;
  name: string;
}

export interface FlightSliceSummary {
  origin: string;
  destination: string;
  /** ISO timestamps as the supplier stated them (local, with offset when given). */
  departAt: string;
  arriveAt: string;
  stops: number;
  layovers: Array<{ airport: string; minutes: number }>;
  durationMinutes: number | null;
  flightNumbers: string[];
}

export interface FlightSummary {
  carrier: string;
  carrierCode: string | null;
  slices: FlightSliceSummary[];
  totalDurationMinutes: number | null;
  totalStops: number;
  /** Supplier's fare label, normalized (see duffel.ts fare canonicalization). */
  fareClass: string | null;
  cabinClass: string | null;
  /** undefined = the supplier didn't say — never a proven rule violation. */
  changeable?: boolean;
  refundable?: boolean;
  connectionAirports: string[];
  /** Voiceable one-liner label, also the rules-engine label ("UA30 Basic Economy"). */
  label: string;
}

export interface HomeEquivalent {
  money: Money;
  /** The fx_rate_snapshots row that produced this figure — provenance. */
  fxSnapshotId: number;
  rateAsOf: string;
}

export interface WanderOption {
  /** Adapter-scoped id (e.g. the Duffel offer id). */
  id: string;
  kind: OptionKind;
  /** Which adapter produced this ("duffel"). */
  adapter: string;
  supplier: string;
  summary: FlightSummary;
  /** Charge currency, supplier-quoted, untouched. */
  money: Money;
  /** Converted display figure — estimate, snapshot-backed, or null. */
  homeEquivalent: HomeEquivalent | null;
  pricedAt: string;
  priceNature: PriceNature;
  fulfillment: Fulfillment;
  /** Rule labels carried by this option (non-empty only on the relaxed path). */
  ruleViolations: RuleViolation[];
  partner: PartnerRef | null;
}

// ─── Search context & the adapter interface ──────────────────────────────────

export interface FlightSearchContext {
  origin: string;
  destination: string;
  departureDate: string;
  returnDate?: string;
  /** Adults for this spike; child/infant mixes are a later adapter concern. */
  passengerCount: number;
  cabinClass?: "economy" | "premium_economy" | "business" | "first";
  maxConnections?: number;
}

export interface OptionsAdapter {
  readonly id: string;
  readonly enabled: boolean;
  /** Why the adapter is off, in plain language ("" when enabled). */
  readonly disabledReason: string;
  searchFlights(ctx: FlightSearchContext): Promise<WanderOption[]>;
}

// ─── Cache (§8 near-time tier) ───────────────────────────────────────────────

/** TTL defaults from §8.2: flights 20 min, rail 60 min, stays 6 h, activities 24 h. */
export const OPTION_TTL_MS: Record<OptionKind, number> = {
  flight: 20 * 60 * 1000,
  rail: 60 * 60 * 1000,
  stay: 6 * 60 * 60 * 1000,
  activity: 24 * 60 * 60 * 1000,
  car: 60 * 60 * 1000,
  charter: 24 * 60 * 60 * 1000,
  transfer: 60 * 60 * 1000,
};

export interface CacheEntry {
  options: WanderOption[];
  /** When the prices were fetched (the options' own priced_at basis). */
  pricedAt: string;
  storedAtMs: number;
}

/**
 * The shared option cache. Keyed by SEARCH PARAMETERS ONLY — never by
 * user — so one provider call serves every traveler searching the same
 * leg (§8.4: spend scales with distinct searches, not stored users).
 * In-memory for the spike; the interface is the seam a shared store
 * replaces later. No timers: freshness is computed at read.
 */
export class OptionCache {
  private entries = new Map<string, CacheEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  get(key: string): (CacheEntry & { fresh: boolean; ageMs: number }) | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const ageMs = this.now() - entry.storedAtMs;
    const kind = entry.options[0]?.kind ?? "flight";
    return { ...entry, ageMs, fresh: ageMs <= OPTION_TTL_MS[kind] };
  }

  set(key: string, options: WanderOption[], pricedAt: string): void {
    this.entries.set(key, { options, pricedAt, storedAtMs: this.now() });
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Canonical cache key: normalized search parameters, nothing user-shaped. */
export function flightCacheKey(ctx: FlightSearchContext): string {
  return JSON.stringify({
    kind: "flight",
    origin: ctx.origin.toUpperCase(),
    destination: ctx.destination.toUpperCase(),
    departureDate: ctx.departureDate,
    returnDate: ctx.returnDate ?? null,
    passengerCount: ctx.passengerCount,
    cabinClass: ctx.cabinClass ?? null,
    maxConnections: ctx.maxConnections ?? null,
  });
}

/** "priced just now" / "priced 12 min ago" / "priced 2 h ago" — always labelable. */
export function stalenessLabel(pricedAt: string, nowMs: number): string {
  const then = Date.parse(pricedAt);
  if (Number.isNaN(then)) return "price age unknown";
  const ageMin = Math.max(0, Math.round((nowMs - then) / 60000));
  if (ageMin < 1) return "priced just now";
  if (ageMin < 60) return `priced ${ageMin} min ago`;
  const hours = Math.floor(ageMin / 60);
  const mins = ageMin % 60;
  return mins === 0 ? `priced ${hours} h ago` : `priced ${hours} h ${mins} min ago`;
}

export function isStale(pricedAt: string, kind: OptionKind, nowMs: number): boolean {
  const then = Date.parse(pricedAt);
  if (Number.isNaN(then)) return true;
  return nowMs - then > OPTION_TTL_MS[kind];
}

// ─── FX: snapshot-backed home equivalents (never guessed) ────────────────────

/** A resolved FX rate as an exact rational: quote units per 1 base unit. */
export interface FxRate {
  num: bigint;
  den: bigint;
  snapshotId: number;
  asOf: string;
}

/**
 * Resolves a conversion rate from stored snapshots. Returns null when no
 * snapshot covers the pair — the caller then shows NO equivalent rather
 * than a guessed one. Implementations may invert a stored pair.
 */
export type FxRateResolver = (fromCurrency: string, toCurrency: string) => Promise<FxRate | null>;

/** Parse a decimal string ("1.0630000000") into an exact rational. */
export function parseDecimalToRational(text: string): { num: bigint; den: bigint } | null {
  const m = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) return null;
  const frac = m[3] ?? "";
  const den = 10n ** BigInt(frac.length);
  let num = BigInt(m[2]) * den + (frac ? BigInt(frac) : 0n);
  if (m[1] === "-") num = -num;
  return { num, den };
}

/**
 * Convert a money value at an exact rational rate, exponent-aware:
 * minor_t = round_half_up( minor_s × rate × 10^(exp_t − exp_s) ).
 * BigInt throughout — no float ever touches a price.
 */
export function convertWithRate(m: Money, rate: { num: bigint; den: bigint }, targetCurrency: string): Money {
  const expS = currencyExponent(m.currency)!;
  const expT = currencyExponent(targetCurrency)!;
  let num = BigInt(m.amountMinor) * rate.num;
  let den = rate.den;
  const shift = expT - expS;
  if (shift >= 0) num *= 10n ** BigInt(shift);
  else den *= 10n ** BigInt(-shift);
  // Round half-up on magnitude.
  const negative = num < 0n;
  const absNum = negative ? -num : num;
  let quotient = absNum / den;
  if ((absNum % den) * 2n >= den) quotient += 1n;
  return money(Number(negative ? -quotient : quotient), targetCurrency);
}

/**
 * Attach home equivalents to a set of options. Same-currency options get
 * no equivalent (the price already IS home). Options whose pair has no
 * snapshot keep `homeEquivalent: null` — never a guessed rate.
 */
export async function attachHomeEquivalents(
  options: WanderOption[],
  homeCurrency: string | null,
  resolveRate: FxRateResolver,
): Promise<WanderOption[]> {
  if (!homeCurrency) return options;
  const home = homeCurrency.toUpperCase();
  const rateCache = new Map<string, FxRate | null>();
  const out: WanderOption[] = [];
  for (const option of options) {
    if (option.money.currency === home) {
      out.push(option);
      continue;
    }
    const pair = `${option.money.currency}->${home}`;
    if (!rateCache.has(pair)) {
      rateCache.set(pair, await resolveRate(option.money.currency, home));
    }
    const rate = rateCache.get(pair);
    if (!rate) {
      out.push(option);
      continue;
    }
    out.push({
      ...option,
      homeEquivalent: {
        money: convertWithRate(option.money, rate, home),
        fxSnapshotId: rate.snapshotId,
        rateAsOf: rate.asOf,
      },
    });
  }
  return out;
}

// ─── Ranking (§5.5: purity made structural) ──────────────────────────────────

/**
 * The ranking function's input: an option with the partner field REMOVED
 * at the type level. There is no commission field anywhere in this
 * module. Ranking cannot see what it cannot see.
 */
export type RankableOption = Omit<WanderOption, "partner">;

export interface RankedOption {
  option: RankableOption;
  /** Preference fit score from the rules engine (higher = better fit). */
  score: number;
  /** Why this fits, in traveler language — fit inputs only. */
  reasons: string[];
  /** Where it cuts against a stated preference. */
  against: string[];
  /** Rule labels — non-empty only on the relaxed path. */
  violations: RuleViolation[];
}

export interface CasualtyOption {
  option: RankableOption;
  violations: RuleViolation[];
}

export interface RankedSet {
  ranked: RankedOption[];
  casualties: CasualtyOption[];
  /** True when every option broke a rule and `ranked` is least-violating, labeled. */
  relaxed: boolean;
}

/** Project a WanderOption onto the rules engine's normalized shape. */
export function toNormalizedOption(option: RankableOption): NormalizedOption {
  const s = option.summary;
  return {
    kind: "flight",
    label: s.label,
    fareClass: s.fareClass ?? undefined,
    changeable: s.changeable,
    connectionAirports: s.connectionAirports,
    priceMinor: option.money.amountMinor,
    currency: option.money.currency,
  };
}

function fitReasons(
  option: RankableOption,
  kept: RankableOption[],
): { reasons: string[] } {
  const reasons: string[] = [];
  const sameCurrency = kept.filter((o) => o.money.currency === option.money.currency);
  if (sameCurrency.length > 1) {
    const cheapest = Math.min(...sameCurrency.map((o) => o.money.amountMinor));
    if (option.money.amountMinor === cheapest) {
      reasons.push("Cheapest option that fits your rules");
    }
  }
  const durations = kept
    .map((o) => o.summary.totalDurationMinutes)
    .filter((d): d is number => d !== null);
  if (option.summary.totalDurationMinutes !== null && durations.length > 1) {
    if (option.summary.totalDurationMinutes === Math.min(...durations)) {
      reasons.push("Fastest option");
    }
  }
  return { reasons };
}

/**
 * Filter (hard rules) then rank (preferences + price/time fit) an option
 * set. Deterministic: preference score desc, then price asc within the
 * same currency, then duration asc, then adapter order. Cross-currency
 * prices are NEVER compared — conversion is a display act, not a
 * ranking act.
 */
export function rankOptionSet(
  options: readonly RankableOption[],
  rules: readonly RuleInput[],
  tripScope?: TripScope,
): RankedSet {
  const normalized = options.map(toNormalizedOption);
  const { kept, casualties, relaxed } = applyHardRules(rules, normalized, tripScope);
  const keptOptions = kept.map((j) => options[normalized.indexOf(j.option)]);
  const scored = kept.map((j, i) => {
    const option = keptOptions[i];
    const s = scoreOption(rules, j.option, tripScope);
    return { option, score: s.score, prefReasons: s.reasons, against: s.against, violations: j.violations };
  });
  const decorated = scored.map((entry, index) => ({
    ...entry,
    reasons: [...entry.prefReasons, ...fitReasons(entry.option, keptOptions).reasons],
    index,
  }));
  decorated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.option.money.currency === b.option.money.currency) {
      if (a.option.money.amountMinor !== b.option.money.amountMinor) {
        return a.option.money.amountMinor - b.option.money.amountMinor;
      }
    }
    const da = a.option.summary.totalDurationMinutes ?? Number.MAX_SAFE_INTEGER;
    const db = b.option.summary.totalDurationMinutes ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.index - b.index;
  });
  return {
    ranked: decorated.map(({ option, score, reasons, against, violations }) => ({
      option,
      score,
      reasons,
      against,
      violations,
    })),
    casualties: casualties.map((c) => ({
      option: options[normalized.indexOf(c.option)],
      violations: c.violations,
    })),
    relaxed,
  };
}

// ─── Presentation (§5.5: disclosure is a presentation act) ───────────────────

export interface PresentedOption extends RankedOption {
  option: WanderOption;
  /** "Partner: X" when a commercial relationship exists — display only. */
  disclosure: string | null;
}

export interface PresentedCasualty {
  option: WanderOption;
  violations: RuleViolation[];
}

/**
 * Re-attach partner metadata AFTER ordering and build disclosure labels.
 * Ordering is an input here, never an output: this function cannot
 * reorder, only annotate.
 */
export function presentRankedSet(
  rankedSet: RankedSet,
  partnerByOptionId: ReadonlyMap<string, PartnerRef | null>,
): { options: PresentedOption[]; casualties: PresentedCasualty[] } {
  const reattach = (option: RankableOption): WanderOption => ({
    ...option,
    partner: partnerByOptionId.get(option.id) ?? null,
  });
  return {
    options: rankedSet.ranked.map((r) => {
      const option = reattach(r.option);
      return {
        ...r,
        option,
        disclosure: option.partner ? `Partner: ${option.partner.name}` : null,
      };
    }),
    casualties: rankedSet.casualties.map((c) => ({
      option: reattach(c.option),
      violations: c.violations,
    })),
  };
}

// ─── OptionSet (what the service returns, what Marco voices) ─────────────────

export interface OptionSet {
  kind: OptionKind;
  options: PresentedOption[];
  casualties: PresentedCasualty[];
  relaxed: boolean;
  pricedAt: string;
  fromCache: boolean;
  stale: boolean;
  staleness: string;
  adapterId: string;
  /** Plain-language caveats (stale fallback, partial results…). */
  notices: string[];
}

/** Format a money value for voicing ("$612.00", "€563.04"). */
export function voiceMoney(m: Money): string {
  return formatMoney(m, "en-US");
}
