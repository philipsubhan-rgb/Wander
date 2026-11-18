/**
 * Duffel Stays quote + booking client (E-3.2) — the gate's stays rail.
 *
 * The documented flow under test: search prices are estimates; a quote
 * (POST /stays/quotes with the rate_id) makes the price firm; the
 * booking is created against the QUOTE (POST /stays/bookings), sent
 * exactly once, with 200/201/202 all surfaced as results. Also pins
 * the search mapping's new gate handles: the cheapest rate's id and
 * the property's address line land on the option summary. All HTTP is
 * a fake fetch; no live call is possible (no API key in this VM).
 */

import { describe, it, expect, vi } from "vitest";
import {
  buildCreateStayBookingBody,
  buildCreateStayQuoteBody,
  createDuffelStaysClient,
  mapDuffelStayResult,
  type DuffelStayResult,
} from "./duffelStays";
import type { FetchFn } from "./duffel";
import type { StaySearchContext } from "./options";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GUESTS = [{ givenName: "Philip", familyName: "Subhan", bornOn: "1958-10-01" }];

describe("stays quote/booking bodies", () => {
  it("quote body carries only the rate id", () => {
    expect(buildCreateStayQuoteBody("rat_1")).toEqual({ data: { rate_id: "rat_1" } });
  });

  it("booking body maps guests to the documented fields and omits unstated optionals", () => {
    const body = buildCreateStayBookingBody({
      quoteId: "quo_1",
      guests: GUESTS,
      email: "philipsubhan@gmail.com",
      phoneNumber: "+16095550100",
    }) as { data: Record<string, unknown> };
    expect(body.data.quote_id).toBe("quo_1");
    expect(body.data.guests).toEqual([
      { given_name: "Philip", family_name: "Subhan", born_on: "1958-10-01" },
    ]);
    expect(body.data.email).toBe("philipsubhan@gmail.com");
    expect(body.data.phone_number).toBe("+16095550100");
    expect(body.data).not.toHaveProperty("accommodation_special_requests");
  });

  it("special requests ride along only when stated", () => {
    const body = buildCreateStayBookingBody({
      quoteId: "quo_1",
      guests: GUESTS,
      email: "a@b.c",
      phoneNumber: "+1",
      specialRequests: "High floor, quiet room",
    }) as { data: Record<string, unknown> };
    expect(body.data.accommodation_special_requests).toBe("High floor, quiet room");
  });
});

describe("createDuffelStaysClient — quote then book", () => {
  it("createQuote posts the rate id and returns the firm quote", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(201, {
        data: { id: "quo_1", rate_id: "rat_1", total_amount: "840.00", total_currency: "EUR" },
      }),
    );
    const client = createDuffelStaysClient({ token: "test-token", fetchFn });
    const quote = await client.createQuote("rat_1");
    expect(quote.id).toBe("quo_1");
    expect(quote.total_amount).toBe("840.00");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.duffel.com/stays/quotes");
    expect(JSON.parse(String(init?.body))).toEqual({ data: { rate_id: "rat_1" } });
  });

  it("createBooking on 201 returns the booking — exactly one call", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(201, { data: { id: "bok_1", reference: "HTLREF1", quote_id: "quo_1" } }),
    );
    const client = createDuffelStaysClient({ token: "test-token", fetchFn });
    const result = await client.createBooking({
      quoteId: "quo_1",
      guests: GUESTS,
      email: "philipsubhan@gmail.com",
      phoneNumber: "+16095550100",
    });
    expect(result.status).toBe(201);
    expect(result.booking?.reference).toBe("HTLREF1");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url] = fetchFn.mock.calls[0];
    expect(url).toBe("https://api.duffel.com/stays/bookings");
  });

  it("createBooking on 202 surfaces the accepted state as a result — still exactly one call", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(202, { data: { id: "bok_2", quote_id: "quo_1" } }),
    );
    const client = createDuffelStaysClient({ token: "test-token", fetchFn });
    const result = await client.createBooking({
      quoteId: "quo_1",
      guests: GUESTS,
      email: "a@b.c",
      phoneNumber: "+1",
    });
    expect(result.status).toBe(202);
    expect(result.booking?.id).toBe("bok_2");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("createBooking on a supplier error throws — still exactly one call", async () => {
    const fetchFn = vi.fn<FetchFn>(async () =>
      jsonResponse(422, { errors: [{ title: "Invalid", detail: "Quote has expired" }] }),
    );
    const client = createDuffelStaysClient({ token: "test-token", fetchFn });
    await expect(
      client.createBooking({ quoteId: "quo_x", guests: GUESTS, email: "a@b.c", phoneNumber: "+1" }),
    ).rejects.toThrow(/Quote has expired/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe("mapDuffelStayResult — gate handles on the summary", () => {
  const ctx: StaySearchContext = {
    latitude: 48.14,
    longitude: 11.58,
    radiusKm: 10,
    checkInDate: "2026-12-03",
    checkOutDate: "2026-12-08",
    guestCount: 2,
    rooms: 1,
  };

  const result: DuffelStayResult = {
    id: "sta_1",
    rooms: 1,
    check_in_date: "2026-12-03",
    check_out_date: "2026-12-08",
    cheapest_rate_total_amount: "800.00",
    cheapest_rate_currency: "EUR",
    accommodation: {
      id: "acc_1",
      type: "hotel",
      name: "Hotel Beispiel",
      location: {
        address: {
          city_name: "Munich",
          region: "Bavaria",
          country_code: "DE",
          line_one: "Leopoldstrasse 10",
          postal_code: "80802",
        },
      },
      rooms: [
        {
          name: "Double Room",
          rates: [
            {
              id: "rat_1",
              total_amount: "800.00",
              total_currency: "EUR",
              base_amount: "700.00",
              base_currency: "EUR",
              tax_amount: "60.00",
              tax_currency: "EUR",
              fee_amount: "40.00",
              fee_currency: "EUR",
            },
          ],
        },
      ],
    },
  };

  it("carries the cheapest rate's id, a null quote id, and the address line", () => {
    const option = mapDuffelStayResult(result, ctx, "2026-11-18T09:00:00Z");
    expect(option).not.toBeNull();
    expect(option!.summary.rateId).toBe("rat_1");
    expect(option!.summary.quoteId).toBeNull();
    expect(option!.summary.addressLine).toBe("Leopoldstrasse 10");
    expect(option!.priceNature).toBe("estimate");
  });
});
