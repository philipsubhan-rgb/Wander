/**
 * Tests for structured flight fare fields and accommodation pricing.
 *
 * - Zod body schemas accept the new pricing/fare fields and reject bad types.
 * - GET normalises absent nullable columns to explicit nulls (no undefined
 *   leaking into the response shape).
 * - POST round-trips a full fare payload through validation.
 *
 * Uses the same chainable @workspace/db mock + minimal Express app pattern as
 * the timeline route tests.
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq:  (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  sql: (...args: unknown[]) => args,
}));

const resultQueue: unknown[] = [];
function enqueue(...items: unknown[]) { resultQueue.push(...items); }

function makeChain(): any {
  let p: Promise<unknown> | null = null;
  function promise() {
    if (!p) p = Promise.resolve(resultQueue.shift() ?? []);
    return p;
  }
  const chain: any = {
    then:    (res: any, rej: any) => promise().then(res, rej),
    catch:   (rej: any)           => promise().catch(rej),
    finally: (fin: any)           => promise().finally(fin),
  };
  for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "set", "values", "returning"]) {
    chain[m] = () => chain;
  }
  return chain;
}

const fakeTable = new Proxy({}, { get: (_t, p) => p });

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => makeChain()),
    update: vi.fn(() => makeChain()),
    delete: vi.fn(() => makeChain()),
  },
  tripsTable:            fakeTable,
  tripParticipantsTable: fakeTable,
  usersTable:            fakeTable,
  flightsTable:          fakeTable,
  accommodationsTable:   fakeTable,
  activitiesTable:       fakeTable,
  itineraryDaysTable:    fakeTable,
  packingItemsTable:     fakeTable,
  carRentalsTable:       fakeTable,
  tripExpensesTable:     fakeTable,
  reservationsTable:     fakeTable,
  pool:                  { query: vi.fn(), end: vi.fn() },
}));

import {
  CreateFlightBody,
  UpdateFlightBody,
  CreateAccommodationBody,
  UpdateAccommodationBody,
} from "@workspace/api-zod";

// ── Schema validation ─────────────────────────────────────────────────────────

describe("flight fare schemas", () => {
  const base = {
    flightNumber: "UA1465",
    airline: "United",
    departureAirport: "EWR",
    arrivalAirport: "PLS",
    departureDatetime: "2027-05-08T09:41",
    arrivalDatetime: "2027-05-08T13:20",
  };

  it("CreateFlightBody accepts a full structured fare payload", () => {
    const parsed = CreateFlightBody.safeParse({
      ...base,
      departureTimezone: "America/New_York",
      arrivalTimezone: "America/Grand_Turk",
      totalPrice: "1286.26",
      currency: "USD",
      fareBrand: "Economy",
      refundable: false,
      changeable: true,
      checkedBags: "2 checked bags included",
      passengerCount: 2,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.totalPrice).toBe("1286.26");
      expect(parsed.data.refundable).toBe(false);
      expect(parsed.data.passengerCount).toBe(2);
    }
  });

  it("CreateFlightBody accepts a body without any fare fields", () => {
    expect(CreateFlightBody.safeParse(base).success).toBe(true);
  });

  it("CreateFlightBody rejects mistyped fare fields", () => {
    expect(CreateFlightBody.safeParse({ ...base, refundable: "yes" }).success).toBe(false);
    expect(CreateFlightBody.safeParse({ ...base, passengerCount: "two" }).success).toBe(false);
  });

  it("UpdateFlightBody accepts partial fare updates", () => {
    const parsed = UpdateFlightBody.safeParse({ totalPrice: "1005.06", refundable: false });
    expect(parsed.success).toBe(true);
  });
});

describe("accommodation pricing schemas", () => {
  const base = {
    name: "Sugar Beach, A Viceroy Resort",
    address: "Soufriere, Saint Lucia",
    checkIn: "2027-05-08T15:00",
    checkOut: "2027-05-13T11:00",
  };

  it("CreateAccommodationBody accepts stay pricing", () => {
    const parsed = CreateAccommodationBody.safeParse({
      ...base,
      nightlyRate: "450.00",
      totalPrice: "2250.00",
      currency: "USD",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.nightlyRate).toBe("450.00");
      expect(parsed.data.totalPrice).toBe("2250.00");
      expect(parsed.data.currency).toBe("USD");
    }
  });

  it("UpdateAccommodationBody accepts partial pricing updates", () => {
    expect(UpdateAccommodationBody.safeParse({ nightlyRate: "475.00" }).success).toBe(true);
  });
});

// ── Route behaviour ───────────────────────────────────────────────────────────

async function buildTestApp() {
  const { default: flightsRouter } = await import("./flights.js");
  const { default: accommodationsRouter } = await import("./accommodations.js");

  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.session = { userId: 1, role: "admin" };
    next();
  });
  app.use("/api", flightsRouter);
  app.use("/api", accommodationsRouter);
  return app;
}

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = await buildTestApp();
  await new Promise<void>(resolve => { server = http.createServer(app).listen(0, resolve); });
  const addr = server.address() as { port: number };
  base = `http://localhost:${addr.port}/api`;
});

afterAll(() => server.close());
beforeEach(() => { resultQueue.length = 0; });

describe("flight fare API", () => {
  it("GET normalises absent fare columns to explicit nulls", async () => {
    enqueue([{
      id: 1, tripId: 7, flightNumber: "UA1465", airline: "United",
      departureAirport: "EWR", arrivalAirport: "PLS",
      departureDatetime: "2027-05-08T09:41", arrivalDatetime: "2027-05-08T13:20",
      // fare columns absent (undefined) as they would be on legacy rows
    }]);
    const res = await fetch(`${base}/trips/7/flights`);
    expect(res.status).toBe(200);
    const [flight] = await res.json() as any[];
    for (const k of ["totalPrice", "fareBrand", "refundable", "changeable", "checkedBags", "passengerCount", "departureTimezone", "arrivalTimezone"]) {
      expect(flight[k]).toBeNull();
    }
    expect("totalPrice" in flight).toBe(true);
  });

  it("POST accepts and echoes a structured fare payload", async () => {
    enqueue([{ id: 1 }]); // requireTripParticipant lookup
    const saved = {
      id: 2, tripId: 7, flightNumber: "AA1245", airline: "American",
      departureAirport: "UVF", arrivalAirport: "MIA",
      departureDatetime: "2027-05-13T15:35", arrivalDatetime: "2027-05-13T20:30",
      departureTimezone: "America/St_Lucia", arrivalTimezone: "America/New_York",
      totalPrice: "1005.06", currency: "USD", fareBrand: "Main Cabin",
      refundable: false, changeable: true, checkedBags: null, passengerCount: 2,
    };
    enqueue([saved]); // insert … returning()
    const res = await fetch(`${base}/trips/7/flights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flightNumber: "AA1245", airline: "American",
        departureAirport: "UVF", arrivalAirport: "MIA",
        departureDatetime: "2027-05-13T15:35", arrivalDatetime: "2027-05-13T20:30",
        departureTimezone: "America/St_Lucia", arrivalTimezone: "America/New_York",
        totalPrice: "1005.06", currency: "USD", fareBrand: "Main Cabin",
        refundable: false, changeable: true, passengerCount: 2,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.totalPrice).toBe("1005.06");
    expect(body.fareBrand).toBe("Main Cabin");
    expect(body.refundable).toBe(false);
    expect(body.changeable).toBe(true);
    expect(body.passengerCount).toBe(2);
    expect(body.checkedBags).toBeNull();
  });

  it("POST rejects a mistyped fare field with 400", async () => {
    enqueue([{ id: 1 }]); // requireTripParticipant lookup
    const res = await fetch(`${base}/trips/7/flights`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        flightNumber: "AA1245", airline: "American",
        departureAirport: "UVF", arrivalAirport: "MIA",
        departureDatetime: "2027-05-13T15:35", arrivalDatetime: "2027-05-13T20:30",
        refundable: "no",
      }),
    });
    expect(res.status).toBe(400);
  });
});

describe("accommodation pricing API", () => {
  it("GET normalises absent pricing columns to explicit nulls", async () => {
    enqueue([{
      id: 1, tripId: 7, name: "Sugar Beach", address: "Soufriere",
      checkIn: "2027-05-08T15:00", checkOut: "2027-05-13T11:00",
    }]);
    const res = await fetch(`${base}/trips/7/accommodations`);
    expect(res.status).toBe(200);
    const [stay] = await res.json() as any[];
    expect(stay.nightlyRate).toBeNull();
    expect(stay.totalPrice).toBeNull();
  });

  it("POST accepts and echoes stay pricing", async () => {
    enqueue([{ id: 1 }]); // requireTripParticipant lookup
    const saved = {
      id: 2, tripId: 7, name: "Sugar Beach", address: "Soufriere",
      checkIn: "2027-05-08T15:00", checkOut: "2027-05-13T11:00",
      nightlyRate: "450.00", totalPrice: "2250.00", currency: "USD",
    };
    enqueue([saved]);
    const res = await fetch(`${base}/trips/7/accommodations`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Sugar Beach", address: "Soufriere",
        checkIn: "2027-05-08T15:00", checkOut: "2027-05-13T11:00",
        nightlyRate: "450.00", totalPrice: "2250.00", currency: "USD",
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.nightlyRate).toBe("450.00");
    expect(body.totalPrice).toBe("2250.00");
    expect(body.currency).toBe("USD");
  });
});
