/**
 * Duffel adapter — fully mocked HTTP. Covers the documented
 * offer-request flow (request shape, headers), offer → normalized
 * option mapping, exact decimal-string money (incl. 0- and 3-decimal
 * currencies), fare-label canonicalization, and the disabled path
 * (no DUFFEL_API_TOKEN → the adapter says so, never invents results).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  DuffelError,
  OptionsAdapterDisabledError,
  buildOfferRequestBody,
  createDuffelClient,
  duffelAdapterFromEnv,
  mapDuffelOffer,
  normalizeFareClass,
  parseIsoDurationMinutes,
  type DuffelOffer,
  type FetchFn,
} from "./duffel";
import type { FlightSearchContext } from "./options";

const CTX: FlightSearchContext = {
  origin: "ewr",
  destination: "muc",
  departureDate: "2026-12-03",
  passengerCount: 2,
  cabinClass: "economy",
  maxConnections: 1,
};

function segment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "seg_1",
    origin: { iata_code: "EWR", name: "Newark", time_zone: "America/New_York" },
    destination: { iata_code: "MUC", name: "Munich", time_zone: "Europe/Berlin" },
    departing_at: "2026-12-03T17:00:00-05:00",
    arriving_at: "2026-12-04T07:10:00+01:00",
    duration: "PT8H10M",
    marketing_carrier: { name: "United Airlines", iata_code: "UA" },
    marketing_carrier_flight_number: "30",
    operating_carrier: { name: "United Airlines", iata_code: "UA" },
    operating_carrier_flight_number: "30",
    passengers: [
      { passenger_id: "pas_1", cabin_class: "economy", cabin_class_marketing_name: "Basic Economy", fare_basis_code: "NAA0AADN" },
    ],
    ...overrides,
  };
}

function offer(overrides: Record<string, unknown> = {}): DuffelOffer {
  return {
    id: "off_1",
    total_amount: "612.00",
    total_currency: "USD",
    base_amount: "540.00",
    tax_amount: "72.00",
    owner: { name: "United Airlines", iata_code: "UA" },
    conditions: {
      change_before_departure: { allowed: false },
      refund_before_departure: { allowed: false },
    },
    slices: [
      {
        origin: { iata_code: "EWR" },
        destination: { iata_code: "MUC" },
        duration: "PT8H10M",
        segments: [segment()],
      },
    ],
    expires_at: "2026-11-18T09:00:00Z",
    created_at: "2026-11-18T08:00:00Z",
    ...overrides,
  } as DuffelOffer;
}

function offerRequest(offers: DuffelOffer[]): Record<string, unknown> {
  return { data: { id: "orq_1", created_at: "2026-11-18T08:00:00Z", offers } };
}

function fetchReturning(payload: unknown, status = 200): { fetchFn: FetchFn; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(payload),
    } as Response;
  };
  return { fetchFn, calls };
}

describe("buildOfferRequestBody", () => {
  it("builds the documented one-way body: slices, adult passengers, cabin, max_connections", () => {
    const body = buildOfferRequestBody(CTX) as { data: Record<string, unknown> };
    expect(body.data.slices).toEqual([
      { origin: "EWR", destination: "MUC", departure_date: "2026-12-03" },
    ]);
    expect(body.data.passengers).toEqual([{ type: "adult" }, { type: "adult" }]);
    expect(body.data.cabin_class).toBe("economy");
    expect(body.data.max_connections).toBe(1);
  });

  it("adds the reversed slice for a round trip and omits unset filters", () => {
    const body = buildOfferRequestBody({
      origin: "EWR",
      destination: "MUC",
      departureDate: "2026-12-03",
      returnDate: "2026-12-07",
      passengerCount: 1,
    }) as { data: Record<string, unknown> };
    expect(body.data.slices).toEqual([
      { origin: "EWR", destination: "MUC", departure_date: "2026-12-03" },
      { origin: "MUC", destination: "EWR", departure_date: "2026-12-07" },
    ]);
    expect(body.data).not.toHaveProperty("cabin_class");
    expect(body.data).not.toHaveProperty("max_connections");
  });
});

describe("createDuffelClient", () => {
  it("POSTs to /air/offer_requests with bearer auth and the Duffel-Version header", async () => {
    const { fetchFn, calls } = fetchReturning(offerRequest([offer()]));
    const client = createDuffelClient({ token: "test_token", fetchFn });
    const result = await client.createOfferRequest(CTX);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.duffel.com/air/offer_requests");
    expect(calls[0].init?.method).toBe("POST");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test_token");
    expect(headers["Duffel-Version"]).toBe("v2");
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(buildOfferRequestBody(CTX));
    expect(result.offers).toHaveLength(1);
  });

  it("surfaces Duffel's error detail and status — no fake results", async () => {
    const { fetchFn } = fetchReturning(
      { errors: [{ type: "invalid_request_error", title: "Invalid slice", detail: "departure_date is in the past" }] },
      422,
    );
    const client = createDuffelClient({ token: "test_token", fetchFn });
    await expect(client.createOfferRequest(CTX)).rejects.toMatchObject({
      name: "DuffelError",
      status: 422,
      message: expect.stringContaining("departure_date is in the past"),
    });
  });
});

describe("mapDuffelOffer", () => {
  it("maps a nonstop USD offer exactly: money, fare class, changeability, label, summary", () => {
    const mapped = mapDuffelOffer(offer(), "2026-11-18T08:00:00Z");
    expect(mapped).not.toBeNull();
    expect(mapped!.money).toEqual({ amountMinor: 61200, currency: "USD" });
    expect(mapped!.kind).toBe("flight");
    expect(mapped!.adapter).toBe("duffel");
    expect(mapped!.supplier).toBe("United Airlines");
    expect(mapped!.priceNature).toBe("firm");
    expect(mapped!.fulfillment).toBe("api_rail");
    expect(mapped!.partner).toBeNull();
    const s = mapped!.summary;
    expect(s.fareClass).toBe("Basic Economy");
    expect(s.cabinClass).toBe("economy");
    expect(s.changeable).toBe(false);
    expect(s.refundable).toBe(false);
    expect(s.label).toBe("UA30 Basic Economy");
    expect(s.totalStops).toBe(0);
    expect(s.connectionAirports).toEqual([]);
    expect(s.totalDurationMinutes).toBe(490);
    expect(s.slices[0]).toMatchObject({
      origin: "EWR",
      destination: "MUC",
      departAt: "2026-12-03T17:00:00-05:00",
      arriveAt: "2026-12-04T07:10:00+01:00",
      stops: 0,
      flightNumbers: ["UA30"],
    });
  });

  it("maps a one-stop offer: connection airport + layover minutes from segment times", () => {
    const fra1 = segment({
      destination: { iata_code: "FRA", name: "Frankfurt", time_zone: "Europe/Berlin" },
      arriving_at: "2026-12-04T06:30:00+01:00",
      duration: "PT7H30M",
      passengers: [{ passenger_id: "pas_1", cabin_class: "economy", cabin_class_marketing_name: "Economy", fare_basis_code: "Y" }],
    });
    const fra2 = segment({
      id: "seg_2",
      origin: { iata_code: "FRA", name: "Frankfurt", time_zone: "Europe/Berlin" },
      departing_at: "2026-12-04T08:00:00+01:00",
      arriving_at: "2026-12-04T09:05:00+01:00",
      duration: "PT1H05M",
      marketing_carrier_flight_number: "106",
      operating_carrier_flight_number: "106",
      passengers: [{ passenger_id: "pas_1", cabin_class: "economy", cabin_class_marketing_name: "Economy", fare_basis_code: "Y" }],
    });
    const mapped = mapDuffelOffer(
      offer({
        id: "off_2",
        total_amount: "845.50",
        conditions: {
          change_before_departure: { allowed: true, penalty_amount: "75.00", penalty_currency: "USD" },
          refund_before_departure: { allowed: false },
        },
        slices: [{ origin: { iata_code: "EWR" }, destination: { iata_code: "MUC" }, duration: "PT10H05M", segments: [fra1, fra2] }],
      }),
      "2026-11-18T08:00:00Z",
    );
    expect(mapped!.money).toEqual({ amountMinor: 84550, currency: "USD" });
    expect(mapped!.summary.fareClass).toBe("Economy");
    expect(mapped!.summary.changeable).toBe(true);
    expect(mapped!.summary.connectionAirports).toEqual(["FRA"]);
    expect(mapped!.summary.totalStops).toBe(1);
    expect(mapped!.summary.slices[0].layovers).toEqual([{ airport: "FRA", minutes: 90 }]);
    expect(mapped!.summary.slices[0].flightNumbers).toEqual(["UA30", "UA106"]);
  });

  it("parses decimal strings exactly in 0- and 3-decimal currencies (no floats)", () => {
    const jpy = mapDuffelOffer(offer({ total_amount: "15234", total_currency: "JPY" }), "2026-11-18T08:00:00Z");
    expect(jpy!.money).toEqual({ amountMinor: 15234, currency: "JPY" });
    const bhd = mapDuffelOffer(offer({ total_amount: "10.500", total_currency: "BHD" }), "2026-11-18T08:00:00Z");
    expect(bhd!.money).toEqual({ amountMinor: 10500, currency: "BHD" });
    const eur = mapDuffelOffer(offer({ total_amount: "45.10", total_currency: "EUR" }), "2026-11-18T08:00:00Z");
    expect(eur!.money).toEqual({ amountMinor: 4510, currency: "EUR" });
  });

  it("returns null for an offer whose total cannot be represented exactly", () => {
    expect(mapDuffelOffer(offer({ total_amount: "not-a-price" }), "2026-11-18T08:00:00Z")).toBeNull();
    expect(mapDuffelOffer(offer({ total_amount: undefined }), "2026-11-18T08:00:00Z")).toBeNull();
  });

  it("leaves changeable undefined when Duffel states no conditions (unknown ≠ violation)", () => {
    const mapped = mapDuffelOffer(offer({ conditions: undefined }), "2026-11-18T08:00:00Z");
    expect(mapped!.summary.changeable).toBeUndefined();
    expect(mapped!.summary.refundable).toBeUndefined();
  });
});

describe("normalizeFareClass / parseIsoDurationMinutes", () => {
  it("canonicalizes basic-economy labels in either word order", () => {
    expect(normalizeFareClass("Economy Basic")).toBe("Basic Economy");
    expect(normalizeFareClass("Basic Economy")).toBe("Basic Economy");
    expect(normalizeFareClass("economy basic")).toBe("Basic Economy");
    expect(normalizeFareClass("Economy Standard")).toBe("Economy Standard");
    expect(normalizeFareClass("  Business  ")).toBe("Business");
    expect(normalizeFareClass(null)).toBeNull();
    expect(normalizeFareClass("")).toBeNull();
  });

  it("parses ISO durations to minutes", () => {
    expect(parseIsoDurationMinutes("PT8H10M")).toBe(490);
    expect(parseIsoDurationMinutes("PT45M")).toBe(45);
    expect(parseIsoDurationMinutes("P1DT2H")).toBe(1560);
    expect(parseIsoDurationMinutes("nonsense")).toBeNull();
    expect(parseIsoDurationMinutes(undefined)).toBeNull();
  });
});

describe("DuffelFlightsAdapter enablement", () => {
  const ORIGINAL = process.env.DUFFEL_API_TOKEN;
  beforeEach(() => {
    delete process.env.DUFFEL_API_TOKEN;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.DUFFEL_API_TOKEN;
    else process.env.DUFFEL_API_TOKEN = ORIGINAL;
  });

  it("is disabled without a token and refuses to search — plainly, with no results", async () => {
    const adapter = duffelAdapterFromEnv();
    expect(adapter.enabled).toBe(false);
    expect(adapter.disabledReason).toContain("DUFFEL_API_TOKEN");
    await expect(adapter.searchFlights(CTX)).rejects.toBeInstanceOf(OptionsAdapterDisabledError);
  });

  it("searches through the injected fetch when a token is present", async () => {
    process.env.DUFFEL_API_TOKEN = "test_token";
    const { fetchFn } = fetchReturning(offerRequest([offer(), offer({ id: "off_bad", total_amount: "junk" })]));
    const adapter = duffelAdapterFromEnv(fetchFn);
    expect(adapter.enabled).toBe(true);
    const options = await adapter.searchFlights(CTX);
    // The malformed offer is skipped, never repaired or invented.
    expect(options).toHaveLength(1);
    expect(options[0].id).toBe("off_1");
    expect(options[0].pricedAt).toBe("2026-11-18T08:00:00Z");
  });

  it("propagates Duffel errors instead of returning empty results", async () => {
    process.env.DUFFEL_API_TOKEN = "test_token";
    const { fetchFn } = fetchReturning({ errors: [{ title: "boom", detail: "upstream down" }] }, 500);
    const adapter = duffelAdapterFromEnv(fetchFn);
    await expect(adapter.searchFlights(CTX)).rejects.toBeInstanceOf(DuffelError);
  });
});
