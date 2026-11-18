/**
 * Options Service — orchestration (architecture §5.1, §8).
 *
 * options.ts is the pure core (shape, cache, ranking, FX math); this
 * module wires it to the world: the traveler's rules from the Context
 * store, their home currency, FX snapshots from the DB, and the
 * provider adapters. The flow for every search:
 *
 *   cache (shared, parameter-keyed) → adapter (on miss / stale / refresh)
 *   → home equivalents (snapshot-backed only) → hard-rule FILTER →
 *   preference RANK (partner-stripped) → presentation (partner labels
 *   re-attached after ordering).
 *
 * Refresh triggers are exactly §8's: view-if-stale, parameter change
 * (a different cache key), or an explicit traveler refresh. Nothing
 * here runs on a timer.
 */

import { and, desc, eq } from "drizzle-orm";
import { db, fxRateSnapshotsTable, usersTable } from "@workspace/db";
import {
  attachHomeEquivalents,
  flightCacheKey,
  isStale,
  parseDecimalToRational,
  presentRankedSet,
  rankOptionSet,
  stalenessLabel,
  OptionCache,
  type FlightSearchContext,
  type FxRate,
  type FxRateResolver,
  type OptionSet,
  type OptionsAdapter,
  type PartnerRef,
  type WanderOption,
} from "./options";
import type { RuleInput, TripScope } from "./rulesEngine";
import { listRules, ruleRowToInput } from "./travelerContext";
import { duffelAdapterFromEnv, OptionsAdapterDisabledError } from "./duffel";
import { logger } from "./logger";

export interface OptionsServiceDeps {
  adapters: OptionsAdapter[];
  cache: OptionCache;
  loadRules: (userId: number) => Promise<RuleInput[]>;
  loadHomeCurrency: (userId: number) => Promise<string | null>;
  fxResolver: FxRateResolver;
  now?: () => number;
}

export interface FlightSearchOptions {
  tripScope?: TripScope;
  /** Explicit traveler refresh: bypass the cache and re-price (§8 trigger). */
  refresh?: boolean;
}

export class OptionsService {
  private readonly now: () => number;

  constructor(private readonly deps: OptionsServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private flightAdapter(): OptionsAdapter | undefined {
    return this.deps.adapters.find((a) => a.enabled) ?? this.deps.adapters[0];
  }

  async searchFlights(
    userId: number,
    ctx: FlightSearchContext,
    opts: FlightSearchOptions = {},
  ): Promise<OptionSet> {
    const adapter = this.flightAdapter();
    const nowMs = this.now();
    if (!adapter || !adapter.enabled) {
      return {
        kind: "flight",
        options: [],
        casualties: [],
        relaxed: false,
        pricedAt: new Date(nowMs).toISOString(),
        fromCache: false,
        stale: false,
        staleness: "",
        adapterId: adapter?.id ?? "none",
        notices: [
          adapter?.disabledReason ??
            "No flight provider is configured, so live flight prices are unavailable.",
        ],
      };
    }

    const key = flightCacheKey(ctx);
    const notices: string[] = [];
    let raw: WanderOption[] | null = null;
    let pricedAt = "";
    let fromCache = false;

    const cached = this.deps.cache.get(key);
    if (!opts.refresh && cached?.fresh) {
      raw = cached.options;
      pricedAt = cached.pricedAt;
      fromCache = true;
    } else {
      try {
        raw = await adapter.searchFlights(ctx);
        pricedAt = raw[0]?.pricedAt ?? new Date(nowMs).toISOString();
        this.deps.cache.set(key, raw, pricedAt);
      } catch (err) {
        if (cached) {
          // View-if-stale refresh failed: serve the stale set, labeled —
          // old true numbers beat an error and beat invented ones.
          raw = cached.options;
          pricedAt = cached.pricedAt;
          fromCache = true;
          notices.push("Couldn't refresh prices just now — showing the last prices we fetched.");
          logger.warn({ adapter: adapter.id, err }, "[Options] refresh failed; serving stale cache");
        } else {
          throw err;
        }
      }
    }

    const [rules, homeCurrency] = await Promise.all([
      this.deps.loadRules(userId),
      this.deps.loadHomeCurrency(userId),
    ]);
    const withFx = await attachHomeEquivalents(raw, homeCurrency, this.deps.fxResolver);

    // Ranking purity (§5.5): strip partner BEFORE ranking; re-attach after.
    const partnerById = new Map<string, PartnerRef | null>(withFx.map((o) => [o.id, o.partner]));
    const rankable = withFx.map(({ partner: _partner, ...rest }) => rest);
    const rankedSet = rankOptionSet(rankable, rules, opts.tripScope);
    const presented = presentRankedSet(rankedSet, partnerById);

    const stale = isStale(pricedAt, "flight", nowMs);
    return {
      kind: "flight",
      options: presented.options,
      casualties: presented.casualties,
      relaxed: rankedSet.relaxed,
      pricedAt,
      fromCache,
      stale,
      staleness: stalenessLabel(pricedAt, nowMs),
      adapterId: adapter.id,
      notices,
    };
  }
}

// ─── DB-backed FX resolver ───────────────────────────────────────────────────

/**
 * Latest snapshot for the pair; falls back to the inverse pair (rate
 * inverted exactly, in rational space). Null when neither exists.
 */
export const dbFxRateResolver: FxRateResolver = async (fromCurrency, toCurrency) => {
  const direct = await db
    .select()
    .from(fxRateSnapshotsTable)
    .where(
      and(
        eq(fxRateSnapshotsTable.baseCurrency, fromCurrency),
        eq(fxRateSnapshotsTable.quoteCurrency, toCurrency),
      ),
    )
    .orderBy(desc(fxRateSnapshotsTable.asOf))
    .limit(1);
  const row = direct[0];
  if (row) {
    const rate = parseDecimalToRational(String(row.rate));
    if (rate && rate.num > 0n) {
      return { ...rate, snapshotId: row.id, asOf: row.asOf.toISOString() };
    }
  }
  const inverse = await db
    .select()
    .from(fxRateSnapshotsTable)
    .where(
      and(
        eq(fxRateSnapshotsTable.baseCurrency, toCurrency),
        eq(fxRateSnapshotsTable.quoteCurrency, fromCurrency),
      ),
    )
    .orderBy(desc(fxRateSnapshotsTable.asOf))
    .limit(1);
  const inv = inverse[0];
  if (inv) {
    const rate = parseDecimalToRational(String(inv.rate));
    if (rate && rate.num > 0n) {
      return { num: rate.den, den: rate.num, snapshotId: inv.id, asOf: inv.asOf.toISOString() };
    }
  }
  return null;
};

// ─── Default wiring ──────────────────────────────────────────────────────────

export function createDefaultOptionsService(): OptionsService {
  return new OptionsService({
    adapters: [duffelAdapterFromEnv()],
    cache: new OptionCache(),
    loadRules: async (userId) => (await listRules(userId)).map(ruleRowToInput),
    loadHomeCurrency: async (userId) => {
      const [user] = await db
        .select({ homeCurrency: usersTable.homeCurrency })
        .from(usersTable)
        .where(eq(usersTable.id, userId));
      return user?.homeCurrency ?? null;
    },
    fxResolver: dbFxRateResolver,
  });
}

let defaultService: OptionsService | null = null;

export function getDefaultOptionsService(): OptionsService {
  if (!defaultService) defaultService = createDefaultOptionsService();
  return defaultService;
}

/** Test seam: swap (or clear, with null) the lazily-built default service. */
export function setDefaultOptionsServiceForTests(service: OptionsService | null): void {
  defaultService = service;
}

export { OptionsAdapterDisabledError };
