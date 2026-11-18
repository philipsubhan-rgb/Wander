/**
 * Duffel Stays adapter — fully mocked fetch, Duffel's documented
 * payload shapes. Live verification awaits Phil's key AND the
 * per-account Stays enablement (Packet #1); everything here runs
 * offline.
 *
 * The discipline under test (Story 2.1/2.2): the option's money is the
 * FULL-STAY total exactly as the supplier states it (decimal string →
 * BigInt-parsed minor units, supplier currency untouched); the
 * itemization is payload-stated figures only; per-night and
 * per-person-per-night are exact derived display; no token → plainly
 * disabled; a result whose total can't be stated exactly is skipped,
 * never approximated.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { money } from "@workspace/money";
import type { FetchFn } from "./duffel";
import { DuffelError, OptionsAdapterDisabledError } from "./duffel";
import {
  buildStaySearchBody,
  createDuffelStaysClient,
  duffelStaysAdapterFromEnv,
  mapDuffelStayResult,
  type DuffelStayResult,
} from "./duffelStays";
import type { StaySearchContext } from "./options";

const CTX: StaySearchContext = {
  latitude: 48.137,
  longitude: 11.575,
  radiusKm: 5,
  checkInDate: "2026-12-03",
  checkOutDate: "2026-12-08", // 5 nights
  guestCount: 5,
  rooms: 1,
};
const PRICED_AT = "2026-11-18T08:00:00Z";

/** The Duffel docs' worked example shape: £799.00 = 665.83 + 82.23 + 50.94, £39.95 due at the property. */
function hotelResult(overrides: Partial<DuffelStayResult> = {}): DuffelStayResult {
  return {
    id: "srr_hotel1",
    rooms: 1,
    check_in_date: "2026-12-03",
    check_out_date: "2026-12-08",
    cheapest_rate_total_amount: "799.00",
    cheapest_rate_currency: "GBP",
    cheapest_rate_base_amount: "665.83",
    cheapest_rate_base_currency: "GBP",
    cheapest_rate_due_at_accommodation_amount: "39.95",
    cheapest_rate_due_at_accommodation_currency: "GBP",
    accommodation: {
      id: "acc_1",
      type: "hotel",
      name: "Hotel Beispiel",
      rating: 4,
      review_score: 8.7,
      review_count: 1240,
      chain: { id: "chn_1", name: "Accor" },
      location: { address: { city_name: "Munich", region: "Bavaria", country_code: "DE" } },
      rooms: [
        {
          name: "Deluxe King Room",
          beds: [{ type: "king", count: 1 }],
          rates: [
            {
              id: "rat_1",
              total_amount: "799.00",
              total_currency: "GBP",
              base_amount: "665.83",
              base_currency: "GBP",
              tax_amount: "82.23",
              tax_currency: "GBP",
              fee_amount: "50.94",
              fee_currency: "GBP",
              due_at_accommodation_amount: "39.95",
              due_at_accommodation_currency: "GBP",
              board_type: "breakfast_included",
              cancellation_timeline: [
                { refund_amount: "799.00", currency: "GBP", before: "2026-12-01T00:00:00Z" },
                { refund_amount: "0.00", currency: "GBP", before: "2026-12-03T14:00:00Z" },
              ],
            },
          ],
        },
      ],
    },
    ...overrides,
  };
}

describe("buildStaySearchBody", () => {
  it("builds the documented body: coordinates + radius, guests, dates, fetch_rates", () => {
    const body = buildStaySearchBody(CTX) as { data: Record<string, unknown> };
    expect(body.data.check_in_date).toBe("2026-12-03");
    expect(body.data.check_out_date).toBe("2026-12-08");
    expect(body.data.rooms).toBe(1);
    expect(body.data.location).toEqual({
      radius: 5,
      geographic_coordinates: { latitude: 48.137, longitude: 11.575 },
    });
    expect(body.data.guests).toEqual([
      { type: "adult" },
      { type: "adult" },
      { type: "adult" },
      { type: "adult" },
      { type: "adult" },
    ]);
    expect(body.data.accommodation).toEqual({ fetch_rates: true });
    expect(body.data.free_cancellation_only).toBeUndefined();
  });

  it("adds free_cancellation_only only when asked", () => {
    const body = buildStaySearchBody({ ...CTX, freeCancellationOnly: true }) as {
      data: Record<string, unknown>;
    };
    expect(body.data.free_cancellation_only).toBe(true);
  });
});

describe("mapDuffelStayResult", () => {
  it("maps the full-stay total and the payload-stated itemization exactly", () => {
    const option = mapDuffelStayResult(hotelResult(), CTX, PRICED_AT)!;
    expect(option.kind).toBe("stay");
    expect(option.money).toEqual(money(79900, "GBP")); // the FULL stay — not a nightly figure
    expect(option.priceNature).toBe("estimate"); // a quote re-prices before booking
    const s = option.summary;
    expect(s.propertyName).toBe("Hotel Beispiel");
    expect(s.areaLabel).toBe("Munich, Bavaria");
    expect(s.starRating).toBe(4);
    expect(s.reviewScore).toBe(8.7);
    expect(s.roomName).toBe("Deluxe King Room");
    expect(s.beds).toBe("king bed");
    expect(s.boardType).toBe("Breakfast included");
    expect(s.breakdown.base).toEqual(money(66583, "GBP"));
    expect(s.breakdown.tax).toEqual(money(8223, "GBP"));
    expect(s.breakdown.fee).toEqual(money(5094, "GBP"));
    expect(s.breakdown.taxesAndFees).toBeNull(); // full split stated — no combined figure
    expect(s.breakdown.dueAtAccommodation).toEqual(money(3995, "GBP"));
    expect(s.nights).toBe(5);
    expect(s.nightlyRate).toEqual(money(15980, "GBP")); // 79900 / 5, derived
    expect(s.perPersonPerNight).toEqual(money(3196, "GBP")); // 79900 / (5 × 5 guests), derived
    expect(s.freeCancellation).toBe(true);
    expect(s.cancellationTerms).toBe("Free cancellation until 2026-12-01");
    expect(s.label).toBe("Hotel Beispiel, Munich");
  });

  it("canonicalizes stayStyle: chain brand → chain, independent hotel → boutique, whole home → home", () => {
    const chain = mapDuffelStayResult(hotelResult(), CTX, PRICED_AT)!;
    expect(chain.summary.stayStyle).toBe("chain");
    expect(chain.supplier).toBe("Accor");
    expect(chain.summary.isWholeHome).toBe(false);

    const independent = mapDuffelStayResult(
      hotelResult({
        id: "srr_indy",
        accommodation: { ...hotelResult().accommodation!, chain: null },
      }),
      CTX,
      PRICED_AT,
    )!;
    expect(independent.summary.stayStyle).toBe("boutique");
    expect(independent.supplier).toBe("Hotel Beispiel");

    const home = mapDuffelStayResult(
      hotelResult({
        id: "srr_home",
        accommodation: { ...hotelResult().accommodation!, type: "apartment", chain: null },
      }),
      CTX,
      PRICED_AT,
    )!;
    expect(home.summary.stayStyle).toBe("home");
    expect(home.summary.isWholeHome).toBe(true);
  });

  it("without rate detail, shows base + COMBINED taxes & fees — never an invented split", () => {
    const result = hotelResult({
      id: "srr_norates",
      cheapest_rate_total_amount: "1200.00",
      cheapest_rate_currency: "EUR",
      cheapest_rate_base_amount: "1000.00",
      cheapest_rate_base_currency: "EUR",
      cheapest_rate_due_at_accommodation_amount: undefined,
      cheapest_rate_due_at_accommodation_currency: undefined,
      accommodation: {
        ...hotelResult().accommodation!,
        chain: null,
        rooms: [{ name: "Standard Double", rates: [] }],
      },
    });
    const option = mapDuffelStayResult(result, CTX, PRICED_AT)!;
    expect(option.money).toEqual(money(120000, "EUR"));
    expect(option.summary.breakdown.base).toEqual(money(100000, "EUR"));
    expect(option.summary.breakdown.taxesAndFees).toEqual(money(20000, "EUR"));
    expect(option.summary.breakdown.tax).toBeNull();
    expect(option.summary.breakdown.fee).toBeNull();
    expect(option.summary.breakdown.dueAtAccommodation).toBeNull();
    expect(option.summary.roomName).toBeNull();
    expect(option.summary.cancellationTerms).toBeNull(); // not stated at search time — said so, not invented
    expect(option.summary.freeCancellation).toBe(false);
  });

  it("drops a stated split that doesn't sum to the total, falling back to the combined remainder", () => {
    const result = hotelResult();
    result.accommodation!.rooms![0].rates![0].fee_amount = "10.00"; // 665.83 + 82.23 + 10.00 ≠ 799.00
    const option = mapDuffelStayResult(result, CTX, PRICED_AT)!;
    expect(option.summary.breakdown.tax).toBeNull();
    expect(option.summary.breakdown.fee).toBeNull();
    expect(option.summary.breakdown.base).toEqual(money(66583, "GBP"));
    expect(option.summary.breakdown.taxesAndFees).toEqual(money(13317, "GBP")); // 799.00 − 665.83
  });

  it("is exact in zero- and three-decimal currencies (JPY, BHD)", () => {
    const jpy = mapDuffelStayResult(
      hotelResult({
        id: "srr_jpy",
        cheapest_rate_total_amount: "36000",
        cheapest_rate_currency: "JPY",
        cheapest_rate_base_amount: undefined,
        cheapest_rate_base_currency: undefined,
        cheapest_rate_due_at_accommodation_amount: undefined,
        cheapest_rate_due_at_accommodation_currency: undefined,
        accommodation: { ...hotelResult().accommodation!, rooms: [] },
      }),
      CTX,
      PRICED_AT,
    )!;
    expect(jpy.money).toEqual(money(36000, "JPY"));
    expect(jpy.summary.nightlyRate).toEqual(money(7200, "JPY"));

    const bhd = mapDuffelStayResult(
      hotelResult({
        id: "srr_bhd",
        cheapest_rate_total_amount: "123.456",
        cheapest_rate_currency: "BHD",
        cheapest_rate_base_amount: undefined,
        cheapest_rate_base_currency: undefined,
        cheapest_rate_due_at_accommodation_amount: undefined,
        cheapest_rate_due_at_accommodation_currency: undefined,
        accommodation: { ...hotelResult().accommodation!, rooms: [] },
      }),
      CTX,
      PRICED_AT,
    )!;
    expect(bhd.money).toEqual(money(123456, "BHD"));
  });

  it("skips results whose total cannot be stated exactly", () => {
    expect(mapDuffelStayResult(hotelResult({ cheapest_rate_total_amount: undefined }), CTX, PRICED_AT)).toBeNull();
    expect(mapDuffelStayResult(hotelResult({ cheapest_rate_total_amount: "abc" }), CTX, PRICED_AT)).toBeNull();
    expect(mapDuffelStayResult(hotelResult({ id: undefined }), CTX, PRICED_AT)).toBeNull();
    expect(
      mapDuffelStayResult(
        hotelResult({ accommodation: { ...hotelResult().accommodation!, name: undefined } }),
        CTX,
        PRICED_AT,
      ),
    ).toBeNull();
  });

  it("reads a non-refundable timeline honestly", () => {
    const result = hotelResult();
    result.accommodation!.rooms![0].rates![0].cancellation_timeline = [
      { refund_amount: "0.00", currency: "GBP", before: "2026-12-01T00:00:00Z" },
    ];
    const option = mapDuffelStayResult(result, CTX, PRICED_AT)!;
    expect(option.summary.freeCancellation).toBe(false);
    expect(option.summary.cancellationTerms).toBe("Non-refundable rate");
  });
});

// ─── Client + adapter over a mocked fetch ────────────────────────────────────

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("DuffelStaysAdapter (mocked fetch)", () => {
  it("searches /stays/search and maps every result", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn: FetchFn = async (url, init) => {
      seen.push({ url, init });
      return jsonResponse(200, {
        data: { created_at: PRICED_AT, results: [hotelResult(), hotelResult({ id: "srr_bad", cheapest_rate_total_amount: undefined })] },
      });
    };
    const adapter = duffelStaysAdapterFromEnvWithToken(fetchFn);
    const options = await adapter.searchStays(CTX);
    expect(options).toHaveLength(1); // the unmappable result is skipped, not approximated
    expect(options[0].money).toEqual(money(79900, "GBP"));
    expect(seen[0].url).toBe("https://api.duffel.com/stays/search");
    expect(seen[0].init?.method).toBe("POST");
    const body = JSON.parse(String(seen[0].init?.body)) as { data: { check_in_date: string } };
    expect(body.data.check_in_date).toBe("2026-12-03");
  });

  it("surfaces a Duffel rejection (e.g. Stays not enabled on the account) as a DuffelError", async () => {
    const fetchFn: FetchFn = async () =>
      jsonResponse(403, { errors: [{ title: "Forbidden", detail: "Stays is not enabled for this account" }] });
    const client = createDuffelStaysClient({ token: "tok_test", fetchFn });
    await expect(client.searchStays(CTX)).rejects.toThrow(DuffelError);
    await expect(client.searchStays(CTX)).rejects.toThrow(/Stays is not enabled/);
  });
});

// The env-based factory reads DUFFEL_API_TOKEN; these tests set it explicitly.
const ORIGINAL_TOKEN = process.env.DUFFEL_API_TOKEN;
function duffelStaysAdapterFromEnvWithToken(fetchFn: FetchFn) {
  process.env.DUFFEL_API_TOKEN = "tok_test";
  return duffelStaysAdapterFromEnv(fetchFn);
}

describe("token discipline", () => {
  beforeEach(() => {
    delete process.env.DUFFEL_API_TOKEN;
  });
  afterEach(() => {
    if (ORIGINAL_TOKEN === undefined) delete process.env.DUFFEL_API_TOKEN;
    else process.env.DUFFEL_API_TOKEN = ORIGINAL_TOKEN;
  });

  it("no token → plainly disabled, and searchStays refuses rather than inventing results", async () => {
    const adapter = duffelStaysAdapterFromEnv();
    expect(adapter.enabled).toBe(false);
    expect(adapter.disabledReason).toContain("DUFFEL_API_TOKEN");
    expect(adapter.disabledReason).toContain("stay prices are unavailable");
    await expect(adapter.searchStays(CTX)).rejects.toThrow(OptionsAdapterDisabledError);
  });
});
