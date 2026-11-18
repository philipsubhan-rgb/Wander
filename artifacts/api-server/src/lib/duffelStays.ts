/**
 * Duffel Stays — client + Options Service adapter (api-ecosystem-map:
 * 1.5M+ properties on the same Duffel rail as flights; architecture
 * §5.1 — stays are another adapter behind the same interface).
 *
 * SPIKE, mocked: Stays is NOT enabled on a Duffel account by default —
 * it must be requested per account. Live verification therefore awaits
 * BOTH Phil's Duffel key AND the per-account Stays enablement request
 * (both Packet #1 items). Until then this adapter is built and tested
 * entirely against Duffel's documented payload shapes; with no token
 * it is disabled and says so plainly, exactly like the flights adapter.
 *
 * Flow (Duffel's documented stays flow): POST /stays/search with
 * coordinates + radius, dates, guests, rooms — the response carries
 * one result per property with a `cheapest_rate_total_amount`: the
 * FULL-STAY total for the whole party and the whole stay, as a decimal
 * string in the supplier's currency. That total is the option's money
 * — never a nightly rate dressed as a total. Per-night and
 * per-person-per-night figures are derived display, computed in exact
 * integer minor units and labeled as derived at presentation. A quote
 * re-prices before booking (Duffel's own flow), so search prices are
 * `estimate`, unlike flights' firm offers.
 *
 * Itemization (Story 2.1): when rates are fetched, the cheapest rate
 * states base / tax / fee and any amount due at the property — those
 * are carried through as stated. When only a base is stated, taxes &
 * fees are shown COMBINED (total − base), never split by invention.
 * Money exactness is identical to flights: decimal strings parsed via
 * the money package's BigInt path, supplier currency untouched.
 */

import {
  fromMajorDecimal,
  money,
  subtract,
  type Money,
} from "@workspace/money";
import type {
  StayOption,
  StayRateBreakdown,
  StaySearchContext,
  OptionsAdapter,
  WanderOption,
} from "./options";
import { nightsBetween } from "./options";
import { DuffelError, OptionsAdapterDisabledError, type FetchFn } from "./duffel";
import { logger } from "./logger";

const DUFFEL_BASE_URL = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";
const REQUEST_TIMEOUT_MS = 30_000;

// ─── Duffel payload shapes (documented subset) ───────────────────────────────

export interface DuffelStayRate {
  id?: string;
  total_amount?: string;
  total_currency?: string;
  base_amount?: string;
  base_currency?: string;
  tax_amount?: string;
  tax_currency?: string;
  fee_amount?: string;
  fee_currency?: string;
  due_at_accommodation_amount?: string;
  due_at_accommodation_currency?: string;
  board_type?: string;
  cancellation_timeline?: Array<{
    refund_amount?: string;
    currency?: string;
    before?: string;
  }>;
}

export interface DuffelStayRoom {
  name?: string;
  beds?: Array<{ type?: string; count?: number }> | null;
  rates?: DuffelStayRate[];
}

export interface DuffelStayAccommodation {
  id?: string;
  type?: string;
  name?: string;
  rating?: number;
  review_score?: number;
  review_count?: number;
  chain?: { id?: string; name?: string } | null;
  location?: {
    address?: {
      city_name?: string;
      region?: string;
      country_code?: string;
      line_one?: string;
      postal_code?: string;
    };
  };
  rooms?: DuffelStayRoom[];
}

export interface DuffelStayResult {
  id?: string;
  rooms?: number;
  check_in_date?: string;
  check_out_date?: string;
  cheapest_rate_total_amount?: string;
  cheapest_rate_currency?: string;
  cheapest_rate_base_amount?: string;
  cheapest_rate_base_currency?: string;
  cheapest_rate_due_at_accommodation_amount?: string;
  cheapest_rate_due_at_accommodation_currency?: string;
  accommodation?: DuffelStayAccommodation;
}

export interface DuffelStaySearchResponse {
  created_at?: string;
  results?: DuffelStayResult[];
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface DuffelStaysClient {
  searchStays(ctx: StaySearchContext): Promise<DuffelStaySearchResponse>;
}

/** The documented /stays/search body for a search context. */
export function buildStaySearchBody(ctx: StaySearchContext): Record<string, unknown> {
  const data: Record<string, unknown> = {
    rooms: ctx.rooms,
    location: {
      radius: ctx.radiusKm,
      geographic_coordinates: { latitude: ctx.latitude, longitude: ctx.longitude },
    },
    guests: Array.from({ length: ctx.guestCount }, () => ({ type: "adult" })),
    check_in_date: ctx.checkInDate,
    check_out_date: ctx.checkOutDate,
    // Fetch rates so the cheapest rate's base/tax/fee split and
    // cancellation timeline are available for itemization (Story 2.1).
    accommodation: { fetch_rates: true },
  };
  if (ctx.freeCancellationOnly) data.free_cancellation_only = true;
  return { data };
}

export interface DuffelStaysClientOptions {
  /** The Duffel API credential (DUFFEL_API_TOKEN). */
  token: string;
  fetchFn?: FetchFn;
  baseUrl?: string;
}

export function createDuffelStaysClient(opts: DuffelStaysClientOptions): DuffelStaysClient {
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const baseUrl = opts.baseUrl ?? DUFFEL_BASE_URL;
  return {
    async searchStays(ctx: StaySearchContext): Promise<DuffelStaySearchResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const authValue = "Bearer " + opts.token;
      let res: Response;
      try {
        res = await fetchFn(`${baseUrl}/stays/search`, {
          method: "POST",
          headers: {
            Authorization: authValue,
            "Duffel-Version": DUFFEL_VERSION,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(buildStaySearchBody(ctx)),
          signal: controller.signal,
        });
      } catch (err) {
        throw new DuffelError(
          `Duffel Stays request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        clearTimeout(timer);
      }
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new DuffelError(`Duffel returned a non-JSON response (HTTP ${res.status}).`, res.status);
      }
      if (!res.ok) {
        const errors = (parsed as { errors?: Array<{ title?: string; detail?: string }> })?.errors;
        const first = errors?.[0];
        const detail = first?.detail ?? first?.title ?? "unknown error";
        throw new DuffelError(`Duffel error (HTTP ${res.status}): ${detail}`, res.status);
      }
      const data = (parsed as { data?: DuffelStaySearchResponse })?.data;
      if (!data) throw new DuffelError("Duffel Stays response carried no data.", res.status);
      return data;
    },
  };
}

// ─── Mapping: Duffel stay result → normalized option (§5.1) ──────────────────

/** Property types that are a whole home/unit rather than a room in one. */
const WHOLE_HOME_TYPES = new Set([
  "home",
  "house",
  "apartment",
  "villa",
  "holiday_home",
  "vacation_rental",
  "cottage",
  "chalet",
  "townhouse",
]);

/** Parse a payload amount; null unless it parses AND is in `currency`. */
function parseInCurrency(
  amount: string | undefined,
  amountCurrency: string | undefined,
  currency: string,
): Money | null {
  if (!amount || (amountCurrency && amountCurrency !== currency)) return null;
  try {
    return fromMajorDecimal(amount, currency);
  } catch {
    return null;
  }
}

/** Exact minor-unit division with half-up rounding (derived display). */
function divideMoney(m: Money, divisor: number): Money | null {
  if (!Number.isInteger(divisor) || divisor <= 0) return null;
  const q = Math.floor(m.amountMinor / divisor);
  const r = m.amountMinor % divisor;
  return money(r * 2 >= divisor ? q + 1 : q, m.currency);
}

function bedsText(room: DuffelStayRoom | undefined): string | null {
  if (!room?.beds || !Array.isArray(room.beds) || room.beds.length === 0) return null;
  const parts = room.beds
    .filter((b) => b?.type)
    .map((b) => `${b.count && b.count > 1 ? `${b.count} ` : ""}${b.type} bed${b.count && b.count > 1 ? "s" : ""}`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function cancellationFromTimeline(
  rate: DuffelStayRate | undefined,
  total: Money,
): { terms: string | null; free: boolean } {
  const timeline = rate?.cancellation_timeline;
  if (!timeline || timeline.length === 0) return { terms: null, free: false };
  const entries = timeline
    .map((e) => ({
      refund: parseInCurrency(e.refund_amount, e.currency, total.currency),
      before: e.before,
    }))
    .filter((e): e is { refund: Money; before: string } => e.refund !== null && !!e.before);
  if (entries.length === 0) return { terms: null, free: false };
  const fullRefund = entries.find((e) => e.refund.amountMinor >= total.amountMinor);
  if (fullRefund) {
    return { terms: `Free cancellation until ${fullRefund.before.slice(0, 10)}`, free: true };
  }
  const best = entries.reduce((a, b) => (b.refund.amountMinor > a.refund.amountMinor ? b : a));
  if (best.refund.amountMinor > 0) {
    return {
      terms: `Partial refund if cancelled before ${best.before.slice(0, 10)}`,
      free: false,
    };
  }
  return { terms: "Non-refundable rate", free: false };
}

/**
 * Map one Duffel stay result to a normalized option. Returns null when
 * the result cannot be represented exactly (missing/unparseable total,
 * no property identity) — a price we cannot state exactly is not shown
 * at all.
 */
export function mapDuffelStayResult(
  result: DuffelStayResult,
  ctx: StaySearchContext,
  pricedAt: string,
): StayOption | null {
  if (!result.id || !result.cheapest_rate_total_amount || !result.cheapest_rate_currency) {
    return null;
  }
  const accommodation = result.accommodation;
  if (!accommodation?.name) return null;
  let total: Money;
  try {
    total = fromMajorDecimal(result.cheapest_rate_total_amount, result.cheapest_rate_currency);
  } catch {
    return null;
  }
  const currency = total.currency;

  // The cheapest rate's detail (base/tax/fee split, cancellation
  // timeline, board) — the rate whose total IS the result's total.
  let detailRate: DuffelStayRate | undefined;
  let detailRoom: DuffelStayRoom | undefined;
  for (const room of accommodation.rooms ?? []) {
    for (const rate of room.rates ?? []) {
      const rateTotal = parseInCurrency(rate.total_amount, rate.total_currency, currency);
      if (rateTotal && rateTotal.amountMinor === total.amountMinor) {
        detailRate = rate;
        detailRoom = room;
        break;
      }
    }
    if (detailRate) break;
  }

  // Itemization — payload-stated figures only, all in the total's
  // currency. If a full base+tax+fee split is stated but doesn't sum
  // to the total, the split is not trusted: fall back to base-only.
  const base =
    parseInCurrency(detailRate?.base_amount, detailRate?.base_currency, currency) ??
    parseInCurrency(result.cheapest_rate_base_amount, result.cheapest_rate_base_currency, currency);
  let tax = parseInCurrency(detailRate?.tax_amount, detailRate?.tax_currency, currency);
  let fee = parseInCurrency(detailRate?.fee_amount, detailRate?.fee_currency, currency);
  // The split is shown only when it is COMPLETE and sums to the total.
  // Anything less (a missing component, a mismatch) falls back to the
  // combined taxes-&-fees remainder — a partial split presented as the
  // whole story would misstate the price.
  const fullSplit =
    !!base && !!tax && !!fee &&
    base.amountMinor + tax.amountMinor + fee.amountMinor === total.amountMinor;
  if (!fullSplit) {
    tax = null;
    fee = null;
  }
  const taxesAndFees = base && !fullSplit ? subtract(total, base) : null;
  const dueRaw =
    parseInCurrency(
      detailRate?.due_at_accommodation_amount,
      detailRate?.due_at_accommodation_currency,
      currency,
    ) ??
    parseInCurrency(
      result.cheapest_rate_due_at_accommodation_amount,
      result.cheapest_rate_due_at_accommodation_currency,
      currency,
    );
  const breakdown: StayRateBreakdown = {
    base,
    tax,
    fee,
    taxesAndFees: taxesAndFees && taxesAndFees.amountMinor > 0 ? taxesAndFees : null,
    dueAtAccommodation: dueRaw && dueRaw.amountMinor > 0 ? dueRaw : null,
  };

  const checkInDate = result.check_in_date ?? ctx.checkInDate;
  const checkOutDate = result.check_out_date ?? ctx.checkOutDate;
  const nights = nightsBetween(checkInDate, checkOutDate) ?? 0;
  const guestCount = ctx.guestCount;
  const nightlyRate = nights > 0 ? divideMoney(total, nights) : null;
  const perPersonPerNight =
    nights > 0 && guestCount > 1 ? divideMoney(total, nights * guestCount) : null;

  const propertyType = (accommodation.type ?? "hotel").trim().toLowerCase();
  const isWholeHome = WHOLE_HOME_TYPES.has(propertyType.replace(/\s+/g, "_"));
  const chainName = accommodation.chain?.name ?? null;
  // stayStyle canonicalization (adapter = normalization layer, same
  // discipline as fare canonicalization): chain brand stated → chain;
  // whole home → home; otherwise an independent hotel-style property.
  const stayStyle = chainName ? "chain" : isWholeHome ? "home" : "boutique";

  const address = accommodation.location?.address;
  const cityName = address?.city_name ?? null;
  const areaLabel =
    [cityName, address?.region ?? address?.country_code].filter(Boolean).join(", ") || "Location not stated";

  const { terms: cancellationTerms, free: freeCancellation } = cancellationFromTimeline(detailRate, total);
  const boardType = detailRate?.board_type
    ? detailRate.board_type.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
    : null;

  const option: StayOption = {
    id: result.id,
    kind: "stay",
    adapter: "duffel",
    supplier: chainName ?? accommodation.name,
    summary: {
      propertyName: accommodation.name,
      propertyType,
      stayStyle,
      isWholeHome,
      chainName,
      cityName,
      areaLabel,
      starRating: typeof accommodation.rating === "number" ? accommodation.rating : null,
      reviewScore: typeof accommodation.review_score === "number" ? accommodation.review_score : null,
      reviewCount: typeof accommodation.review_count === "number" ? accommodation.review_count : null,
      roomName: detailRoom?.name ?? null,
      beds: bedsText(detailRoom),
      checkInDate,
      checkOutDate,
      nights,
      guestCount,
      rooms: result.rooms ?? ctx.rooms,
      breakdown,
      nightlyRate,
      perPersonPerNight,
      cancellationTerms,
      freeCancellation,
      boardType,
      label: cityName ? `${accommodation.name}, ${cityName}` : accommodation.name,
    },
    money: total,
    homeEquivalent: null,
    pricedAt,
    // A stays search price is an indication: Duffel's flow re-prices
    // via a quote before booking, so it is never labeled firm.
    priceNature: "estimate",
    fulfillment: "api_rail",
    ruleViolations: [],
    partner: null,
  };
  return option;
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class DuffelStaysAdapter implements OptionsAdapter {
  readonly id = "duffel";

  constructor(private readonly client: DuffelStaysClient | null) {}

  get enabled(): boolean {
    return this.client !== null;
  }

  get disabledReason(): string {
    return this.client
      ? ""
      : "Duffel isn't configured (no DUFFEL_API_TOKEN), so live stay prices are unavailable.";
  }

  async searchStays(ctx: StaySearchContext): Promise<WanderOption[]> {
    if (!this.client) {
      throw new OptionsAdapterDisabledError(this.id, this.disabledReason);
    }
    const response = await this.client.searchStays(ctx);
    const pricedAt = response.created_at ?? new Date().toISOString();
    const options: WanderOption[] = [];
    let skipped = 0;
    for (const result of response.results ?? []) {
      const mapped = mapDuffelStayResult(result, ctx, pricedAt);
      if (mapped) options.push(mapped);
      else skipped++;
    }
    if (skipped > 0) {
      logger.warn({ adapter: this.id, skipped }, "[Options] skipped unmappable Duffel stay results");
    }
    logger.info(
      { adapter: this.id, checkInDate: ctx.checkInDate, checkOutDate: ctx.checkOutDate, stays: options.length },
      "[Options] Duffel Stays search complete",
    );
    return options;
  }
}

/**
 * Build the stays adapter from the environment. Same token discipline
 * as flights: no DUFFEL_API_TOKEN → disabled adapter. NOTE: a token
 * alone is not sufficient live — Stays must also be enabled on the
 * Duffel account (per-account request, Packet #1); until it is, the
 * API rejects stays calls and the error surfaces plainly.
 */
export function duffelStaysAdapterFromEnv(fetchFn?: FetchFn): DuffelStaysAdapter {
  const token = process.env.DUFFEL_API_TOKEN;
  if (!token) return new DuffelStaysAdapter(null);
  return new DuffelStaysAdapter(createDuffelStaysClient({ token, fetchFn }));
}
