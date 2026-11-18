/**
 * Duffel servicing client — change & cancel (E-3.4).
 *
 * The documented flows under test: cancellation is quote-then-confirm
 * (POST /air/order_cancellations creates an UNCONFIRMED quote; only
 * the confirm call executes it), and a change is request → priced
 * offers → create pending change → confirm with a balance payment.
 * All HTTP is a scripted fake fetch that records call ORDER — the
 * lifecycle tests assert terms-fetch precedes any confirm; here the
 * client's own shapes and exactly-once creates are pinned. No live
 * call is possible (no API key in this VM).
 */

import { describe, it, expect, vi } from "vitest";
import { money } from "@workspace/money";
import {
  buildConfirmOrderChangeBody,
  buildCreateOrderCancellationBody,
  buildCreateOrderChangeBody,
  buildCreateOrderChangeRequestBody,
  createDuffelOrdersClient,
  mapChangeOfferToOption,
  type DuffelOrderChangeOffer,
  type FetchFn,
} from "./duffel";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/** A fetch that routes by "METHOD /path" and records every call. */
function scriptedFetch(routes: Record<string, { status: number; body: unknown }>) {
  const calls: RecordedCall[] = [];
  const fetchFn = vi.fn<FetchFn>(async (url, init) => {
    const u = new URL(String(url));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: u.pathname, method, body });
    const route = routes[`${method} ${u.pathname}`];
    if (!route) return jsonResponse(404, { errors: [{ title: "Not found", detail: u.pathname }] });
    return jsonResponse(route.status, route.body);
  });
  return { fetchFn, calls };
}

describe("servicing request bodies", () => {
  it("cancellation create is the documented quote body", () => {
    expect(buildCreateOrderCancellationBody("ord_1")).toEqual({ data: { order_id: "ord_1" } });
  });

  it("change request carries remove slice ids and add criteria", () => {
    expect(
      buildCreateOrderChangeRequestBody({
        orderId: "ord_1",
        removeSliceIds: ["sli_1"],
        addSlices: [{ origin: "MUC", destination: "EWR", departureDate: "2026-09-29", cabinClass: "economy" }],
      }),
    ).toEqual({
      data: {
        order_id: "ord_1",
        slices: {
          remove: [{ slice_id: "sli_1" }],
          add: [{ origin: "MUC", destination: "EWR", departure_date: "2026-09-29", cabin_class: "economy" }],
        },
      },
    });
  });

  it("change create selects exactly one change offer", () => {
    expect(buildCreateOrderChangeBody("oco_1")).toEqual({
      data: { selected_order_change_offer: "oco_1" },
    });
  });

  it("change confirm pays the change total from balance only when positive", () => {
    expect(buildConfirmOrderChangeBody(money(6200, "USD"))).toEqual({
      data: { payment: { type: "balance", amount: "62.00", currency: "USD" } },
    });
    // Zero or negative (refund-due) totals carry no payment object.
    expect(buildConfirmOrderChangeBody(money(0, "USD"))).toEqual({ data: {} });
    expect(buildConfirmOrderChangeBody(money(-5000, "USD"))).toEqual({ data: {} });
    expect(buildConfirmOrderChangeBody(null)).toEqual({ data: {} });
    // Exact decimal rendering for a 0-decimal currency.
    expect(buildConfirmOrderChangeBody(money(1500, "JPY"))).toEqual({
      data: { payment: { type: "balance", amount: "1500", currency: "JPY" } },
    });
  });
});

describe("cancellation flow — call order and exactly-once", () => {
  it("getOrder → create quote → confirm, each exactly once, in that order", async () => {
    const { fetchFn, calls } = scriptedFetch({
      "GET /air/orders/ord_1": {
        status: 200,
        body: { data: { id: "ord_1", available_actions: ["cancel", "change"] } },
      },
      "POST /air/order_cancellations": {
        status: 201,
        body: {
          data: {
            id: "ore_1",
            order_id: "ord_1",
            refund_amount: "400.00",
            refund_currency: "USD",
            refund_to: "original_form_of_payment",
            expires_at: "2026-11-19T09:00:00Z",
            confirmed_at: null,
          },
        },
      },
      "POST /air/order_cancellations/ore_1/actions/confirm": {
        status: 200,
        body: {
          data: {
            id: "ore_1",
            refund_amount: "400.00",
            refund_currency: "USD",
            refund_to: "original_form_of_payment",
            confirmed_at: "2026-11-18T11:00:00Z",
          },
        },
      },
    });
    const client = createDuffelOrdersClient({ token: "test-token", fetchFn });

    const order = await client.getOrder("ord_1");
    expect(order.available_actions).toContain("cancel");
    const quote = await client.createOrderCancellation("ord_1");
    expect(quote.confirmed_at).toBeNull();
    expect(quote.refund_amount).toBe("400.00");
    const confirmed = await client.confirmOrderCancellation("ore_1");
    expect(confirmed.confirmed_at).toBe("2026-11-18T11:00:00Z");

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /air/orders/ord_1",
      "POST /air/order_cancellations",
      "POST /air/order_cancellations/ore_1/actions/confirm",
    ]);
    expect(calls[1].body).toEqual({ data: { order_id: "ord_1" } });
  });

  it("a stale-quote confirm error surfaces as a DuffelError (never retried)", async () => {
    const { fetchFn, calls } = scriptedFetch({
      "POST /air/order_cancellations/ore_old/actions/confirm": {
        status: 422,
        body: { errors: [{ title: "Stale", detail: "order_cancellation_stale" }] },
      },
    });
    const client = createDuffelOrdersClient({ token: "test-token", fetchFn });
    await expect(client.confirmOrderCancellation("ore_old")).rejects.toThrow(/order_cancellation_stale/);
    expect(calls).toHaveLength(1);
  });
});

describe("change flow — request, offers, create, confirm", () => {
  it("runs the documented four steps with the payment on confirm", async () => {
    const { fetchFn, calls } = scriptedFetch({
      "POST /air/order_change_requests": {
        status: 201,
        body: { data: { id: "ocr_1", order_id: "ord_1" } },
      },
      "GET /air/order_change_requests/ocr_1": {
        status: 200,
        body: {
          data: {
            id: "ocr_1",
            order_change_offers: [
              {
                id: "oco_1",
                change_total_amount: "62.00",
                change_total_currency: "USD",
                new_total_amount: "674.00",
                new_total_currency: "USD",
                penalty_total_amount: "50.00",
                penalty_total_currency: "USD",
              },
            ],
          },
        },
      },
      "POST /air/order_changes": {
        status: 201,
        body: { data: { id: "oce_1", change_total_amount: "62.00", change_total_currency: "USD", confirmed_at: null } },
      },
      "POST /air/order_changes/oce_1/actions/confirm": {
        status: 200,
        body: { data: { id: "oce_1", change_total_amount: "62.00", confirmed_at: "2026-11-18T11:05:00Z" } },
      },
    });
    const client = createDuffelOrdersClient({ token: "test-token", fetchFn });

    const request = await client.createOrderChangeRequest({
      orderId: "ord_1",
      removeSliceIds: ["sli_1"],
      addSlices: [{ origin: "MUC", destination: "EWR", departureDate: "2026-09-29" }],
    });
    expect(request.id).toBe("ocr_1");
    const full = await client.getOrderChangeRequest("ocr_1");
    expect(full.order_change_offers?.[0].new_total_amount).toBe("674.00");
    const pending = await client.createOrderChange("oco_1");
    expect(pending.confirmed_at).toBeNull();
    const confirmed = await client.confirmOrderChange("oce_1", money(6200, "USD"));
    expect(confirmed.confirmed_at).toBeTruthy();

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /air/order_change_requests",
      "GET /air/order_change_requests/ocr_1",
      "POST /air/order_changes",
      "POST /air/order_changes/oce_1/actions/confirm",
    ]);
    expect(calls[3].body).toEqual({
      data: { payment: { type: "balance", amount: "62.00", currency: "USD" } },
    });
  });
});

describe("mapChangeOfferToOption", () => {
  const offer: DuffelOrderChangeOffer = {
    id: "oco_1",
    change_total_amount: "-50.00",
    change_total_currency: "USD",
    new_total_amount: "562.00",
    new_total_currency: "USD",
    slices: {
      add: [
        {
          origin: { iata_code: "MUC" },
          destination: { iata_code: "EWR" },
          segments: [
            {
              origin: { iata_code: "MUC", time_zone: "Europe/Berlin" },
              destination: { iata_code: "EWR", time_zone: "America/New_York" },
              departing_at: "2026-09-29T09:50:00+02:00",
              arriving_at: "2026-09-29T13:00:00-04:00",
              marketing_carrier: { name: "United Airlines", iata_code: "UA" },
              marketing_carrier_flight_number: "31",
              passengers: [{ cabin_class: "economy", cabin_class_marketing_name: "Main Cabin" }],
            },
          ],
        },
      ],
      remove: [],
    },
  };

  it("prices the option at the SIGNED change total (a refund is negative money)", () => {
    const option = mapChangeOfferToOption(offer, "2026-11-18T10:00:00Z");
    expect(option).not.toBeNull();
    expect(option!.money).toEqual({ amountMinor: -5000, currency: "USD" });
    expect(option!.kind).toBe("flight");
    expect(option!.summary.label).toContain("UA31");
    expect(option!.summary.slices[0]).toMatchObject({ origin: "MUC", destination: "EWR" });
    expect(option!.priceNature).toBe("firm");
  });

  it("returns null when the delta cannot be stated exactly", () => {
    expect(mapChangeOfferToOption({ ...offer, change_total_amount: "abc" }, "2026-11-18T10:00:00Z")).toBeNull();
    expect(mapChangeOfferToOption({ ...offer, id: undefined }, "2026-11-18T10:00:00Z")).toBeNull();
    expect(mapChangeOfferToOption({ ...offer, slices: { add: [] } }, "2026-11-18T10:00:00Z")).toBeNull();
  });
});
