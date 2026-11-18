/**
 * Calendar write-back service — flights / stays / car rentals (the
 * completion bundle's §6 extension beyond reservations).
 *
 * Recording @workspace/db mock + fake Google Calendar layer: proves
 * create + link, hash-based idempotency (re-sync is a no-op), update
 * propagation, the per-account toggle/scope gates, and event deletion
 * (the delete-on-cancel path the booking lifecycle drives).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name });
  const ops: Array<{ op: string; table: string; values?: unknown; set?: unknown }> = [];
  const selectQueues: Record<string, unknown[][]> = {};

  function makeChain(kind: string, tableName?: string): Record<string, unknown> {
    const ctx = { table: tableName };
    const resolve = (): Promise<unknown> => {
      if (kind === "select") return Promise.resolve(selectQueues[ctx.table ?? ""]?.shift() ?? []);
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
    for (const m of ["where", "orderBy", "limit", "returning", "onConflictDoNothing"]) {
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
    delete: vi.fn((t: { __table: string }) => {
      // A delete has no values()/set() call to record — record it here.
      ops.push({ op: "delete", table: t.__table });
      return makeChain("delete", t.__table);
    }),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { table, ops, selectQueues, db };
});

const google = vi.hoisted(() => ({
  findWanderCalendar: vi.fn(async () => ({ id: "cal-1", timeZone: "America/New_York" })),
  ensureWanderCalendar: vi.fn(async () => ({ id: "cal-1", timeZone: "America/New_York" })),
  insertCalendarEvent: vi.fn(
    async (_client: unknown, _calendarId: string, _payload: unknown) => "evt-1",
  ),
  updateCalendarEvent: vi.fn(
    async (_client: unknown, _calendarId: string, _eventId: string, _payload: unknown) =>
      undefined,
  ),
  deleteCalendarEvent: vi.fn(
    async (_client: unknown, _calendarId: string, _eventId: string) => undefined,
  ),
}));

vi.mock("@workspace/db", () => ({
  db: store.db,
  tripsTable: store.table("trips"),
  reservationsTable: store.table("reservations"),
  flightsTable: store.table("flights"),
  accommodationsTable: store.table("accommodations"),
  carRentalsTable: store.table("car_rentals"),
  connectedAccountsTable: store.table("connected_accounts"),
  calendarEventLinksTable: store.table("calendar_event_links"),
}));

vi.mock("./credentialCrypto", () => ({
  decryptToken: (s: string) => s,
  encryptToken: (s: string) => s,
}));

vi.mock("./gmailScan", () => ({
  getAccountClient: vi.fn(async () => ({})),
}));

vi.mock("./googleCalendar", () => ({
  findWanderCalendar: google.findWanderCalendar,
  ensureWanderCalendar: google.ensureWanderCalendar,
  insertCalendarEvent: google.insertCalendarEvent,
  updateCalendarEvent: google.updateCalendarEvent,
  deleteCalendarEvent: google.deleteCalendarEvent,
  GoogleCalendarError: class extends Error {
    status = 0;
  },
  WANDER_CALENDAR_NAME: "Wander",
}));

import {
  deleteCalendarEventsByLinks,
  deleteLinkedCalendarEventsForItem,
  syncFlightForUser,
  syncAccommodationForUser,
  syncCarRentalForUser,
  updateLinkedCalendarEventsForItem,
} from "./calendarSync";
import {
  hashCalendarEventPayload,
  mapFlightToCalendarEvent,
  type GoogleCalendarEventPayload,
} from "./calendarEventMapping";

const ACCOUNT = {
  id: 7,
  userId: 42,
  provider: "google",
  email: "phil@example.com",
  encryptedRefreshToken: "refresh-token",
  scopes: "gmail.readonly calendar.events",
  calendarWritebackEnabled: true,
  calendarId: "cal-1",
};

const FLIGHT = {
  id: 55,
  tripId: 3,
  flightNumber: "UA30",
  airline: "United Airlines",
  departureAirport: "EWR",
  arrivalAirport: "MUC",
  departureDatetime: "2026-09-23T17:00",
  arrivalDatetime: "2026-09-24T07:10",
  departureTimezone: "America/New_York",
  arrivalTimezone: "Europe/Berlin",
  confirmationCode: "JQZZ2H",
  notes: null,
} as never;

function queueSyncBasics(linkRows: unknown[] = []) {
  store.selectQueues["connected_accounts"] = [[ACCOUNT]];
  store.selectQueues["trips"] = [[{ title: "Munich guys' trip" }]];
  store.selectQueues["calendar_event_links"] = [linkRows];
}

function opsOn(table: string, op?: string) {
  return store.ops.filter((o) => o.table === table && (!op || o.op === op));
}

beforeEach(() => {
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  vi.clearAllMocks();
  google.findWanderCalendar.mockResolvedValue({ id: "cal-1", timeZone: "America/New_York" });
  google.insertCalendarEvent.mockResolvedValue("evt-1");
});

describe("flight write-back", () => {
  it("creates the event and a flight link row (item-typed, reservation FK null)", async () => {
    queueSyncBasics([]);
    await syncFlightForUser(42, FLIGHT);

    expect(google.insertCalendarEvent).toHaveBeenCalledTimes(1);
    const [, calendarId, payload] = google.insertCalendarEvent.mock.calls[0] as [
      unknown,
      string,
      GoogleCalendarEventPayload,
    ];
    expect(calendarId).toBe("cal-1");
    expect(payload.summary).toBe("United Airlines UA30 — EWR → MUC");
    expect(payload.start).toEqual({ dateTime: "2026-09-23T17:00:00", timeZone: "America/New_York" });

    const linkInsert = opsOn("calendar_event_links", "insert")[0];
    expect(linkInsert).toBeTruthy();
    expect(linkInsert.values).toMatchObject({
      userId: 42,
      accountId: 7,
      itemType: "flight",
      flightId: 55,
      reservationId: null,
      accommodationId: null,
      carRentalId: null,
      googleCalendarId: "cal-1",
      googleEventId: "evt-1",
    });
    expect((linkInsert.values as { lastSyncedHash: string }).lastSyncedHash).toBe(
      hashCalendarEventPayload(mapFlightToCalendarEvent(FLIGHT as never, { tripTitle: "Munich guys' trip" })!),
    );
  });

  it("is idempotent: an unchanged flight re-syncs as a no-op (no create, no update)", async () => {
    const payload = mapFlightToCalendarEvent(FLIGHT as never, { tripTitle: "Munich guys' trip" })!;
    queueSyncBasics([
      {
        id: 1,
        accountId: 7,
        flightId: 55,
        googleCalendarId: "cal-1",
        googleEventId: "evt-1",
        lastSyncedHash: hashCalendarEventPayload(payload),
      },
    ]);
    await syncFlightForUser(42, FLIGHT);
    expect(google.insertCalendarEvent).not.toHaveBeenCalled();
    expect(google.updateCalendarEvent).not.toHaveBeenCalled();
    expect(opsOn("calendar_event_links", "insert")).toHaveLength(0);
  });

  it("a changed flight updates its existing event in place", async () => {
    queueSyncBasics([
      {
        id: 1,
        accountId: 7,
        flightId: 55,
        googleCalendarId: "cal-1",
        googleEventId: "evt-1",
        lastSyncedHash: "stale-hash",
      },
    ]);
    await syncFlightForUser(42, FLIGHT);
    expect(google.insertCalendarEvent).not.toHaveBeenCalled();
    expect(google.updateCalendarEvent).toHaveBeenCalledTimes(1);
    expect(google.updateCalendarEvent.mock.calls[0][2]).toBe("evt-1");
    expect(opsOn("calendar_event_links", "update")).toHaveLength(1);
  });

  it("respects the per-account toggle: write-back off → nothing is written", async () => {
    // The SQL filter excludes disabled accounts; the queue returns none.
    store.selectQueues["connected_accounts"] = [[]];
    await syncFlightForUser(42, FLIGHT);
    expect(google.insertCalendarEvent).not.toHaveBeenCalled();
    expect(opsOn("calendar_event_links", "insert")).toHaveLength(0);
  });

  it("respects the scope gate: an account without the calendar scope is skipped", async () => {
    store.selectQueues["connected_accounts"] = [
      [{ ...ACCOUNT, scopes: "gmail.readonly" }],
    ];
    store.selectQueues["trips"] = [[{ title: "Munich guys' trip" }]];
    await syncFlightForUser(42, FLIGHT);
    expect(google.insertCalendarEvent).not.toHaveBeenCalled();
  });

  it("updateLinkedCalendarEventsForItem pushes an edit to existing flight events", async () => {
    const link = {
      id: 1,
      accountId: 7,
      flightId: 55,
      googleCalendarId: "cal-1",
      googleEventId: "evt-1",
      lastSyncedHash: "stale-hash",
    };
    store.selectQueues["calendar_event_links"] = [[link], [link]];
    store.selectQueues["trips"] = [[{ title: "Munich guys' trip" }]];
    store.selectQueues["connected_accounts"] = [[ACCOUNT]];
    await updateLinkedCalendarEventsForItem({ type: "flight", item: FLIGHT });
    expect(google.updateCalendarEvent).toHaveBeenCalledTimes(1);
    expect(google.updateCalendarEvent.mock.calls[0][2]).toBe("evt-1");
  });
});

describe("stay + car rental write-back", () => {
  it("a stay creates an all-day event with an accommodation link", async () => {
    queueSyncBasics([]);
    await syncAccommodationForUser(42, {
      id: 9,
      tripId: 3,
      name: "Westin Grand Munich",
      address: "Arabellastrasse 6, Munich",
      checkIn: "2026-09-24",
      checkOut: "2026-09-28",
      confirmationCode: "WST-1",
      phone: null,
      notes: null,
    } as never);
    const payload = google.insertCalendarEvent.mock.calls[0][2] as GoogleCalendarEventPayload;
    expect(payload.start).toEqual({ date: "2026-09-24" });
    expect(payload.end).toEqual({ date: "2026-09-28" });
    expect(opsOn("calendar_event_links", "insert")[0].values).toMatchObject({
      itemType: "accommodation",
      accommodationId: 9,
      flightId: null,
    });
  });

  it("a car rental creates a timed event with a car_rental link", async () => {
    queueSyncBasics([]);
    await syncCarRentalForUser(42, {
      id: 4,
      tripId: 3,
      company: "Sixt",
      pickupLocation: "Munich Airport",
      dropoffLocation: "Munich Airport",
      pickupDatetime: "2026-09-24T08:00",
      dropoffDatetime: "2026-09-28T08:00",
      confirmationCode: "9739037749",
      driverName: "Philip Subhan",
      notes: null,
    } as never);
    const payload = google.insertCalendarEvent.mock.calls[0][2] as GoogleCalendarEventPayload;
    expect(payload.summary).toBe("Sixt car rental");
    expect(payload.start).toEqual({ dateTime: "2026-09-24T08:00:00", timeZone: "America/New_York" });
    expect(opsOn("calendar_event_links", "insert")[0].values).toMatchObject({
      itemType: "car_rental",
      carRentalId: 4,
      flightId: null,
    });
  });
});

describe("deletion (the gate-cancellation path)", () => {
  it("deleteLinkedCalendarEventsForItem deletes the flight's Google event and its links", async () => {
    store.selectQueues["calendar_event_links"] = [
      [{ id: 1, accountId: 7, flightId: 55, googleCalendarId: "cal-1", googleEventId: "evt-1" }],
    ];
    store.selectQueues["connected_accounts"] = [[ACCOUNT]];
    await deleteLinkedCalendarEventsForItem("flight", 55);
    expect(google.deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect(google.deleteCalendarEvent.mock.calls[0][1]).toBe("cal-1");
    expect(google.deleteCalendarEvent.mock.calls[0][2]).toBe("evt-1");
    expect(opsOn("calendar_event_links", "delete")).toHaveLength(1);
  });

  it("deleteCalendarEventsByLinks deletes events from captured links with no link lookup", async () => {
    store.selectQueues["connected_accounts"] = [[ACCOUNT]];
    await deleteCalendarEventsByLinks([
      { id: 1, accountId: 7, googleCalendarId: "cal-1", googleEventId: "evt-9" },
    ]);
    expect(google.deleteCalendarEvent).toHaveBeenCalledTimes(1);
    expect(google.deleteCalendarEvent.mock.calls[0][2]).toBe("evt-9");
    // No link-table reads or writes — the caller already unlinked.
    expect(opsOn("calendar_event_links")).toHaveLength(0);
  });
});
