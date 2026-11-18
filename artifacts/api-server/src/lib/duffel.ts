/**
 * Duffel flights — client + Options Service adapter (api-ecosystem-map:
 * the launch rail; architecture §5.1).
 *
 * Flow: POST /air/offer_requests (slices, passengers, cabin class,
 * max_connections) → the offer request comes back with offers inline.
 * Each offer's `total_amount` is a decimal STRING in `total_currency` —
 * the full total for ALL passengers on the request — and is mapped into
 * the money type with the money package's exact BigInt parsing. No
 * floats ever touch a price.
 *
 * The token comes from `DUFFEL_API_TOKEN`. When it is unset the adapter
 * is DISABLED and says so plainly — the service never fabricates
 * results. All HTTP goes through an injectable fetch so tests run fully
 * mocked; live verification awaits Phil's Packet #1 key provisioning.
 *
 * Search-side only: no orders are created here (the gate is January).
 */

import { fromMajorDecimal } from "@workspace/money";
import type {
  FlightOption,
  FlightSearchContext,
  FlightSliceSummary,
  OptionsAdapter,
  WanderOption,
} from "./options";
import { logger } from "./logger";

const DUFFEL_BASE_URL = "https://api.duffel.com";
const DUFFEL_VERSION = "v2";
const REQUEST_TIMEOUT_MS = 30_000;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ─── Errors ──────────────────────────────────────────────────────────────────

export class DuffelError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DuffelError";
  }
}

export class OptionsAdapterDisabledError extends Error {
  constructor(readonly adapterId: string, reason: string) {
    super(reason);
    this.name = "OptionsAdapterDisabledError";
  }
}

// ─── Duffel payload shapes (documented subset) ───────────────────────────────

export interface DuffelPlace {
  iata_code?: string;
  name?: string;
  city_name?: string;
  time_zone?: string;
}

export interface DuffelSegmentPassenger {
  passenger_id?: string;
  cabin_class?: string;
  cabin_class_marketing_name?: string;
  fare_basis_code?: string;
}

export interface DuffelSegment {
  id?: string;
  origin?: DuffelPlace;
  destination?: DuffelPlace;
  departing_at?: string;
  arriving_at?: string;
  duration?: string;
  marketing_carrier?: { name?: string; iata_code?: string };
  marketing_carrier_flight_number?: string;
  operating_carrier?: { name?: string; iata_code?: string };
  operating_carrier_flight_number?: string;
  passengers?: DuffelSegmentPassenger[];
}

export interface DuffelOfferSlice {
  origin?: DuffelPlace;
  destination?: DuffelPlace;
  duration?: string;
  segments?: DuffelSegment[];
}

export interface DuffelCondition {
  allowed?: boolean;
  penalty_amount?: string;
  penalty_currency?: string;
}

export interface DuffelOffer {
  id?: string;
  total_amount?: string;
  total_currency?: string;
  base_amount?: string;
  tax_amount?: string;
  owner?: { name?: string; iata_code?: string };
  conditions?: {
    change_before_departure?: DuffelCondition | null;
    refund_before_departure?: DuffelCondition | null;
  };
  slices?: DuffelOfferSlice[];
  expires_at?: string;
  created_at?: string;
}

export interface DuffelOfferRequest {
  id?: string;
  created_at?: string;
  offers?: DuffelOffer[];
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface DuffelClient {
  createOfferRequest(ctx: FlightSearchContext): Promise<DuffelOfferRequest>;
}

/** The documented create-offer-request body for a search context. */
export function buildOfferRequestBody(ctx: FlightSearchContext): Record<string, unknown> {
  const slices: Array<Record<string, string>> = [
    { origin: ctx.origin.toUpperCase(), destination: ctx.destination.toUpperCase(), departure_date: ctx.departureDate },
  ];
  if (ctx.returnDate) {
    slices.push({
      origin: ctx.destination.toUpperCase(),
      destination: ctx.origin.toUpperCase(),
      departure_date: ctx.returnDate,
    });
  }
  const data: Record<string, unknown> = {
    slices,
    passengers: Array.from({ length: ctx.passengerCount }, () => ({ type: "adult" })),
  };
  if (ctx.cabinClass) data.cabin_class = ctx.cabinClass;
  if (ctx.maxConnections !== undefined) data.max_connections = ctx.maxConnections;
  return { data };
}

export function createDuffelClient(opts: {
  token: string;
  fetchFn?: FetchFn;
  baseUrl?: string;
}): DuffelClient {
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const baseUrl = opts.baseUrl ?? DUFFEL_BASE_URL;
  return {
    async createOfferRequest(ctx: FlightSearchContext): Promise<DuffelOfferRequest> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchFn(`${baseUrl}/air/offer_requests`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${opts.token}`,
            "Duffel-Version": DUFFEL_VERSION,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(buildOfferRequestBody(ctx)),
          signal: controller.signal,
        });
      } catch (err) {
        throw new DuffelError(
          `Duffel request failed: ${err instanceof Error ? err.message : String(err)}`,
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
      const data = (parsed as { data?: DuffelOfferRequest })?.data;
      if (!data) throw new DuffelError("Duffel response carried no data.", res.status);
      return data;
    },
  };
}

// ─── Mapping: Duffel offer → normalized option (§5.1) ────────────────────────

/** Parse an ISO 8601 duration ("PT7H10M", "P1DT2H30M") to minutes. */
export function parseIsoDurationMinutes(text: string | undefined): number | null {
  if (!text) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(text.trim());
  if (!m) return null;
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3] ?? 0);
  const seconds = Number(m[4] ?? 0);
  return days * 1440 + hours * 60 + minutes + Math.round(seconds / 60);
}

/**
 * Canonicalize a supplier fare label. Airlines name the same product
 * "Basic Economy" and "Economy Basic" interchangeably; the traveler's
 * rule ("never Basic Economy") is about the product, not the string, so
 * the adapter — the normalization layer — canonicalizes it. Anything
 * else passes through trimmed, as the supplier stated it.
 */
export function normalizeFareClass(marketingName: string | null | undefined): string | null {
  if (!marketingName) return null;
  const name = marketingName.trim().replace(/\s+/g, " ");
  if (name === "") return null;
  const lower = name.toLowerCase();
  if (lower.includes("basic") && lower.includes("economy")) return "Basic Economy";
  return name;
}

function minutesBetween(a: string | undefined, b: string | undefined): number | null {
  if (!a || !b) return null;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return Math.round((tb - ta) / 60000);
}

function mapSlice(slice: DuffelOfferSlice): FlightSliceSummary | null {
  const segments = slice.segments ?? [];
  if (segments.length === 0) return null;
  const first = segments[0];
  const last = segments[segments.length - 1];
  const origin = first.origin?.iata_code ?? slice.origin?.iata_code;
  const destination = last.destination?.iata_code ?? slice.destination?.iata_code;
  if (!origin || !destination || !first.departing_at || !last.arriving_at) return null;
  const layovers: Array<{ airport: string; minutes: number }> = [];
  for (let i = 1; i < segments.length; i++) {
    const airport = segments[i].origin?.iata_code ?? "—";
    const minutes = minutesBetween(segments[i - 1].arriving_at, segments[i].departing_at);
    layovers.push({ airport, minutes: minutes ?? 0 });
  }
  const flightNumbers = segments.map((seg) => {
    const carrier = seg.marketing_carrier?.iata_code ?? seg.operating_carrier?.iata_code ?? "";
    const number = seg.marketing_carrier_flight_number ?? seg.operating_carrier_flight_number ?? "";
    return `${carrier}${number}`.trim();
  }).filter((n) => n !== "");
  return {
    origin,
    destination,
    departAt: first.departing_at,
    arriveAt: last.arriving_at,
    stops: segments.length - 1,
    layovers,
    durationMinutes: parseIsoDurationMinutes(slice.duration) ?? minutesBetween(first.departing_at, last.arriving_at),
    flightNumbers,
  };
}

/**
 * Map one Duffel offer to a normalized option. Returns null when the
 * offer cannot be represented exactly (missing/unparseable total) — a
 * price we cannot state exactly is not shown at all.
 */
export function mapDuffelOffer(offer: DuffelOffer, pricedAt: string): FlightOption | null {
  if (!offer.id || !offer.total_amount || !offer.total_currency) return null;
  let total;
  try {
    total = fromMajorDecimal(offer.total_amount, offer.total_currency);
  } catch {
    return null;
  }
  const slices = (offer.slices ?? [])
    .map(mapSlice)
    .filter((s): s is FlightSliceSummary => s !== null);
  if (slices.length === 0) return null;

  const firstSegment = offer.slices?.[0]?.segments?.[0];
  const firstPassenger = firstSegment?.passengers?.[0];
  const fareClass = normalizeFareClass(firstPassenger?.cabin_class_marketing_name);
  const carrier = offer.owner?.name ?? firstSegment?.marketing_carrier?.name ?? "Unknown carrier";
  const carrierCode = offer.owner?.iata_code ?? firstSegment?.marketing_carrier?.iata_code ?? null;
  const connectionAirports = slices.flatMap((s) => s.layovers.map((l) => l.airport));
  const totalDurationMinutes = slices.every((s) => s.durationMinutes !== null)
    ? slices.reduce((acc, s) => acc + (s.durationMinutes ?? 0), 0)
    : null;
  const firstFlight = slices[0].flightNumbers[0];
  const label = [firstFlight, fareClass].filter(Boolean).join(" ") ||
    `${carrier} ${slices[0].origin}→${slices[0].destination}`;

  return {
    id: offer.id,
    kind: "flight",
    adapter: "duffel",
    supplier: carrier,
    summary: {
      carrier,
      carrierCode,
      slices,
      totalDurationMinutes,
      totalStops: slices.reduce((acc, s) => acc + s.stops, 0),
      fareClass,
      cabinClass: firstPassenger?.cabin_class ?? null,
      changeable: offer.conditions?.change_before_departure?.allowed ?? undefined,
      refundable: offer.conditions?.refund_before_departure?.allowed ?? undefined,
      connectionAirports,
      label,
    },
    money: total,
    homeEquivalent: null,
    pricedAt,
    priceNature: "firm",
    fulfillment: "api_rail",
    ruleViolations: [],
    partner: null,
  };
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class DuffelFlightsAdapter implements OptionsAdapter {
  readonly id = "duffel";

  constructor(private readonly client: DuffelClient | null) {}

  get enabled(): boolean {
    return this.client !== null;
  }

  get disabledReason(): string {
    return this.client
      ? ""
      : "Duffel isn't configured (no DUFFEL_API_TOKEN), so live flight prices are unavailable.";
  }

  async searchFlights(ctx: FlightSearchContext): Promise<WanderOption[]> {
    if (!this.client) {
      throw new OptionsAdapterDisabledError(this.id, this.disabledReason);
    }
    const request = await this.client.createOfferRequest(ctx);
    const pricedAt = request.created_at ?? new Date().toISOString();
    const options: WanderOption[] = [];
    let skipped = 0;
    for (const offer of request.offers ?? []) {
      const mapped = mapDuffelOffer(offer, offer.created_at ?? pricedAt);
      if (mapped) options.push(mapped);
      else skipped++;
    }
    if (skipped > 0) {
      logger.warn({ adapter: this.id, skipped }, "[Options] skipped unmappable Duffel offers");
    }
    logger.info(
      { adapter: this.id, origin: ctx.origin, destination: ctx.destination, offers: options.length },
      "[Options] Duffel search complete",
    );
    return options;
  }
}

/** Build the adapter from the environment. No token → disabled adapter. */
export function duffelAdapterFromEnv(fetchFn?: FetchFn): DuffelFlightsAdapter {
  const token = process.env.DUFFEL_API_TOKEN;
  if (!token) return new DuffelFlightsAdapter(null);
  return new DuffelFlightsAdapter(createDuffelClient({ token, fetchFn }));
}
