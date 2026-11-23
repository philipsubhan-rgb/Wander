/**
 * Pricing display summaries for flight and stay cards.
 *
 * Pure functions over the fields the API already returns (flights:
 * totalPrice / currency / fareBrand / refundable / changeable /
 * checkedBags / passengerCount; stays: nightlyRate / totalPrice /
 * currency / checkIn / checkOut). Nothing here invents data: every
 * string is either a field the API sent or arithmetic on those fields
 * (per-person split, night count). The stays schema has no rent /
 * fees / taxes split, so no breakdown is ever fabricated — the total
 * is shown as the total.
 */
import { formatMoney } from "@workspace/flight-time";

// ─── Flights ────────────────────────────────────────────────────────────────

export interface FlightPricingInput {
  totalPrice?: string | number | null;
  currency?: string | null;
  fareBrand?: string | null;
  refundable?: boolean | null;
  changeable?: boolean | null;
  checkedBags?: string | null;
  passengerCount?: number | null;
}

export interface FlightPricingSummary {
  /** Formatted total for all passengers, e.g. "$1,286.26". */
  total: string | null;
  /** Caption under the total, e.g. "Total for 2 passengers" / "Total". */
  totalCaption: string | null;
  /** Per-person split, only when total + passengerCount > 1 are known. */
  perPerson: string | null;
  fareBrand: string | null;
  /** Fare terms in display order: refundability, changeability, bags. */
  terms: string[];
  /** True when there is anything worth rendering. */
  hasPricing: boolean;
}

/** Display fraction digits for a currency (JPY 0, USD 2, BHD 3…). */
function currencyFractionDigits(currency?: string | null): number {
  if (!currency) return 2;
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency,
      }).resolvedOptions().maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

function parseAmount(amount: string | number | null | undefined): number | null {
  if (amount === null || amount === undefined || amount === "") return null;
  const n = typeof amount === "number" ? amount : Number(amount);
  return Number.isFinite(n) ? n : null;
}

export function summarizeFlightPricing(flight: FlightPricingInput): FlightPricingSummary {
  const total = formatMoney(flight.totalPrice, flight.currency);
  const pax = flight.passengerCount ?? null;

  let perPerson: string | null = null;
  const rawTotal = parseAmount(flight.totalPrice);
  if (rawTotal !== null && pax !== null && pax > 1) {
    const split = rawTotal / pax;
    perPerson = formatMoney(split, flight.currency);
    // A split that doesn't multiply back to the exact total at the
    // currency's display precision is a derived convenience figure —
    // mark it approximate so it never reads as exact (QA nit, Nov 22).
    const digits = currencyFractionDigits(flight.currency);
    const rounded = Number(split.toFixed(digits));
    if (Math.abs(rounded * pax - rawTotal) > 1e-9) {
      perPerson = `≈ ${perPerson}`;
    }
  }

  const terms: string[] = [];
  if (flight.refundable === true) terms.push("Refundable");
  else if (flight.refundable === false) terms.push("Non-refundable");
  if (flight.changeable === true) terms.push("Changeable");
  else if (flight.changeable === false) terms.push("Non-changeable");
  if (flight.checkedBags) terms.push(flight.checkedBags);

  const fareBrand = flight.fareBrand?.trim() ? flight.fareBrand.trim() : null;

  return {
    total,
    totalCaption: total
      ? pax && pax > 0
        ? `Total for ${pax} ${pax === 1 ? "passenger" : "passengers"}`
        : "Total"
      : null,
    perPerson,
    fareBrand,
    terms,
    hasPricing: total !== null || fareBrand !== null || terms.length > 0,
  };
}

// ─── Stays ──────────────────────────────────────────────────────────────────

export interface StayPricingInput {
  nightlyRate?: string | number | null;
  totalPrice?: string | number | null;
  currency?: string | null;
  checkIn?: string | null;
  checkOut?: string | null;
}

export interface StayPricingSummary {
  /** Formatted full-stay total, e.g. "$2,250.00". */
  total: string | null;
  /** Formatted nightly rate, e.g. "$450.00". */
  nightly: string | null;
  /** Whole nights between the check-in and check-out dates. */
  nights: number | null;
  /** The figure the card leads with: total when known, else nightly. */
  primary: string | null;
  /** Caption for the primary figure: "Total" or "Per night". */
  primaryCaption: string | null;
  /**
   * Secondary context line, e.g. "$450.00 per night · 5 nights".
   * Rate and nights are stated as separate facts — never multiplied
   * out, since a stored total may include taxes/fees the schema
   * doesn't itemise.
   */
  detailLine: string | null;
  hasPricing: boolean;
}

/**
 * Nights between two stored stay dates. Uses the leading YYYY-MM-DD
 * of each value (the app's wall-clock convention) so the count never
 * shifts with the viewer's timezone.
 */
export function nightsBetween(checkIn?: string | null, checkOut?: string | null): number | null {
  const dayMs = 86_400_000;
  const parseDay = (v?: string | null): number | null => {
    if (!v) return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
    if (!m) return null;
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isFinite(t) ? t : null;
  };
  const start = parseDay(checkIn);
  const end = parseDay(checkOut);
  if (start === null || end === null) return null;
  const nights = Math.round((end - start) / dayMs);
  return nights > 0 ? nights : null;
}

export function summarizeStayPricing(stay: StayPricingInput): StayPricingSummary {
  const total = formatMoney(stay.totalPrice, stay.currency);
  const nightly = formatMoney(stay.nightlyRate, stay.currency);
  const nights = nightsBetween(stay.checkIn, stay.checkOut);

  const primary = total ?? nightly;
  const primaryCaption = total ? "Total for the stay" : nightly ? "Per night" : null;

  // Detail line: facts not already carried by the primary figure.
  const detailParts: string[] = [];
  if (total && nightly) detailParts.push(`${nightly} per night`);
  if (nights !== null) detailParts.push(`${nights} ${nights === 1 ? "night" : "nights"}`);
  const detailLine = detailParts.length > 0 ? detailParts.join(" · ") : null;

  return {
    total,
    nightly,
    nights,
    primary,
    primaryCaption,
    detailLine,
    hasPricing: total !== null || nightly !== null,
  };
}
