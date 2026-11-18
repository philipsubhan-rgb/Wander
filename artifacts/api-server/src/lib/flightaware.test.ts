/**
 * FlightAware AeroAPI client — fully mocked HTTP. Covers ident
 * construction from legacy flight rows, the documented request shapes
 * (x-apikey header, alert body), flight → snapshot normalization with
 * exact delay math, and the disabled path (no FLIGHTAWARE_API_KEY →
 * no client, never fabricated data). Live verification awaits Phil's
 * Packet #1 key provisioning.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  FlightAwareError,
  buildCreateAlertBody,
  buildFlightIdent,
  createFlightAwareClient,
  flightAwareClientFromEnv,
  normalizeFlightStatus,
  type AeroFlight,
  type FetchFn,
} from "./flightaware.js";

function aeroFlight(overrides: Partial<AeroFlight> = {}): AeroFlight {
  return {
    ident: "UA30",
    fa_flight_id: "UAL30-1695124800-airline-1234",
    operator_iata: "UA",
    flight_number: "30",
    status: "Scheduled / On Time",
    cancelled: false,
    diverted: false,
    origin: { code_iata: "EWR", timezone: "America/New_York" },
    destination: { code_iata: "MUC", timezone: "Europe/Berlin" },
    scheduled_out: "2026-09-23T17:00:00-04:00",
    estimated_out: "2026-09-23T17:00:00-04:00",
    actual_out: null,
    scheduled_in: "2026-09-24T07:10:00+02:00",
    estimated_in: "2026-09-24T07:10:00+02:00",
    actual_in: null,
    gate_origin: "C120",
    gate_destination: null,
    terminal_origin: "C",
    terminal_destination: null,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("buildFlightIdent", () => {
  it("uses the stored designator as-is", () => {
    expect(buildFlightIdent({ flightNumber: "UA30" })).toBe("UA30");
    expect(buildFlightIdent({ flightNumber: "LH441" })).toBe("LH441");
  });

  it("normalizes case and whitespace", () => {
    expect(buildFlightIdent({ flightNumber: "ua 31" })).toBe("UA31");
  });

  it("returns null when no designator is parseable", () => {
    expect(buildFlightIdent({ flightNumber: "United 30" })).toBeNull();
    expect(buildFlightIdent({ flightNumber: "" })).toBeNull();
    expect(buildFlightIdent({ flightNumber: "30" })).toBeNull();
  });
});

describe("normalizeFlightStatus", () => {
  it("maps an on-time flight with zero delays", () => {
    const snap = normalizeFlightStatus(aeroFlight(), "alert", "2026-09-20T00:00:00Z");
    expect(snap.faFlightId).toBe("UAL30-1695124800-airline-1234");
    expect(snap.cancelled).toBe(false);
    expect(snap.diverted).toBe(false);
    expect(snap.arrivalDelayMinutes).toBe(0);
    expect(snap.departureDelayMinutes).toBe(0);
    expect(snap.gateOrigin).toBe("C120");
    expect(snap.source).toBe("alert");
  });

  it("computes arrival delay from estimated vs scheduled in", () => {
    const snap = normalizeFlightStatus(
      aeroFlight({ estimated_in: "2026-09-24T09:25:00+02:00" }),
      "alert",
    );
    expect(snap.arrivalDelayMinutes).toBe(135);
  });

  it("prefers actual times over estimates once they exist", () => {
    const snap = normalizeFlightStatus(
      aeroFlight({
        estimated_in: "2026-09-24T09:25:00+02:00",
        actual_in: "2026-09-24T09:05:00+02:00",
      }),
      "lookup",
    );
    expect(snap.arrivalDelayMinutes).toBe(115);
  });

  it("falls back to the provider's arrival_delay seconds when times are missing", () => {
    const snap = normalizeFlightStatus(
      aeroFlight({ scheduled_in: null, estimated_in: null, arrival_delay: 2700 }),
      "alert",
    );
    expect(snap.arrivalDelayMinutes).toBe(45);
  });

  it("detects cancellation from the flag and from status text", () => {
    expect(normalizeFlightStatus(aeroFlight({ cancelled: true }), "alert").cancelled).toBe(true);
    expect(
      normalizeFlightStatus(aeroFlight({ status: "Cancelled" }), "alert").cancelled,
    ).toBe(true);
  });

  it("detects diversion", () => {
    expect(normalizeFlightStatus(aeroFlight({ diverted: true }), "alert").diverted).toBe(true);
  });
});

describe("createFlightAwareClient", () => {
  it("looks flights up by ident with the x-apikey header and window params", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ flights: [aeroFlight()] });
    };
    const client = createFlightAwareClient({ apiKey: "test-key", fetchFn });
    const flights = await client.getFlightsByIdent("UA30", {
      start: "2026-09-23T00:00:00Z",
      end: "2026-09-25T00:00:00Z",
    });
    expect(flights).toHaveLength(1);
    expect(calls[0].url).toContain("/aeroapi/flights/UA30");
    expect(calls[0].url).toContain("ident_type=designator");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["x-apikey"]).toBe("test-key");
  });

  it("creates an alert and returns the registration id as a string", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ alert_id: 987654 });
    };
    const client = createFlightAwareClient({ apiKey: "k", fetchFn });
    const { alertId } = await client.createAlert({
      ident: "UA30",
      origin: "EWR",
      destination: "MUC",
      start: "2026-09-23T00:00:00Z",
      end: "2026-09-26T00:00:00Z",
      targetUrl: "https://example.test/api/webhooks/flightaware?secret=s",
    });
    expect(alertId).toBe("987654");
    expect(calls[0].url).toContain("/aeroapi/alerts");
    expect(calls[0].init?.method).toBe("POST");
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body.ident).toBe("UA30");
    expect(body.target_url).toContain("secret=s");
  });

  it("builds the documented alert body (events, max_weekly, window)", () => {
    const body = buildCreateAlertBody({
      ident: "UA30",
      origin: "EWR",
      destination: "MUC",
      start: "2026-09-23T00:00:00Z",
      end: "2026-09-26T00:00:00Z",
    });
    expect(body.events).toMatchObject({ filed: true, departure: true, arrival: true, cancelled: true, diverted: true, change: true });
    expect(body.max_weekly).toBe(1000);
    expect(body.target_url).toBeUndefined();
  });

  it("tolerates a 404 on delete (already deregistered) but surfaces other errors", async () => {
    const notFound: FetchFn = async () => jsonResponse({ title: "Not Found" }, 404);
    const client = createFlightAwareClient({ apiKey: "k", fetchFn: notFound });
    await expect(client.deleteAlert("123")).resolves.toBeUndefined();

    const failing: FetchFn = async () => jsonResponse({ title: "Server Error", detail: "boom" }, 500);
    const client2 = createFlightAwareClient({ apiKey: "k", fetchFn: failing });
    await expect(client2.deleteAlert("123")).rejects.toBeInstanceOf(FlightAwareError);
  });

  it("surfaces provider errors with status and detail", async () => {
    const fetchFn: FetchFn = async () =>
      jsonResponse({ title: "Invalid API key", detail: "key rejected" }, 401);
    const client = createFlightAwareClient({ apiKey: "bad", fetchFn });
    await expect(
      client.getFlightsByIdent("UA30", { start: "2026-09-23T00:00:00Z", end: "2026-09-24T00:00:00Z" }),
    ).rejects.toMatchObject({ name: "FlightAwareError", status: 401 });
  });
});

describe("disabled path", () => {
  const ORIGINAL = process.env.FLIGHTAWARE_API_KEY;
  beforeEach(() => {
    delete process.env.FLIGHTAWARE_API_KEY;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FLIGHTAWARE_API_KEY;
    else process.env.FLIGHTAWARE_API_KEY = ORIGINAL;
  });

  it("returns null without a key — disabled, never fabricated", () => {
    expect(flightAwareClientFromEnv()).toBeNull();
  });

  it("returns a client when the key is present", () => {
    process.env.FLIGHTAWARE_API_KEY = "test-key";
    expect(flightAwareClientFromEnv()).not.toBeNull();
  });
});
