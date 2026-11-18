/**
 * Duffel orders client — the Booking Gate's execution rail (§5.2).
 *
 * The discipline under test is Duffel's own: always fetch the quote
 * (GET offer) before booking, and NEVER retry a create — a create call
 * goes out exactly once, and 200/201/202 all come back as results for
 * the caller to reconcile, never as reasons to re-send. All HTTP is a
 * fake fetch; no live call is possible (no API key in this VM).
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildCreateOrderBody,
  createDuffelOrdersClient,
  DuffelError,
  mapOrderToFlightRows,
  type DuffelOrder,
  type FetchFn,
} from "./duffel";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PASSENGERS = [
  { id: "pas_1", givenName: "Philip", familyName: "Subhan", bornOn: "1958-10-01", phoneNumber: "+16095550100" },
];

describe("buildCreateOrderBody", () => {
  it("builds the documented instant-order body, omitting unstated optional fields", () => {
    const body = buildCreateOrderBody({ offerId: "off_123", passengers: PASSENGERS }) as {
      data: { type: string; selected_offers: string[]; passengers: Array<Record<string, unknown>> };
    };
    expect(body.data.type).toBe("instant");
    expect(body.data.selected_offers).toEqual(["off_123"]);
    expect(body.data.passengers).toEqual([
      {
        id: "pas_1",
        given_name: "Philip",
        family_name: "Subhan",
        born_on: "1958-10-01",
        phone_number: "+16095550100",
      },
    ]);
    // No title/gender invented: the vault doesn't store them.
    expect(body.data.passengers[0]).not.toHaveProperty("title");
    expect(body.data.passengers[0]).not.toHaveProperty("gender");
  });
});

describe("createDuffelOrdersClient", () => {
  it("getOffer fetches the offer (the quote step) and returns its data", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(200, { data: { id: "off_123", total_amount: "612.00", total_currency: "USD" } }),
    );
    const client = createDuffelOrdersClient({ token: "test-token", fetchFn });
    const offer = await client.getOffer("off_123");
    expect(offer.total_amount).toBe("612.00");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.duffel.com/air/offers/off_123");
    expect(init?.method).toBe("GET");
  });

  it("getOffer surfaces a 404 as a DuffelError carrying the status (sold out / expired)", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(404, { errors: [{ title: "Not found", detail: "Offer not found" }] }),
    );
    const client = createDuffelOrdersClient({ token: "test-token", fetchFn });
    await expect(client.getOffer("off_gone")).rejects.toMatchObject({
      name: "DuffelError",
      status: 404,
    });
  });

  it("createOrder on 201 returns the order — and the fetch fires EXACTLY once", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(201, {
        data: { id: "ord_1", booking_reference: "JQZZ2H", total_amount: "612.00", total_currency: "USD" },
      }),
    );
    const client = createDuffelOrdersClient({ token: "test-token", fetchFn });
    const result = await client.createOrder({ offerId: "off_123", passengers: PASSENGERS });
    expect(result.status).toBe(201);
    expect(result.order?.booking_reference).toBe("JQZZ2H");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.duffel.com/air/orders");
    expect(init?.method).toBe("POST");
  });

  it("createOrder on 202 returns the accepted state as a RESULT, not an error — still exactly one call", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(202, { data: { id: "ord_2", total_amount: "612.00", total_currency: "USD" } }),
    );
    const client = createDuffelOrdersClient({ token: "test-token", fetchFn });
    const result = await client.createOrder({ offerId: "off_123", passengers: PASSENGERS });
    expect(result.status).toBe(202);
    expect(result.order?.id).toBe("ord_2");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("createOrder on a supplier error throws DuffelError with the provider detail — still exactly one call", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(422, { errors: [{ title: "Invalid", detail: "Offer has expired" }] }),
    );
    const client = createDuffelOrdersClient({ token: "test-token", fetchFn });
    await expect(client.createOrder({ offerId: "off_123", passengers: PASSENGERS })).rejects.toThrow(
      DuffelError,
    );
    await expect(
      client.createOrder({ offerId: "off_123", passengers: PASSENGERS }),
    ).rejects.toThrow(/Offer has expired/);
    // Two explicit invocations = two calls; the point is the client
    // itself never retries inside one invocation (asserted above by
    // the single-call counts on the success paths).
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("mapOrderToFlightRows — the ledger's projection source", () => {
  const order: DuffelOrder = {
    id: "ord_1",
    booking_reference: "JQZZ2H",
    total_amount: "612.00",
    total_currency: "USD",
    owner: { name: "United Airlines", iata_code: "UA" },
    slices: [
      {
        origin: { iata_code: "EWR" },
        destination: { iata_code: "MUC" },
        segments: [
          {
            origin: { iata_code: "EWR", time_zone: "America/New_York" },
            destination: { iata_code: "MUC", time_zone: "Europe/Berlin" },
            departing_at: "2026-09-23T17:00:00-04:00",
            arriving_at: "2026-09-24T07:10:00+02:00",
            marketing_carrier: { name: "United Airlines", iata_code: "UA" },
            marketing_carrier_flight_number: "30",
          },
        ],
      },
      {
        origin: { iata_code: "MUC" },
        destination: { iata_code: "EWR" },
        segments: [
          {
            origin: { iata_code: "MUC", time_zone: "Europe/Berlin" },
            destination: { iata_code: "EWR", time_zone: "America/New_York" },
            departing_at: "2026-09-28T09:50:00+02:00",
            arriving_at: "2026-09-28T13:00:00-04:00",
            marketing_carrier: { name: "United Airlines", iata_code: "UA" },
            marketing_carrier_flight_number: "31",
          },
        ],
      },
    ],
  };

  it("projects one row per slice with wall-clock times and timezones", () => {
    const rows = mapOrderToFlightRows(order);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      flightNumber: "UA30",
      airline: "United Airlines",
      departureAirport: "EWR",
      arrivalAirport: "MUC",
      departureDatetime: "2026-09-23T17:00",
      arrivalDatetime: "2026-09-24T07:10",
      departureTimezone: "America/New_York",
      arrivalTimezone: "Europe/Berlin",
      direction: "outbound",
    });
    expect(rows[1]).toMatchObject({ flightNumber: "UA31", direction: "return" });
  });

  it("skips slices that cannot be stated exactly instead of repairing them", () => {
    const broken: DuffelOrder = {
      id: "ord_x",
      slices: [{ segments: [{ departing_at: "2026-09-23T17:00:00-04:00" }] }],
    };
    expect(mapOrderToFlightRows(broken)).toEqual([]);
    expect(mapOrderToFlightRows({})).toEqual([]);
  });
});
