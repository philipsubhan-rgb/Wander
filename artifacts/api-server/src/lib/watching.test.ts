/**
 * Watching Service — DB-level tests with a recording @workspace/db mock
 * and a mocked mailer (same pattern as outreach.test.ts). All
 * FlightAware HTTP is behind fake clients — live verification awaits
 * Phil's Packet #1 key. Covers: registration (disabled + with client +
 * departed refusal), webhook → advisory creation with notification,
 * dedupe, sub-threshold quiet, dismissal-remembered worsening gate,
 * the T-24h one-lookup-per-leg batch, and deregistration at trip
 * completion.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  Advisory,
  Flight,
  FlightStatusSnapshot,
  FlightWatch,
  Trip,
} from "@workspace/db";

const store = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name });
  const ops: Array<{ op: string; table: string; values?: unknown; set?: unknown }> = [];
  const selectQueues: Record<string, unknown[][]> = {};
  const insertReturns: Record<string, unknown[]> = {};
  const updateReturns: Record<string, unknown[]> = {};

  function makeChain(kind: string, tableName?: string): Record<string, unknown> {
    const ctx = { table: tableName };
    const resolve = (): Promise<unknown> => {
      if (kind === "select") return Promise.resolve(selectQueues[ctx.table ?? ""]?.shift() ?? []);
      if (kind === "insert") return Promise.resolve(insertReturns[ctx.table ?? ""] ?? []);
      if (kind === "update") return Promise.resolve(updateReturns[ctx.table ?? ""] ?? []);
      return Promise.resolve([]);
    };
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolve().then(res, rej),
      catch: (rej: (e: unknown) => unknown) => resolve().catch(rej),
      finally: (fin: () => void) => resolve().finally(fin),
    };
    chain.from = (t: { __table: string }) => {
      ctx.table = t.__table;
      return chain;
    };
    for (const m of ["where", "orderBy", "limit", "returning"]) {
      chain[m] = () => chain;
    }
    chain.values = (v: unknown) => {
      ops.push({ op: "insert", table: ctx.table ?? "", values: v });
      return chain;
    };
    chain.set = (v: unknown) => {
      ops.push({ op: "update", table: ctx.table ?? "", set: v });
      return chain;
    };
    return chain;
  }

  const db = {
    select: vi.fn(() => makeChain("select")),
    insert: vi.fn((t: { __table: string }) => makeChain("insert", t.__table)),
    update: vi.fn((t: { __table: string }) => makeChain("update", t.__table)),
    delete: vi.fn((t: { __table: string }) => makeChain("delete", t.__table)),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { table, ops, selectQueues, insertReturns, updateReturns, db };
});

const mailer = vi.hoisted(() => ({
  calls: [] as Array<{ to: string; subject: string; text: string; html: string }>,
  sendEmail: vi.fn(
    async (opts: { to: string; subject: string; text: string; html: string }) => {
      mailer.calls.push(opts);
      return { sent: true };
    },
  ),
}));

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  desc: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
}));

vi.mock("@workspace/db", () => ({
  db: store.db,
  flightsTable: store.table("flights"),
  tripsTable: store.table("trips"),
  flightWatchesTable: store.table("flight_watches"),
  advisoriesTable: store.table("advisories"),
  tripParticipantsTable: store.table("trip_participants"),
  usersTable: store.table("users"),
  accommodationsTable: store.table("accommodations"),
  activitiesTable: store.table("activities"),
  itineraryDaysTable: store.table("itinerary_days"),
  carRentalsTable: store.table("car_rentals"),
  reservationsTable: store.table("reservations"),
}));

vi.mock("./email.js", () => ({ sendEmail: mailer.sendEmail }));

import {
  completeWatchesForFinishedTrips,
  deregisterWatchForFlight,
  handleAlertPayload,
  ingestFlightStatus,
  registerWatchForFlight,
  runPredepartureCheck,
} from "./watching.js";
import { runWatchingDailyTick } from "./watchingScheduler.js";
import type { AeroFlight, CreateAlertInput, FlightAwareClient } from "./flightaware.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function flightRow(overrides: Partial<Flight> = {}): Flight {
  return {
    id: 7,
    tripId: 3,
    flightNumber: "UA30",
    airline: "United",
    departureAirport: "EWR",
    arrivalAirport: "MUC",
    departureDatetime: "2026-09-23T17:00",
    arrivalDatetime: "2026-09-24T07:10",
    departureTimezone: "America/New_York",
    arrivalTimezone: "Europe/Berlin",
    confirmationCode: "JQZZ2H",
    notes: null,
    direction: "outbound",
    totalPrice: null,
    currency: "USD",
    fareBrand: null,
    refundable: null,
    changeable: null,
    checkedBags: null,
    passengerCount: 5,
    ...overrides,
  } as Flight;
}

function tripRow(overrides: Partial<Trip> = {}): Trip {
  return {
    id: 3,
    title: "Munich — guys' trip",
    destination: "Munich",
    startDate: "2026-09-23",
    endDate: "2026-09-28",
    description: null,
    coverImage: null,
    status: "confirmed",
    adminNotes: null,
    createdAt: new Date("2026-08-01T00:00:00Z"),
    ...overrides,
  } as Trip;
}

function baselineSnap(overrides: Partial<FlightStatusSnapshot> = {}): FlightStatusSnapshot {
  return {
    faFlightId: "UAL30-1",
    status: "Scheduled / On Time",
    cancelled: false,
    diverted: false,
    scheduledOut: "2026-09-23T21:00:00Z",
    estimatedOut: "2026-09-23T21:00:00Z",
    actualOut: null,
    scheduledIn: "2026-09-24T05:10:00Z",
    estimatedIn: "2026-09-24T05:10:00Z",
    actualIn: null,
    gateOrigin: "C120",
    gateDestination: null,
    terminalOrigin: "C",
    terminalDestination: null,
    arrivalDelayMinutes: 0,
    departureDelayMinutes: 0,
    source: "alert",
    observedAt: "2026-09-20T12:00:00Z",
    ...overrides,
  };
}

function watchRow(overrides: Partial<FlightWatch> = {}): FlightWatch {
  return {
    id: 5,
    flightId: 7,
    tripId: 3,
    ident: "UA30",
    departureDate: "2026-09-23",
    faFlightId: "UAL30-1",
    alertId: null,
    state: "active",
    lastStatusSnapshot: null,
    snapshotAt: null,
    predepartureCheckedAt: null,
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
    ...overrides,
  } as FlightWatch;
}

function advisoryRow(overrides: Partial<Advisory> = {}): Advisory {
  return {
    id: 11,
    flightWatchId: 5,
    flightId: 7,
    tripId: 3,
    kind: "arrival_delay",
    severity: "high",
    summary: "UA30 (EWR → MUC) is running about 2h 15m late.",
    impactSummary: "No downstream impact found on the rest of the itinerary.",
    impacts: [],
    situation: { signature: "arrival-delay:135", metric: 135 },
    proposalPayload: null,
    state: "open",
    notifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Advisory;
}

function queueSelects(table: string, results: unknown[][]) {
  store.selectQueues[table] = [...results];
}

function advisoryInserts(): Array<Record<string, unknown>> {
  return store.ops
    .filter((o) => o.op === "insert" && o.table === "advisories")
    .map((o) => o.values as Record<string, unknown>);
}

beforeEach(() => {
  store.ops.length = 0;
  mailer.calls.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
});

// ─── Registration ────────────────────────────────────────────────────────────

describe("registerWatchForFlight", () => {
  it("creates a local watch when FlightAware is disabled (no alert id, plainly logged)", async () => {
    queueSelects("flights", [[flightRow()]]);
    queueSelects("trips", [[tripRow()]]);
    queueSelects("flight_watches", [[]]);
    store.insertReturns["flight_watches"] = [watchRow()];

    const result = await registerWatchForFlight(7, {
      client: null,
      now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(result.created).toBe(true);
    const insert = store.ops.find((o) => o.op === "insert" && o.table === "flight_watches");
    const values = insert?.values as Record<string, unknown>;
    expect(values.ident).toBe("UA30");
    expect(values.departureDate).toBe("2026-09-23");
    expect(values.flightId).toBe(7);
  });

  it("registers the alert with the provider and stores its id when a client exists", async () => {
    queueSelects("flights", [[flightRow()]]);
    queueSelects("trips", [[tripRow()]]);
    queueSelects("flight_watches", [[]]);
    store.insertReturns["flight_watches"] = [watchRow()];
    store.updateReturns["flight_watches"] = [watchRow({ alertId: "555" })];

    const alertInputs: CreateAlertInput[] = [];
    const client = {
      createAlert: async (input: CreateAlertInput) => {
        alertInputs.push(input);
        return { alertId: "555" };
      },
    } as unknown as FlightAwareClient;
    const result = await registerWatchForFlight(7, {
      client,
      now: new Date("2026-09-01T00:00:00Z"),
    });
    expect(alertInputs).toHaveLength(1);
    expect(alertInputs[0]).toMatchObject({ ident: "UA30", origin: "EWR", destination: "MUC" });
    expect(result.created).toBe(true);
    if (result.created) expect(result.watch.alertId).toBe("555");
  });

  it("refuses a flight that has already departed", async () => {
    queueSelects("flights", [[flightRow()]]);
    queueSelects("trips", [[tripRow()]]);
    const result = await registerWatchForFlight(7, {
      client: null,
      now: new Date("2026-09-25T00:00:00Z"),
    });
    expect(result).toMatchObject({ created: false, reason: "already_departed" });
    expect(store.ops.filter((o) => o.op === "insert")).toHaveLength(0);
  });
});

// ─── Webhook → advisory ──────────────────────────────────────────────────────

describe("handleAlertPayload → ingest", () => {
  it("creates an advisory and emails every participant for a material delay", async () => {
    queueSelects("flight_watches", [[watchRow({ lastStatusSnapshot: baselineSnap() })]]);
    store.updateReturns["flight_watches"] = [watchRow()];
    queueSelects("flights", [[flightRow()], [flightRow()], [flightRow()]]); // ingest load + timeline + walk load
    queueSelects("trips", [[tripRow()]]);
    queueSelects("trip_participants", [
      [
        { tripId: 3, userId: 42, isTripAdmin: true },
        { tripId: 3, userId: 43, isTripAdmin: false },
      ],
    ]);
    queueSelects("users", [
      [{ id: 42, name: "Phil", email: "phil@example.com" }],
      [{ id: 43, name: "Kurt", email: "kurt@example.com" }],
    ]);
    queueSelects("advisories", [[]]); // no prior advisory for the kind
    queueSelects("accommodations", [[]]);
    queueSelects("activities", [[]]);
    queueSelects("itinerary_days", [[]]);
    queueSelects("car_rentals", [[]]);
    queueSelects("reservations", [[]]);
    store.insertReturns["advisories"] = [advisoryRow()];

    const payload = {
      alert_id: 123,
      event_code: "change",
      flight: {
        ident: "UA30",
        fa_flight_id: "UAL30-1",
        status: "Scheduled / Delayed",
        cancelled: false,
        diverted: false,
        origin: { code_iata: "EWR", timezone: "America/New_York" },
        destination: { code_iata: "MUC", timezone: "Europe/Berlin" },
        scheduled_out: "2026-09-23T17:00:00-04:00",
        estimated_out: "2026-09-23T17:00:00-04:00",
        actual_out: null,
        scheduled_in: "2026-09-24T07:10:00+02:00",
        estimated_in: "2026-09-24T09:25:00+02:00",
        actual_in: null,
        gate_origin: "C120",
        terminal_origin: "C",
      } as AeroFlight,
    };

    const result = await handleAlertPayload(payload, { now: new Date("2026-09-23T12:00:00Z") });
    expect(result.outcome).toBe("advisory");
    const inserts = advisoryInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].kind).toBe("arrival_delay");
    expect(inserts[0].severity).toBe("high");
    expect((inserts[0].situation as { metric: number }).metric).toBe(135);
    expect((inserts[0].proposalPayload as { kind: string }).kind).toBe("rebooking_options");
    expect(mailer.calls).toHaveLength(2);
    expect(mailer.calls[0].subject).toContain("UA30");
    expect(mailer.calls[0].text).toContain("2h 15m late");
    expect(mailer.calls[0].text).toContain("Nothing has been rebooked");
  });

  it("returns unmatched for an alert about an unwatched flight", async () => {
    queueSelects("flight_watches", [[], []]);
    const result = await handleAlertPayload({
      flight: { ident: "UA30", fa_flight_id: "UAL30-9", scheduled_out: "2026-09-23T17:00:00-04:00" } as AeroFlight,
    });
    expect(result.outcome).toBe("unmatched");
    expect(advisoryInserts()).toHaveLength(0);
  });

  it("rejects a payload with no flight object", async () => {
    const result = await handleAlertPayload({});
    expect(result.outcome).toBe("invalid_payload");
  });
});

// ─── Dedupe / quiet / worsening ──────────────────────────────────────────────

describe("ingestFlightStatus", () => {
  it("treats a re-delivered identical status as a duplicate — no advisory, no email", async () => {
    const watch = watchRow({ lastStatusSnapshot: baselineSnap() });
    const result = await ingestFlightStatus(watch, baselineSnap({ observedAt: "2026-09-21T00:00:00Z" }));
    expect(result.outcome).toBe("duplicate");
    expect(advisoryInserts()).toHaveLength(0);
    expect(mailer.calls).toHaveLength(0);
    expect(store.ops.filter((o) => o.op === "update" && o.table === "flight_watches")).toHaveLength(1);
  });

  it("updates the snapshot quietly for a sub-threshold delay", async () => {
    queueSelects("flights", [[flightRow()]]);
    queueSelects("trips", [[tripRow()]]);
    queueSelects("trip_participants", [[]]);
    const watch = watchRow({ lastStatusSnapshot: baselineSnap() });
    const result = await ingestFlightStatus(
      watch,
      baselineSnap({ estimatedIn: "2026-09-24T05:30:00Z", arrivalDelayMinutes: 20 }),
    );
    expect(result.outcome).toBe("quiet");
    expect(advisoryInserts()).toHaveLength(0);
  });

  it("fires once when stepped schedule moves cross the threshold cumulatively, and never again on repeat delivery", async () => {
    // The watch's last snapshot is step 1: schedule already +10m vs
    // booked (quietly absorbed). Step 2 moves it another +10m — the
    // cumulative shift vs booked is 20m and must fire, even though the
    // step itself is sub-threshold.
    const step1 = baselineSnap({
      scheduledOut: "2026-09-23T21:10:00Z",
      scheduledIn: "2026-09-24T05:20:00Z",
      estimatedIn: "2026-09-24T05:20:00Z",
    });
    const step2 = baselineSnap({
      scheduledOut: "2026-09-23T21:20:00Z",
      scheduledIn: "2026-09-24T05:30:00Z",
      estimatedIn: "2026-09-24T05:30:00Z",
      observedAt: "2026-09-20T13:00:00Z",
    });
    queueSelects("flights", [[flightRow()], [flightRow()], [flightRow()]]); // ingest load + timeline + walk load
    queueSelects("trips", [[tripRow()]]);
    queueSelects("trip_participants", [[]]);
    queueSelects("advisories", [[]]); // no prior advisory for the kind
    queueSelects("accommodations", [[]]);
    queueSelects("activities", [[]]);
    queueSelects("itinerary_days", [[]]);
    queueSelects("car_rentals", [[]]);
    queueSelects("reservations", [[]]);
    store.insertReturns["advisories"] = [
      advisoryRow({
        kind: "schedule_change",
        situation: { signature: "schedule-shift:20/20", metric: 20 },
      }),
    ];
    const watch = watchRow({ lastStatusSnapshot: step1 });
    const fired = await ingestFlightStatus(watch, step2);
    expect(fired.outcome).toBe("advisory");
    const inserts = advisoryInserts();
    expect(inserts).toHaveLength(1);
    expect(inserts[0].kind).toBe("schedule_change");
    expect((inserts[0].situation as { metric: number }).metric).toBe(20);

    // The same step-2 snapshot delivered again (the watch now holds it
    // as its last snapshot): a duplicate — no second advisory, no email.
    store.ops.length = 0;
    const watchAfter = watchRow({ lastStatusSnapshot: step2 });
    const repeated = await ingestFlightStatus(watchAfter, { ...step2, observedAt: "2026-09-20T14:00:00Z" });
    expect(repeated.outcome).toBe("duplicate");
    expect(advisoryInserts()).toHaveLength(0);
    expect(mailer.calls).toHaveLength(0);
  });

  it("suppresses a smaller delay after dismissal, and re-fires when the delay worsens", async () => {
    // Dismissed advisory already fired at 45m; a 40m update must not re-fire.
    queueSelects("flights", [[flightRow()]]);
    queueSelects("trips", [[tripRow()]]);
    queueSelects("trip_participants", [[]]);
    queueSelects("advisories", [
      [advisoryRow({ state: "dismissed", situation: { signature: "arrival-delay:45", metric: 45 } })],
    ]);
    const watch = watchRow({
      lastStatusSnapshot: baselineSnap({ estimatedIn: "2026-09-24T05:55:00Z", arrivalDelayMinutes: 45 }),
    });
    const suppressed = await ingestFlightStatus(
      watch,
      baselineSnap({ estimatedIn: "2026-09-24T05:50:00Z", arrivalDelayMinutes: 40 }),
    );
    expect(suppressed.outcome).toBe("suppressed");
    expect(advisoryInserts()).toHaveLength(0);

    // A 90m delay is worse than the dismissed 45m — it re-fires.
    store.ops.length = 0;
    queueSelects("flights", [[flightRow()], [flightRow()]]);
    queueSelects("trips", [[tripRow()]]);
    queueSelects("trip_participants", [[]]);
    queueSelects("advisories", [
      [advisoryRow({ state: "dismissed", situation: { signature: "arrival-delay:45", metric: 45 } })],
    ]);
    queueSelects("accommodations", [[]]);
    queueSelects("activities", [[]]);
    queueSelects("itinerary_days", [[]]);
    queueSelects("car_rentals", [[]]);
    queueSelects("reservations", [[]]);
    store.insertReturns["advisories"] = [advisoryRow()];
    const refired = await ingestFlightStatus(
      watch,
      baselineSnap({ estimatedIn: "2026-09-24T06:40:00Z", arrivalDelayMinutes: 90 }),
    );
    expect(refired.outcome).toBe("advisory");
    expect(advisoryInserts()).toHaveLength(1);
  });
});

// ─── T-24h batch ─────────────────────────────────────────────────────────────

describe("runPredepartureCheck", () => {
  const NOW = new Date("2026-09-23T12:00:00Z");

  it("performs exactly one lookup per due leg, stamps it, and never touches later legs", async () => {
    const dueFlight = flightRow({
      id: 8,
      flightNumber: "LH441",
      airline: "Lufthansa",
      departureAirport: "MUC",
      arrivalAirport: "FRA",
      departureDatetime: "2026-09-24T08:00",
      arrivalDatetime: "2026-09-24T10:05",
      departureTimezone: "Europe/Berlin",
      arrivalTimezone: "Europe/Berlin",
    });
    const laterFlight = flightRow({ id: 9, departureDatetime: "2026-09-27T09:00", arrivalDatetime: "2026-09-27T11:00" });
    const dueWatch = watchRow({ id: 6, flightId: 8, ident: "LH441", departureDate: "2026-09-24", faFlightId: "DLH441-9" });
    const laterWatch = watchRow({ id: 7, flightId: 9, departureDate: "2026-09-27", faFlightId: "UAL30-7" });

    queueSelects("flight_watches", [[dueWatch, laterWatch]]);
    queueSelects("flights", [[dueFlight], [dueFlight], [laterFlight]]); // due: check + ingest; later: window test
    queueSelects("trips", [[tripRow()]]);
    queueSelects("trip_participants", [[]]);

    const getFlightByFaFlightId = vi.fn(
      async (): Promise<AeroFlight> => ({
        ident: "LH441",
        fa_flight_id: "DLH441-9",
        status: "Scheduled / On Time",
        cancelled: false,
        diverted: false,
        origin: { code_iata: "MUC" },
        destination: { code_iata: "FRA" },
        scheduled_out: "2026-09-24T08:00:00+02:00",
        estimated_out: "2026-09-24T08:00:00+02:00",
        scheduled_in: "2026-09-24T10:05:00+02:00",
        estimated_in: "2026-09-24T10:05:00+02:00",
      }),
    );
    const client = { getFlightByFaFlightId } as unknown as FlightAwareClient;

    const summary = await runPredepartureCheck({ client, now: NOW });
    expect(summary).toMatchObject({ considered: 1, checked: 1, disabled: false });
    expect(getFlightByFaFlightId).toHaveBeenCalledTimes(1);
    const stamps = store.ops.filter(
      (o) =>
        o.op === "update" &&
        o.table === "flight_watches" &&
        (o.set as Record<string, unknown>)?.predepartureCheckedAt !== undefined,
    );
    expect(stamps).toHaveLength(1);

    // Second run: the stamped watch is filtered out by the query (queue
    // now empty) — zero further lookups. The batch cannot become polling.
    queueSelects("flight_watches", [[]]);
    const second = await runPredepartureCheck({ client, now: NOW });
    expect(second.considered).toBe(0);
    expect(getFlightByFaFlightId).toHaveBeenCalledTimes(1);
  });

  it("is plainly disabled without a client", async () => {
    const summary = await runPredepartureCheck({ client: null, now: NOW });
    expect(summary.disabled).toBe(true);
    expect(summary.checked).toBe(0);
  });
});

// ─── Completion sweep ────────────────────────────────────────────────────────

describe("completeWatchesForFinishedTrips", () => {
  it("deregisters the provider alert and closes the watch when the trip is completed", async () => {
    queueSelects("flight_watches", [[watchRow({ alertId: "555" })]]);
    queueSelects("trips", [[tripRow({ status: "completed" })]]);
    const deleteAlert = vi.fn(async () => undefined);
    const client = { deleteAlert } as unknown as FlightAwareClient;

    const result = await completeWatchesForFinishedTrips({ client, now: new Date("2026-10-01T00:00:00Z") });
    expect(result.completed).toBe(1);
    expect(deleteAlert).toHaveBeenCalledWith("555");
    const close = store.ops.find((o) => o.op === "update" && o.table === "flight_watches");
    expect((close?.set as Record<string, unknown>).state).toBe("completed");
  });

  it("leaves watches on open trips alone", async () => {
    queueSelects("flight_watches", [[watchRow()]]);
    queueSelects("trips", [[tripRow({ status: "active", endDate: "2026-09-28" })]]);
    const result = await completeWatchesForFinishedTrips({ client: null, now: new Date("2026-09-25T00:00:00Z") });
    expect(result.completed).toBe(0);
  });
});

// ─── Single-flight deregistration (E-3.4: cancel/change re-keying) ───────────

describe("deregisterWatchForFlight", () => {
  it("deletes the provider alert and closes the watch", async () => {
    queueSelects("flight_watches", [[watchRow({ alertId: "555" })]]);
    const deleteAlert = vi.fn(async () => undefined);
    const client = { deleteAlert } as unknown as FlightAwareClient;

    const result = await deregisterWatchForFlight(7, { client, now: new Date("2026-11-18T10:00:00Z") });
    expect(result).toEqual({ deregistered: true });
    expect(deleteAlert).toHaveBeenCalledWith("555");
    const close = store.ops.find((o) => o.op === "update" && o.table === "flight_watches");
    expect((close?.set as Record<string, unknown>).state).toBe("completed");
  });

  it("is a plain no-op when the flight has no active watch", async () => {
    queueSelects("flight_watches", [[]]);
    const deleteAlert = vi.fn(async () => undefined);
    const client = { deleteAlert } as unknown as FlightAwareClient;

    const result = await deregisterWatchForFlight(7, { client, now: new Date("2026-11-18T10:00:00Z") });
    expect(result).toEqual({ deregistered: false, reason: "no_active_watch" });
    expect(deleteAlert).not.toHaveBeenCalled();
    expect(store.ops.filter((o) => o.table === "flight_watches")).toHaveLength(0);
  });

  it("closes the watch locally even when the provider delete fails", async () => {
    queueSelects("flight_watches", [[watchRow({ alertId: "555" })]]);
    const deleteAlert = vi.fn(async () => {
      throw new Error("FlightAware down");
    });
    const client = { deleteAlert } as unknown as FlightAwareClient;

    const result = await deregisterWatchForFlight(7, { client, now: new Date("2026-11-18T10:00:00Z") });
    expect(result.deregistered).toBe(true);
    const close = store.ops.find((o) => o.op === "update" && o.table === "flight_watches");
    expect((close?.set as Record<string, unknown>).state).toBe("completed");
  });
});

// ─── Daily tick ──────────────────────────────────────────────────────────────

describe("runWatchingDailyTick", () => {
  it("composes the three passes and reports zeros on an empty world", async () => {
    queueSelects("trips", [[]]);
    queueSelects("flights", [[]]);
    queueSelects("flight_watches", [[], []]);
    const summary = await runWatchingDailyTick({ client: null, now: new Date("2026-09-23T06:15:00Z") });
    expect(summary).toEqual({
      registered: 0,
      registrationSkipped: 0,
      predepartureChecked: 0,
      watchesCompleted: 0,
    });
  });
});
