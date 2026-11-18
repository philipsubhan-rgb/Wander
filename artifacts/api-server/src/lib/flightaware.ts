/**
 * FlightAware AeroAPI — client for the watching pipeline
 * (architecture-north-star §6, international-foundation §4).
 *
 * Alerts-first, never polling (§8): this client exposes exactly the
 * three operations the pipeline needs —
 *   1. `GET /flights/{ident}` — the single scheduled T-24h lookup per
 *      leg (§8.3.1), and nothing else reads flight status on a timer;
 *   2. `POST /alerts` / `DELETE /alerts/{id}` — alert registration and
 *      deregistration; FlightAware PUSHES events to our webhook as they
 *      happen, which is both cheaper (~$0.02/delivered alert vs polling
 *      economics, international §4.3) and the only real-time tier in the
 *      design.
 *
 * The API key comes from `FLIGHTAWARE_API_KEY` (sent as the documented
 * `x-apikey` header to aeroapi.flightaware.com/aeroapi). When it is
 * unset the client is DISABLED and callers say so plainly — no fake
 * statuses are ever fabricated. All HTTP goes through an injectable
 * fetch so tests run fully mocked; live verification awaits Phil's
 * Packet #1 key provisioning.
 *
 * Payload shapes below are the documented AeroAPI subset (flight object
 * + alert endpoints, per FlightAware's published OpenAPI description).
 * Alert creation additionally requires an account delivery endpoint
 * (PUT /alerts/endpoint) or a per-alert `target_url` — provisioning is
 * an account step at key setup, surfaced via `setAlertEndpoint`.
 */

import type { FlightStatusSnapshot } from "@workspace/db";

const AEROAPI_BASE_URL = "https://aeroapi.flightaware.com/aeroapi";
const REQUEST_TIMEOUT_MS = 30_000;

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

// ─── Errors ──────────────────────────────────────────────────────────────────

export class FlightAwareError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FlightAwareError";
  }
}

export class FlightAwareDisabledError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "FlightAwareDisabledError";
  }
}

export const FLIGHTAWARE_DISABLED_REASON =
  "FlightAware isn't configured (no FLIGHTAWARE_API_KEY), so live flight status is unavailable.";

// ─── AeroAPI payload shapes (documented subset) ──────────────────────────────

export interface AeroAirport {
  code?: string;
  code_iata?: string;
  code_icao?: string;
  timezone?: string;
  name?: string;
  city?: string;
}

export interface AeroFlight {
  ident?: string;
  fa_flight_id?: string;
  operator?: string;
  operator_iata?: string;
  flight_number?: string;
  status?: string;
  cancelled?: boolean;
  diverted?: boolean;
  blocked?: boolean;
  origin?: AeroAirport;
  destination?: AeroAirport;
  scheduled_out?: string | null;
  estimated_out?: string | null;
  actual_out?: string | null;
  scheduled_off?: string | null;
  estimated_off?: string | null;
  actual_off?: string | null;
  scheduled_on?: string | null;
  estimated_on?: string | null;
  actual_on?: string | null;
  scheduled_in?: string | null;
  estimated_in?: string | null;
  actual_in?: string | null;
  gate_origin?: string | null;
  gate_destination?: string | null;
  terminal_origin?: string | null;
  terminal_destination?: string | null;
  /** Seconds late departing / arriving (provider-computed). */
  departure_delay?: number | null;
  arrival_delay?: number | null;
}

/** Alert events Wander subscribes to (documented AeroAPI event names). */
export const AERO_ALERT_EVENTS = {
  filed: true,
  departure: true,
  arrival: true,
  cancelled: true,
  diverted: true,
  change: true,
} as const;

/**
 * The pushed alert delivery body (documented subset): FlightAware POSTs
 * this to the alert's target URL when an event fires. Deliveries are not
 * signed — provenance is proven with a secret token in the URL or a
 * shared-secret header, never assumed (see routes/watching.ts).
 */
export interface AeroAlertPayload {
  alert_id?: number | string;
  event_code?: string;
  long_description?: string;
  short_description?: string;
  summary?: string;
  flight?: AeroFlight;
}

export interface CreateAlertInput {
  ident: string;
  origin: string;
  destination: string;
  /** ISO date/datetime window the alert is active for. */
  start: string;
  end: string;
  targetUrl?: string;
}

// ─── Ident construction ──────────────────────────────────────────────────────

/**
 * Build the AeroAPI ident for a legacy flight row. Stored flight numbers
 * carry the IATA designator ("UA30", "LH441" — see the timeline builder
 * and the Munich seed), and AeroAPI accepts IATA designators for both
 * lookups and alert registration. Returns null when the stored number
 * has no parseable designator — the caller records the watch locally
 * and skips provider registration rather than guessing an ident.
 */
export function buildFlightIdent(flight: { flightNumber: string }): string | null {
  const compact = flight.flightNumber.replace(/\s+/g, "").toUpperCase();
  return /^[A-Z0-9]{2,3}\d{1,4}[A-Z]?$/.test(compact) ? compact : null;
}

// ─── Normalization: AeroAPI flight → status snapshot ─────────────────────────

function minutesBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60000);
}

/**
 * Normalize a documented AeroAPI flight object into the stored snapshot
 * shape. Delay math prefers the flight's own estimated/actual times
 * against its own scheduled times (self-consistent); the provider's
 * `arrival_delay` seconds are only a fallback when times are missing.
 */
export function normalizeFlightStatus(
  flight: AeroFlight,
  source: "alert" | "lookup",
  observedAt: string = new Date().toISOString(),
): FlightStatusSnapshot {
  const scheduledIn = flight.scheduled_in ?? null;
  const estimatedIn = flight.estimated_in ?? null;
  const actualIn = flight.actual_in ?? null;
  const scheduledOut = flight.scheduled_out ?? null;
  const estimatedOut = flight.estimated_out ?? null;
  const actualOut = flight.actual_out ?? null;

  let arrivalDelay = minutesBetween(scheduledIn, actualIn ?? estimatedIn);
  if (arrivalDelay === null && typeof flight.arrival_delay === "number") {
    arrivalDelay = Math.round(flight.arrival_delay / 60);
  }
  let departureDelay = minutesBetween(scheduledOut, actualOut ?? estimatedOut);
  if (departureDelay === null && typeof flight.departure_delay === "number") {
    departureDelay = Math.round(flight.departure_delay / 60);
  }

  const statusText = (flight.status ?? "").toLowerCase();
  return {
    faFlightId: flight.fa_flight_id ?? null,
    status: flight.status ?? null,
    cancelled: flight.cancelled === true || statusText.startsWith("cancelled"),
    diverted: flight.diverted === true || statusText.includes("diverted"),
    scheduledOut,
    estimatedOut,
    actualOut,
    scheduledIn,
    estimatedIn,
    actualIn,
    gateOrigin: flight.gate_origin ?? null,
    gateDestination: flight.gate_destination ?? null,
    terminalOrigin: flight.terminal_origin ?? null,
    terminalDestination: flight.terminal_destination ?? null,
    arrivalDelayMinutes: arrivalDelay,
    departureDelayMinutes: departureDelay,
    source,
    observedAt,
  };
}

// ─── Client ──────────────────────────────────────────────────────────────────

export interface FlightAwareClient {
  /** GET /flights/{ident} over a start/end window (ISO datetimes). */
  getFlightsByIdent(
    ident: string,
    window: { start: string; end: string },
  ): Promise<AeroFlight[]>;
  /** GET /flights/{fa_flight_id} — the stable per-operation lookup. */
  getFlightByFaFlightId(faFlightId: string): Promise<AeroFlight | null>;
  /** POST /alerts — returns the provider's alert registration id. */
  createAlert(input: CreateAlertInput): Promise<{ alertId: string }>;
  /** DELETE /alerts/{id}. A 404 (already gone) is success. */
  deleteAlert(alertId: string): Promise<void>;
  /** PUT /alerts/endpoint — the one-time account delivery-endpoint setup. */
  setAlertEndpoint(url: string): Promise<void>;
}

/** The documented create-alert body for a watch registration. */
export function buildCreateAlertBody(input: CreateAlertInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ident: input.ident,
    origin: input.origin,
    destination: input.destination,
    start: input.start,
    end: input.end,
    max_weekly: 1000,
    events: { ...AERO_ALERT_EVENTS },
  };
  if (input.targetUrl) body.target_url = input.targetUrl;
  return body;
}

export function createFlightAwareClient(opts: {
  apiKey: string;
  fetchFn?: FetchFn;
  baseUrl?: string;
}): FlightAwareClient {
  const fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
  const baseUrl = opts.baseUrl ?? AEROAPI_BASE_URL;

  async function request(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ status: number; json: Record<string, unknown> | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetchFn(`${baseUrl}${path}`, {
        method,
        headers: {
          "x-apikey": opts.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json; charset=UTF-8",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new FlightAwareError(
        `FlightAware request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    if (text.trim() !== "") {
      try {
        json = JSON.parse(text) as Record<string, unknown>;
      } catch {
        if (!res.ok) {
          throw new FlightAwareError(
            `FlightAware returned a non-JSON response (HTTP ${res.status}).`,
            res.status,
          );
        }
      }
    }
    if (!res.ok) {
      const title = typeof json?.title === "string" ? json.title : null;
      const detail = typeof json?.detail === "string" ? json.detail : null;
      throw new FlightAwareError(
        `FlightAware error (HTTP ${res.status}): ${detail ?? title ?? "unknown error"}`,
        res.status,
      );
    }
    return { status: res.status, json };
  }

  return {
    async getFlightsByIdent(ident, window) {
      const qs = new URLSearchParams({
        ident_type: "designator",
        start: window.start,
        end: window.end,
        max_pages: "1",
      });
      const { json } = await request(
        "GET",
        `/flights/${encodeURIComponent(ident)}?${qs.toString()}`,
      );
      const flights = (json as { flights?: AeroFlight[] } | null)?.flights;
      return Array.isArray(flights) ? flights : [];
    },

    async getFlightByFaFlightId(faFlightId) {
      const { json } = await request("GET", `/flights/${encodeURIComponent(faFlightId)}`);
      const flights = (json as { flights?: AeroFlight[] } | null)?.flights;
      return Array.isArray(flights) && flights.length > 0 ? flights[0] : null;
    },

    async createAlert(input) {
      const { json } = await request("POST", "/alerts", buildCreateAlertBody(input));
      const raw = (json as { alert_id?: unknown; id?: unknown } | null) ?? {};
      const alertId = raw.alert_id ?? raw.id;
      if (alertId === undefined || alertId === null || alertId === "") {
        throw new FlightAwareError("FlightAware alert creation returned no alert_id.");
      }
      return { alertId: String(alertId) };
    },

    async deleteAlert(alertId) {
      try {
        await request("DELETE", `/alerts/${encodeURIComponent(alertId)}`);
      } catch (err) {
        // Already deregistered provider-side is the desired end state.
        if (err instanceof FlightAwareError && err.status === 404) return;
        throw err;
      }
    },

    async setAlertEndpoint(url) {
      await request("PUT", "/alerts/endpoint", { url });
    },
  };
}

/** Build the client from the environment. No key → null (disabled). */
export function flightAwareClientFromEnv(fetchFn?: FetchFn): FlightAwareClient | null {
  const apiKey = process.env.FLIGHTAWARE_API_KEY;
  if (!apiKey) return null;
  return createFlightAwareClient({ apiKey, fetchFn });
}

/** Guard used by service code paths that require the live provider. */
export function requireFlightAwareClient(
  client: FlightAwareClient | null,
): FlightAwareClient {
  if (!client) throw new FlightAwareDisabledError(FLIGHTAWARE_DISABLED_REASON);
  return client;
}
