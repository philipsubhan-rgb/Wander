/**
 * Extras engine — pure logic (architecture-north-star §7; GOAL.md
 * "Extras thinking"; test-cases TC-8).
 *
 * The extras pass is how Wander thinks beyond flights and beds: every
 * itinerary gets a pass keyed to the trip's character, surfacing the
 * ancillary logistics a human planner would raise — ship the clubs,
 * lift passes, eSIMs, cribs — as priced suggestions, never bookings.
 *
 * PRICING HONESTY is the load-bearing rule of this module:
 * - A suggestion carries a number only from a real source: an Options
 *   Service rail (none serve extras items yet in v1 — the seam is the
 *   `rail` provenance in detail_data), or a labeled ESTIMATE computed
 *   from RATE_ASSUMPTIONS below — every assumption named, dated, and
 *   shown in the suggestion's detail with its inputs.
 * - Items whose price genuinely varies by supplier (green fees, boat
 *   charters, resort packages) are quote-only: price_nature 'quote',
 *   NO amount. Note-only items (checks Wander runs: entry
 *   requirements, kid-pass pricing, crib availability) carry neither.
 * - No generator in this module may emit price_nature 'firm'. The
 *   invariant is enforced by assertPricingHonesty and asserted by
 *   tests over every generated fixture.
 *
 * No DB, no I/O: the service (extras.ts) resolves TripFacts, calls
 * generateSuggestions, and persists what comes back.
 */

import { formatMoney } from "@workspace/money";
import type {
  ExtrasPack,
  ExtrasPriceNature,
  ExtrasSuggestionDetailData,
} from "@workspace/db";
import type { TierName } from "./intakeLogic";

// ─── Rate assumptions (the single config table) ──────────────────────────────
//
// Every estimated number in an extras suggestion traces to exactly one
// entry here. Each entry names what the figure is, the class of source
// it was taken from, and the date it was set — when a figure is
// refreshed, update the range AND the asOf date together.

export interface RateAssumption {
  /** What this figure prices, in words. */
  label: string;
  /** The class of published source the range was taken from. */
  basis: string;
  /** Date (YYYY-MM-DD) this range was set/last reviewed. */
  asOf: string;
  currency: "USD";
  /** Billing unit the range applies to, e.g. "per golfer, round trip". */
  unit: string;
  minMinor: number;
  maxMinor: number;
}

export const RATE_ASSUMPTIONS = {
  club_shipping_round_trip: {
    label: "Golf club shipping, round trip",
    basis: "Ship Sticks-class published domestic round-trip rates for a standard golf bag",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per golfer, round trip",
    minMinor: 8900,
    maxMinor: 19900,
  },
  premium_club_rental_day: {
    label: "Premium club rental",
    basis: "Resort premium rental sets (current-model Callaway/TaylorMade) published daily rates",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per golfer, per day",
    minMinor: 5500,
    maxMinor: 8000,
  },
  airline_checked_golf_bag_round_trip: {
    label: "Airline checked golf bag, round trip",
    basis: "Major US carrier standard checked-bag fees each way; a golf bag within weight/size limits travels as a standard checked bag",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per golfer, round trip",
    minMinor: 7000,
    maxMinor: 8000,
  },
  ski_gear_shipping_round_trip: {
    label: "Ski/snowboard gear shipping, round trip",
    basis: "Ship Skis-class published domestic round-trip rates for one ski/board bag",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per skier, round trip",
    minMinor: 9900,
    maxMinor: 22900,
  },
  ski_rental_day: {
    label: "Ski gear rental (skis, boots, poles)",
    basis: "Destination-resort rental shop published daily demo-package rates",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per skier, per day",
    minMinor: 4500,
    maxMinor: 7000,
  },
  lift_pass_day: {
    label: "Lift pass",
    basis: "Major destination resorts published single-day window rates",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per person, per day",
    minMinor: 12000,
    maxMinor: 26000,
  },
  ski_lesson_group: {
    label: "Group ski lesson (half day)",
    basis: "Resort ski-school published group lesson rates",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per person, per session",
    minMinor: 9900,
    maxMinor: 18900,
  },
  caddie_round: {
    label: "Caddie fee",
    basis: "Resort-course published caddie fees per bag per round, before gratuity",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per bag, per round",
    minMinor: 7000,
    maxMinor: 13000,
  },
  beach_cabana_day: {
    label: "Beach cabana / gear rental",
    basis: "Resort and beach-club published daily cabana rates",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per cabana, per day",
    minMinor: 7500,
    maxMinor: 25000,
  },
  grocery_prestock_service: {
    label: "Grocery pre-stocking service fee",
    basis: "Vacation-home grocery delivery services' published service fees (groceries themselves extra, at cost)",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per stay",
    minMinor: 3500,
    maxMinor: 7500,
  },
  car_seat_rental_day: {
    label: "Rental-car child seat add-on",
    basis: "Major rental-car brands' published child-seat daily add-on rates",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per seat, per day",
    minMinor: 1000,
    maxMinor: 1500,
  },
  esim_trip: {
    label: "Travel eSIM data plan",
    basis: "Airalo-class published regional eSIM plans, one trip's typical data",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per traveler, per trip",
    minMinor: 900,
    maxMinor: 2900,
  },
  adapter_kit: {
    label: "Plug adapter / converter kit",
    basis: "Retail price of a universal adapter kit",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per group, one-time",
    minMinor: 1500,
    maxMinor: 2500,
  },
  skip_the_line_pass: {
    label: "Skip-the-line / fast-track pass",
    basis: "Headline-attraction published fast-track ticket premiums over standard admission",
    asOf: "2026-11-18",
    currency: "USD",
    unit: "per person",
    minMinor: 2900,
    maxMinor: 8900,
  },
} as const satisfies Record<string, RateAssumption>;

export type RateAssumptionKey = keyof typeof RATE_ASSUMPTIONS;

// ─── Trip facts (resolved by the service, consumed pure) ─────────────────────

export interface TripFacts {
  tripId: number;
  /** trips.destination plus the intake destination text, when known. */
  destinationText: string;
  /** Intake STYLE slot text ("golf trip with the guys"), when known. */
  styleText: string | null;
  tier: TierName;
  budgetCap: { amountMinor: number; currency: string } | null;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
  /** Inclusive trip length in days, at least 1. */
  tripDays: number;
  participantCount: number;
  flightCount: number;
  /** IATA codes of every flight airport on the trip (departures + arrivals). */
  flightAirports: string[];
  hasStay: boolean;
  /** Any accommodation of type 'airbnb' — a whole home, not a hotel. */
  hasHomeStay: boolean;
  hasCarRental: boolean;
}

export function tripDaysBetween(startDate: string, endDate: string): number {
  const s = Date.parse(`${startDate}T12:00:00Z`);
  const e = Date.parse(`${endDate}T12:00:00Z`);
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return 1;
  return Math.round((e - s) / 86400000) + 1;
}

// ─── Character matching ──────────────────────────────────────────────────────

const PACK_KEYWORDS: Array<{ pack: ExtrasPack; pattern: RegExp }> = [
  { pack: "golf", pattern: /\bgolf/i },
  { pack: "ski", pattern: /\bski(?:ing)?\b|\bsnowboard/i },
  { pack: "beach", pattern: /\bbeach\b|\bisland\b|\bcaribbean\b|\bseaside\b/i },
  { pack: "family", pattern: /\bfamily\b|\bkids?\b|\bchildren\b|\btoddler/i },
  { pack: "festival", pattern: /\bfestival\b|\boktoberfest\b|\bconcert\b|\bchristmas markets?\b|\bfair\b/i },
];

/** Well-known non-US hub airport codes (v1 heuristic set). A flight
 * touching one of these makes the trip international for a US-home
 * traveler base; the country-name list below catches the rest. */
const NON_US_HUBS = new Set([
  "LHR", "LGW", "CDG", "ORY", "FRA", "MUC", "BER", "HAM", "AMS", "BRU",
  "ZRH", "VIE", "MAD", "BCN", "LIS", "FCO", "MXP", "ATH", "CPH", "ARN",
  "OSL", "HEL", "KEF", "DUB", "WAW", "PRG", "BUD", "NRT", "HND", "ICN",
  "PEK", "PVG", "HKG", "SIN", "BKK", "DEL", "BOM", "BLR", "DXB", "DOH",
  "IST", "TLV", "JNB", "CPT", "SYD", "MEL", "AKL", "GRU", "EZE", "SCL",
  "LIM", "BOG", "MEX", "CUN", "YYZ", "YVR", "YUL", "PUJ", "MBJ", "NAS",
  "SJO", "PTY",
]);

const NON_US_COUNTRY_OR_CITY =
  /\b(germany|munich|berlin|france|paris|italy|rome|venice|spain|madrid|barcelona|portugal|lisbon|england|london|scotland|ireland|dublin|netherlands|amsterdam|belgium|brussels|switzerland|zurich|austria|vienna|greece|athens|denmark|copenhagen|sweden|stockholm|norway|oslo|finland|helsinki|iceland|reykjavik|poland|warsaw|czech|prague|hungary|budapest|japan|tokyo|korea|seoul|china|beijing|shanghai|hong kong|singapore|thailand|bangkok|india|delhi|mumbai|bangalore|dubai|qatar|doha|turkey|istanbul|israel|egypt|cairo|south africa|cape town|australia|sydney|melbourne|new zealand|auckland|brazil|argentina|chile|peru|colombia|mexico|cancun|canada|toronto|vancouver|montreal|dominican|jamaica|bahamas|costa rica|panama|europe|caribbean)\b/i;

/** International = the trip crosses a border from the (US) home base:
 * a non-US hub on any flight, or a foreign country/city named in the
 * destination or style text. Heuristic by design in v1 — it only ever
 * ADDS suggestions (eSIM, adapters, entry check), never gates money. */
export function detectInternational(facts: TripFacts): boolean {
  if (facts.flightAirports.some((code) => NON_US_HUBS.has(code.toUpperCase()))) return true;
  const text = `${facts.destinationText} ${facts.styleText ?? ""}`;
  return NON_US_COUNTRY_OR_CITY.test(text);
}

/** Which packs apply to this trip's character. Order is stable:
 * golf, ski, beach, family, international, festival. */
export function matchPacks(facts: TripFacts): ExtrasPack[] {
  const text = `${facts.styleText ?? ""} ${facts.destinationText}`;
  const packs: ExtrasPack[] = [];
  for (const { pack, pattern } of PACK_KEYWORDS) {
    if (pattern.test(text)) packs.push(pack);
  }
  if (detectInternational(facts) && !packs.includes("international")) {
    // Keep the canonical order: international sits before festival.
    const festivalIdx = packs.indexOf("festival");
    if (festivalIdx >= 0) packs.splice(festivalIdx, 0, "international");
    else packs.push("international");
  }
  return packs;
}

// ─── Generated suggestions ───────────────────────────────────────────────────

export interface GeneratedSuggestion {
  pack: ExtrasPack;
  itemKey: string;
  title: string;
  detail: string;
  detailData: ExtrasSuggestionDetailData;
  priceAmountMinor: number | null;
  priceCurrency: string | null;
  priceNature: ExtrasPriceNature | null;
}

function fmt(minor: number, currency: string): string {
  return formatMoney({ amountMinor: minor, currency }, "en-US");
}

function fmtRange(min: number, max: number, currency: string): string {
  return min === max ? fmt(min, currency) : `${fmt(min, currency)}–${fmt(max, currency)}`;
}

interface EstimateSpec {
  assumption: RateAssumptionKey;
  quantity: number;
  quantityLabel: string; // "4 golfers × 5 days"
}

/** Build an estimate-priced suggestion from one labeled assumption. */
function estimate(
  base: Omit<GeneratedSuggestion, "priceAmountMinor" | "priceCurrency" | "priceNature" | "detailData"> & {
    detailData?: ExtrasSuggestionDetailData;
  },
  spec: EstimateSpec,
  detailSuffix: string,
): GeneratedSuggestion {
  const a = RATE_ASSUMPTIONS[spec.assumption];
  const min = a.minMinor * spec.quantity;
  const max = a.maxMinor * spec.quantity;
  const mid = Math.round((min + max) / 2);
  const detail =
    `${base.detail} Estimate: ${fmtRange(min, max, a.currency)} ` +
    `(${spec.quantityLabel} at ${fmtRange(a.minMinor, a.maxMinor, a.currency)} ${a.unit}). ` +
    `Basis: ${a.basis} (rates as of ${a.asOf}).${detailSuffix ? ` ${detailSuffix}` : ""}`;
  return {
    ...base,
    detail,
    detailData: {
      ...(base.detailData ?? {}),
      assumptions: [spec.assumption],
      facts: { ...(base.detailData?.facts ?? {}), quantity: spec.quantity },
    },
    priceAmountMinor: mid,
    priceCurrency: a.currency,
    priceNature: "estimate",
  };
}

function quoteOnly(
  base: Omit<GeneratedSuggestion, "priceAmountMinor" | "priceCurrency" | "priceNature">,
): GeneratedSuggestion {
  return {
    ...base,
    detail: `${base.detail} Price is quote-only — it depends on the supplier, so no number is shown until a real quote comes back.`,
    priceAmountMinor: null,
    priceCurrency: null,
    priceNature: "quote",
  };
}

function noteOnly(
  base: Omit<GeneratedSuggestion, "priceAmountMinor" | "priceCurrency" | "priceNature">,
): GeneratedSuggestion {
  return { ...base, priceAmountMinor: null, priceCurrency: null, priceNature: null };
}

// ─── Golf pack ───────────────────────────────────────────────────────────────

function golfClubShipping(facts: TripFacts): GeneratedSuggestion {
  const golfers = Math.max(1, facts.participantCount);
  const days = facts.tripDays;
  const ship = RATE_ASSUMPTIONS.club_shipping_round_trip;
  const rent = RATE_ASSUMPTIONS.premium_club_rental_day;
  const check = RATE_ASSUMPTIONS.airline_checked_golf_bag_round_trip;
  const lines = [
    { label: "Ship your clubs (door-to-door, insured)", a: ship, qty: golfers },
    { label: "Rent premium clubs at the destination", a: rent, qty: golfers * days },
    { label: "Check them as baggage on your flights", a: check, qty: golfers },
  ].map(({ label, a, qty }) => ({
    label,
    totalMinor: Math.round(((a.minMinor + a.maxMinor) / 2) * qty),
    rangeMinor: { min: a.minMinor * qty, max: a.maxMinor * qty },
    currency: a.currency,
  }));
  const cheapest = lines.reduce((best, l) => (l.totalMinor < best.totalMinor ? l : best), lines[0]);
  const mathText = lines
    .map((l) => `${l.label}: ${fmtRange(l.rangeMinor.min, l.rangeMinor.max, l.currency)}`)
    .join(" · ");
  const detail =
    `For ${golfers} golfer${golfers === 1 ? "" : "s"} over ${days} day${days === 1 ? "" : "s"}: ${mathText}. ` +
    `On these numbers ${cheapest.label.toLowerCase()} comes out lowest. ` +
    `Checking is fee-cheap but your clubs travel as standard baggage — a damaged shaft or a bag that misses day one is the real cost, and shipping needs lead time, so decide before your flights are final. ` +
    `The priced option below is shipping; shipping and rental confirm exact prices at booking.`;
  const priced = estimate(
    {
      pack: "golf",
      itemKey: "club_shipping",
      title: "Ship your clubs instead of hauling them",
      detail,
      detailData: { math: lines, facts: { golfers, days } },
    },
    { assumption: "club_shipping_round_trip", quantity: golfers, quantityLabel: `${golfers} golfer${golfers === 1 ? "" : "s"}` },
    "",
  );
  // The math above rests on all three assumptions, not just shipping's.
  priced.detailData = {
    ...priced.detailData,
    assumptions: ["club_shipping_round_trip", "premium_club_rental_day", "airline_checked_golf_bag_round_trip"],
    math: lines,
  };
  return priced;
}

function golfPack(facts: TripFacts): GeneratedSuggestion[] {
  const golfers = Math.max(1, facts.participantCount);
  const days = facts.tripDays;
  const out: GeneratedSuggestion[] = [golfClubShipping(facts)];
  out.push(
    quoteOnly({
      pack: "golf",
      itemKey: "tee_times",
      title: "Book tee times before they fill",
      detail:
        `Destination courses release their best tee times weeks out, and many pro shops take bookings by phone only. ` +
        `Wander can line up ${days} day${days === 1 ? "" : "s"} of tee times for ${golfers} golfer${golfers === 1 ? "" : "s"} once you pick courses.`,
      detailData: { facts: { golfers, days } },
    }),
  );
  const foursomes = Math.max(1, Math.ceil(golfers / 4));
  out.push(
    estimate(
      {
        pack: "golf",
        itemKey: "caddie",
        title: "Add a caddie",
        detail:
          `A local caddie reads greens you'd otherwise guess at — worth it on an unfamiliar resort course. ` +
          `Priced per bag per round, one caddie per foursome, gratuity extra.`,
        detailData: { facts: { golfers, rounds: days, foursomes } },
      },
      {
        assumption: "caddie_round",
        quantity: foursomes * days,
        quantityLabel: `${foursomes} caddie${foursomes === 1 ? "" : "s"} × ${days} round${days === 1 ? "" : "s"}`,
      },
      "",
    ),
  );
  out.push(
    quoteOnly({
      pack: "golf",
      itemKey: "resort_packages",
      title: "Compare a resort golf package vs à la carte",
      detail:
        `Resorts at golf destinations often bundle room + rounds + rentals for less than the pieces bought separately — or quietly charge more for the bundle. ` +
        `Wander can price both ways before you commit to either.`,
      detailData: { facts: { golfers, days } },
    }),
  );
  return out;
}

// ─── Ski pack ────────────────────────────────────────────────────────────────

function skiPack(facts: TripFacts): GeneratedSuggestion[] {
  const skiers = Math.max(1, facts.participantCount);
  const days = facts.tripDays;
  const ship = RATE_ASSUMPTIONS.ski_gear_shipping_round_trip;
  const rent = RATE_ASSUMPTIONS.ski_rental_day;
  const shipRange = { min: ship.minMinor * skiers, max: ship.maxMinor * skiers };
  const rentRange = { min: rent.minMinor * skiers * days, max: rent.maxMinor * skiers * days };
  const gear = estimate(
    {
      pack: "ski",
      itemKey: "gear_logistics",
      title: "Ship your ski gear, or rent at the resort",
      detail:
        `Two honest options for ${skiers} skier${skiers === 1 ? "" : "s"} over ${days} day${days === 1 ? "" : "s"}: ` +
        `ship your own gear round trip for ${fmtRange(shipRange.min, shipRange.max, ship.currency)}, or rent demo gear at the resort for ${fmtRange(rentRange.min, rentRange.max, rent.currency)}. ` +
        `Shipping keeps your own boots (the part that actually matters); renting skips the haul and the airline's oversize-bag roulette.`,
      detailData: {
        math: [
          { label: "Ship your gear", totalMinor: Math.round((shipRange.min + shipRange.max) / 2), rangeMinor: shipRange, currency: ship.currency },
          { label: "Rent at the resort", totalMinor: Math.round((rentRange.min + rentRange.max) / 2), rangeMinor: rentRange, currency: rent.currency },
        ],
        facts: { skiers, days },
      },
    },
    { assumption: "ski_gear_shipping_round_trip", quantity: skiers, quantityLabel: `${skiers} skier${skiers === 1 ? "" : "s"}` },
    "",
  );
  gear.detailData = {
    assumptions: ["ski_gear_shipping_round_trip", "ski_rental_day"],
    math: gear.detailData.math,
    facts: { skiers, days },
  };
  return [
    gear,
    estimate(
      {
        pack: "ski",
        itemKey: "lift_passes",
        title: "Sort lift passes before you go",
        detail:
          `Window-rate lift passes are the most expensive way to ski — buying ahead, or a multi-day pass, usually beats day-by-day at the window. ` +
          `Altitude note: if the destination sits high, plan a gentle first day.`,
        detailData: { facts: { skiers, days } },
      },
      { assumption: "lift_pass_day", quantity: skiers * days, quantityLabel: `${skiers} skier${skiers === 1 ? "" : "s"} × ${days} day${days === 1 ? "" : "s"}` },
      "",
    ),
    estimate(
      {
        pack: "ski",
        itemKey: "lessons",
        title: "Book a lesson session",
        detail:
          `One half-day group session early in the trip pays for itself in confidence for the rest of it — ski school books out on peak weeks.`,
        detailData: { facts: { skiers } },
      },
      { assumption: "ski_lesson_group", quantity: skiers, quantityLabel: `${skiers} skier${skiers === 1 ? "" : "s"}` },
      "",
    ),
  ];
}

// ─── Beach pack ──────────────────────────────────────────────────────────────

function beachPack(facts: TripFacts): GeneratedSuggestion[] {
  const days = facts.tripDays;
  const out: GeneratedSuggestion[] = [
    estimate(
      {
        pack: "beach",
        itemKey: "cabana_gear",
        title: "Reserve a cabana / beach gear",
        detail:
          `The good cabanas and front-row gear go to whoever reserved first — on arrival day they're simply gone.`,
        detailData: { facts: { days } },
      },
      { assumption: "beach_cabana_day", quantity: days, quantityLabel: `${days} day${days === 1 ? "" : "s"}` },
      "",
    ),
    quoteOnly({
      pack: "beach",
      itemKey: "boat_day",
      title: "Price a boat day",
      detail:
        `A half- or full-day boat is usually the best day of a beach trip — snorkeling stops, a sandbar, lunch aboard. ` +
        `Pricing depends on the boat and the group size, so it comes back as a quote.`,
      detailData: { facts: { participants: facts.participantCount } },
    }),
  ];
  if (facts.hasHomeStay) {
    out.push(
      estimate(
        {
          pack: "beach",
          itemKey: "grocery_prestock",
          title: "Pre-stock the house before you land",
          detail:
            `You're staying in a home, not a hotel — have the fridge stocked (breakfast basics, drinks, first-night dinner) before you arrive instead of spending day one in a supermarket. ` +
            `The fee below is the service; the groceries themselves are at cost.`,
          detailData: { facts: { days } },
        },
        { assumption: "grocery_prestock_service", quantity: 1, quantityLabel: "one stay" },
        "",
      ),
    );
  }
  return out;
}

// ─── Family pack ─────────────────────────────────────────────────────────────

function familyPack(facts: TripFacts): GeneratedSuggestion[] {
  const out: GeneratedSuggestion[] = [];
  if (facts.hasStay) {
    out.push(
      noteOnly({
        pack: "family",
        itemKey: "crib_highchair",
        title: "Confirm a crib and high chair at the stay",
        detail:
          `Most hotels and many homes provide a crib and high chair free — but only if they're asked before arrival. ` +
          `Wander checks with the stay and records the answer, so you're not improvising at midnight check-in.`,
        detailData: { facts: {} },
      }),
    );
  }
  if (facts.hasCarRental) {
    out.push(
      estimate(
        {
          pack: "family",
          itemKey: "car_seats",
          title: "Add child seats to the rental car",
          detail:
            `Rental counters charge per seat per day, and airline-checked seats get banged around — for a short trip the rental add-on is usually the sane choice. ` +
            `Priced for one seat; tell Wander if you need more.`,
          detailData: { facts: { days: facts.tripDays } },
        },
        { assumption: "car_seat_rental_day", quantity: facts.tripDays, quantityLabel: `${facts.tripDays} day${facts.tripDays === 1 ? "" : "s"} × 1 seat` },
        "",
      ),
    );
  }
  out.push(
    noteOnly({
      pack: "family",
      itemKey: "kid_pass_pricing",
      title: "Check kid pricing before adult tickets are quoted",
      detail:
        `Many attractions, passes, and tours price children free or at a steep discount — but only when the booking asks. ` +
        `Wander checks kid-pass pricing on every ticketed item for this trip before quoting adult prices.`,
      detailData: { facts: {} },
    }),
  );
  return out;
}

// ─── International pack ──────────────────────────────────────────────────────

function internationalPack(facts: TripFacts): GeneratedSuggestion[] {
  const travelers = Math.max(1, facts.participantCount);
  return [
    noteOnly({
      pack: "international",
      itemKey: "entry_requirements",
      title: "Check entry requirements now, not at the airport",
      detail:
        `Passport validity windows, visas, and entry forms for ${facts.destinationText} get checked at planning time — ` +
        `some destinations require six months of passport validity beyond your return date, and discovering that at check-in ends the trip.`,
      detailData: { facts: { destination: facts.destinationText } },
    }),
    estimate(
      {
        pack: "international",
        itemKey: "esim",
        title: "Set up an eSIM for each traveler",
        detail:
          `A travel eSIM lands you with data the moment the plane doors open — maps, rides, translation — at a fraction of carrier roaming.`,
        detailData: { facts: { travelers } },
      },
      { assumption: "esim_trip", quantity: travelers, quantityLabel: `${travelers} traveler${travelers === 1 ? "" : "s"}` },
      "",
    ),
    estimate(
      {
        pack: "international",
        itemKey: "adapters",
        title: "Pack the right plug adapters",
        detail:
          `One universal adapter kit covers the group's chargers — cheaper than the airport shop's emergency version of the same thing.`,
        detailData: { facts: {} },
      },
      { assumption: "adapter_kit", quantity: 1, quantityLabel: "one kit" },
      "",
    ),
  ];
}

// ─── Festival / event pack ───────────────────────────────────────────────────

function festivalPack(facts: TripFacts): GeneratedSuggestion[] {
  const people = Math.max(1, facts.participantCount);
  return [
    estimate(
      {
        pack: "festival",
        itemKey: "skip_the_line",
        title: "Get skip-the-line access for the headline sights",
        detail:
          `During a festival the queues are the trip's hidden tax — fast-track entry buys back hours for the event itself.`,
        detailData: { facts: { people } },
      },
      { assumption: "skip_the_line_pass", quantity: people, quantityLabel: `${people} ${people === 1 ? "person" : "people"}` },
      "",
    ),
    quoteOnly({
      pack: "festival",
      itemKey: "event_transfers",
      title: "Line up event-day transfers",
      detail:
        `Getting a group to and from the venue at peak time is the piece that strands people — pre-booked transfers or a car service sized to the group fix it. ` +
        `Wander also flags surge pricing and crowd pressure around the event dates when it prices the rest of the trip.`,
      detailData: { facts: { people } },
    }),
  ];
}

// ─── The pass ────────────────────────────────────────────────────────────────

const PACK_GENERATORS: Record<ExtrasPack, (facts: TripFacts) => GeneratedSuggestion[]> = {
  golf: golfPack,
  ski: skiPack,
  beach: beachPack,
  family: familyPack,
  international: internationalPack,
  festival: festivalPack,
};

/** Generate every suggestion the matched packs produce for these facts.
 * Unmatched character → no packs → no suggestions. */
export function generateSuggestions(facts: TripFacts): GeneratedSuggestion[] {
  return matchPacks(facts).flatMap((pack) => PACK_GENERATORS[pack](facts));
}

// ─── Pricing honesty invariant ───────────────────────────────────────────────

/**
 * The honesty contract, checkable: a price exists only with an explicit
 * nature; a 'firm' price exists only with Options Service provenance
 * (detail_data.rail) — never from a rate assumption; an estimate must
 * name its assumptions; a quote carries no amount.
 */
export function pricingHonestyProblems(s: GeneratedSuggestion): string[] {
  const problems: string[] = [];
  if (s.priceAmountMinor !== null && s.priceNature === null) {
    problems.push(`${s.itemKey}: price without a price_nature`);
  }
  if (s.priceNature === "quote" && s.priceAmountMinor !== null) {
    problems.push(`${s.itemKey}: quote-only item carries an amount`);
  }
  if (s.priceNature === "firm" && !s.detailData.rail) {
    problems.push(`${s.itemKey}: firm price without an Options Service rail provenance`);
  }
  if (s.priceNature === "estimate") {
    const assumptions = s.detailData.assumptions ?? [];
    if (assumptions.length === 0) {
      problems.push(`${s.itemKey}: estimate without named rate assumptions`);
    }
    for (const key of assumptions) {
      if (!(key in RATE_ASSUMPTIONS)) problems.push(`${s.itemKey}: unknown rate assumption "${key}"`);
    }
  }
  if (s.priceAmountMinor !== null && (!Number.isInteger(s.priceAmountMinor) || s.priceAmountMinor <= 0)) {
    problems.push(`${s.itemKey}: price is not a positive integer of minor units`);
  }
  return problems;
}

export function assertPricingHonesty(suggestions: GeneratedSuggestion[]): void {
  const problems = suggestions.flatMap(pricingHonestyProblems);
  if (problems.length > 0) {
    throw new Error(`Extras pricing honesty violated: ${problems.join("; ")}`);
  }
}

// ─── Budget reporting (Family Budget framing) ────────────────────────────────

export interface ExtrasBudgetReport {
  cap: { amountMinor: number; currency: string };
  /** Sum of priced suggestions (suggested + accepted) in the cap's
   * currency, estimates at their stored midpoint. */
  pricedTotalMinor: number;
  pricedItemCount: number;
  /** Quote-only / note-only items: real costs the total cannot see. */
  unpricedItemCount: number;
  overCap: boolean;
  remainingMinor: number;
}

export interface PricedLike {
  priceAmountMinor: number | null;
  priceCurrency: string | null;
  state: string;
}

/** Running extras total against the cap. Cross-currency prices are
 * never silently converted — they count as unpriced for this report
 * (the international rule: no silent FX). */
export function buildBudgetReport(
  cap: { amountMinor: number; currency: string },
  items: PricedLike[],
): ExtrasBudgetReport {
  let pricedTotalMinor = 0;
  let pricedItemCount = 0;
  let unpricedItemCount = 0;
  for (const item of items) {
    if (item.state === "dismissed") continue;
    if (item.priceAmountMinor !== null && item.priceCurrency === cap.currency) {
      pricedTotalMinor += item.priceAmountMinor;
      pricedItemCount += 1;
    } else {
      unpricedItemCount += 1;
    }
  }
  return {
    cap,
    pricedTotalMinor,
    pricedItemCount,
    unpricedItemCount,
    overCap: pricedTotalMinor > cap.amountMinor,
    remainingMinor: cap.amountMinor - pricedTotalMinor,
  };
}
