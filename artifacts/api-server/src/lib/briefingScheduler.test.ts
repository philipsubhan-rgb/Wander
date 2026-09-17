/**
 * Unit tests for the daily briefing scheduler.
 *
 * Strategy:
 *   - Pure helpers (todayInZone / nowHMInZone / isBriefingDue) are tested
 *     directly with fixed instants.
 *   - sendTripBriefing / runBriefingTick are tested with the DB behind a
 *     lazy-dequeue mock (same harness as the route tests), and the
 *     day-sheet / weather / PDF / email collaborators mocked via vi.mock.
 *   - The scheduler module is imported dynamically in beforeAll so the
 *     vi.mock factories can reference the module-level queue safely.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { Trip, TripBriefing } from "@workspace/db";

// ── Hoisted mock functions ────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  buildDaySheet: vi.fn(),
  geocodeDestination: vi.fn(),
  fetchWeatherForDate: vi.fn(),
  renderDaySheetPdf: vi.fn(),
  sendDailyBriefingEmail: vi.fn(),
  schedule: vi.fn(),
}));

vi.mock("node-cron", () => ({
  default: { schedule: mocks.schedule },
}));

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
}));

vi.mock("./daySheet.js", () => ({
  buildDaySheet: mocks.buildDaySheet,
}));

vi.mock("./weather.js", () => ({
  geocodeDestination: mocks.geocodeDestination,
  fetchWeatherForDate: mocks.fetchWeatherForDate,
}));

vi.mock("./daySheetPdf.js", () => ({
  renderDaySheetPdf: mocks.renderDaySheetPdf,
}));

vi.mock("./email.js", () => ({
  sendDailyBriefingEmail: mocks.sendDailyBriefingEmail,
}));

// ── Lazy-dequeue DB mock ──────────────────────────────────────────────────────

const resultQueue: unknown[] = [];
const setCalls: unknown[] = [];

function enqueue(...items: unknown[]) {
  resultQueue.push(...items);
}

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

  for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy", "values", "returning"]) {
    chain[m] = () => chain;
  }
  // Capture update patches so tests can assert lastSentForDate / cachedLat writes.
  chain.set = (patch: unknown) => {
    setCalls.push(patch);
    return chain;
  };
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
  tripBriefingsTable: fakeTable,
  tripsTable:          fakeTable,
  tripParticipantsTable: fakeTable,
  usersTable:          fakeTable,
}));

// ── Module under test (dynamic import — see header comment) ───────────────────

let scheduler: typeof import("./briefingScheduler.js");

beforeAll(async () => {
  scheduler = await import("./briefingScheduler.js");
});

beforeEach(() => {
  resultQueue.length = 0;
  setCalls.length = 0;
  vi.clearAllMocks();

  mocks.buildDaySheet.mockImplementation(async (tripId: number, dateISO: string) => ({
    tripId,
    date: dateISO,
    dateLabel: "Thu Sep 17",
    weather: null,
  }));
  mocks.geocodeDestination.mockResolvedValue(null);
  mocks.fetchWeatherForDate.mockResolvedValue({
    highF: 70, lowF: 55, condition: "Sunny", precipitationChance: 10,
  });
  mocks.renderDaySheetPdf.mockResolvedValue(Buffer.from("%PDF-mock"));
  mocks.sendDailyBriefingEmail.mockResolvedValue({ sent: true });
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

type BriefingOverrides = Partial<
  Pick<
    TripBriefing,
    "sendTimeLocal" | "lastSentForDate" | "cachedLat" | "cachedLon" | "timezone" | "extraEmails"
  >
>;

function makeBriefing(overrides: BriefingOverrides = {}) {
  return {
    id: 5,
    tripId: 1,
    enabled: true,
    sendTimeLocal: "07:00",
    timezone: "America/New_York",
    extraEmails: [] as string[],
    cachedLat: null as number | null,
    cachedLon: null as number | null,
    lastSentForDate: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

type TripOverrides = Partial<Pick<Trip, "status" | "startDate" | "endDate">> & {
  title?: string;
  destination?: string;
};

function makeTrip(overrides: TripOverrides = {}) {
  return {
    id: 1,
    title: "Munich Trip",
    destination: "Munich, Germany",
    status: "active" as Trip["status"],
    startDate: "2026-09-24",
    endDate: "2026-09-27",
    ...overrides,
  };
}

// ── todayInZone / nowHMInZone ─────────────────────────────────────────────────

describe("todayInZone", () => {
  it("returns the calendar date in the given timezone", () => {
    // 04:59 UTC = 06:59 CEST (Berlin)
    expect(scheduler.todayInZone("Europe/Berlin", new Date("2026-09-17T04:59:00Z")))
      .toBe("2026-09-17");
  });

  it("handles the America/New_York midnight boundary", () => {
    // 03:59 UTC = 23:59 EDT on Sep 16
    expect(scheduler.todayInZone("America/New_York", new Date("2026-09-17T03:59:00Z")))
      .toBe("2026-09-16");
    // 04:00 UTC = 00:00 EDT on Sep 17
    expect(scheduler.todayInZone("America/New_York", new Date("2026-09-17T04:00:00Z")))
      .toBe("2026-09-17");
  });

  it("falls back to UTC on an invalid timezone", () => {
    expect(scheduler.todayInZone("Bogus/Zone", new Date("2026-09-17T00:30:00Z")))
      .toBe("2026-09-17");
  });
});

describe("nowHMInZone", () => {
  it("returns 24h HH:MM in the given timezone", () => {
    expect(scheduler.nowHMInZone("Europe/Berlin", new Date("2026-09-17T04:59:00Z")))
      .toBe("06:59");
    expect(scheduler.nowHMInZone("Europe/Berlin", new Date("2026-09-17T05:01:00Z")))
      .toBe("07:01");
  });

  it("handles the America/New_York edge", () => {
    expect(scheduler.nowHMInZone("America/New_York", new Date("2026-09-17T03:59:00Z")))
      .toBe("23:59");
  });

  it("falls back to UTC on an invalid timezone", () => {
    expect(scheduler.nowHMInZone("Bogus/Zone", new Date("2026-09-17T05:01:00Z")))
      .toBe("05:01");
  });
});

// ── isBriefingDue ─────────────────────────────────────────────────────────────

describe("isBriefingDue", () => {
  const briefing = () => makeBriefing();
  const trip = () => makeTrip({ status: "confirmed", startDate: "2026-09-24", endDate: "2026-09-27" });

  it("is true when everything lines up", () => {
    expect(scheduler.isBriefingDue(briefing(), trip(), "2026-09-25", "07:00")).toBe(true);
    expect(scheduler.isBriefingDue(briefing(), trip(), "2026-09-25", "09:30")).toBe(true);
  });

  it("is false when already sent today", () => {
    expect(scheduler.isBriefingDue(
      makeBriefing({ lastSentForDate: "2026-09-25" }), trip(), "2026-09-25", "09:30"
    )).toBe(false);
  });

  it("is false for non-live trip statuses", () => {
    for (const status of ["planning", "completed"] as const) {
      expect(scheduler.isBriefingDue(
        briefing(), makeTrip({ status, startDate: "2026-09-24", endDate: "2026-09-27" }),
        "2026-09-25", "09:30"
      )).toBe(false);
    }
    expect(scheduler.isBriefingDue(
      briefing(), makeTrip({ status: "active", startDate: "2026-09-24", endDate: "2026-09-27" }),
      "2026-09-25", "09:30"
    )).toBe(true);
  });

  it("is false when today is outside the trip date range", () => {
    expect(scheduler.isBriefingDue(briefing(), trip(), "2026-09-23", "09:30")).toBe(false);
    expect(scheduler.isBriefingDue(briefing(), trip(), "2026-09-28", "09:30")).toBe(false);
    // boundary days are in range
    expect(scheduler.isBriefingDue(briefing(), trip(), "2026-09-24", "09:30")).toBe(true);
    expect(scheduler.isBriefingDue(briefing(), trip(), "2026-09-27", "09:30")).toBe(true);
  });

  it("is false before the configured send time", () => {
    expect(scheduler.isBriefingDue(briefing(), trip(), "2026-09-25", "06:59")).toBe(false);
    expect(scheduler.isBriefingDue(briefing(), trip(), "2026-09-25", "07:00")).toBe(true);
  });
});

// ── sendTripBriefing ──────────────────────────────────────────────────────────

describe("sendTripBriefing", () => {
  it("sends the email and marks lastSentForDate on success", async () => {
    const briefing = makeBriefing({
      cachedLat: 48.1351,
      cachedLon: 11.582,
      extraEmails: ["Extra@Example.com"],
    });
    const trip = makeTrip();

    // 1. recipients select: participant emails (dupe + case + blank included)
    enqueue([
      { email: "Alice@Example.com" },
      { email: "alice@example.com" },
      { email: "   " },
    ]);
    // 2. update lastSentForDate
    enqueue([]);

    const result = await scheduler.sendTripBriefing(briefing as any, trip as any, "2026-09-25");

    expect(result).toEqual({ sent: true, recipientCount: 2 });
    expect(mocks.sendDailyBriefingEmail).toHaveBeenCalledTimes(1);
    const emailArgs = mocks.sendDailyBriefingEmail.mock.calls[0][0];
    expect(emailArgs.to).toEqual(["alice@example.com", "extra@example.com"]);
    expect(emailArgs.tripTitle).toBe("Munich Trip");
    expect(emailArgs.dateLabel).toBe("Thu Sep 17");
    expect(emailArgs.filename).toBe("wander-one-pager-1-2026-09-25.pdf");
    expect(Buffer.isBuffer(emailArgs.pdfBuffer)).toBe(true);
    // lastSentForDate was persisted
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({ lastSentForDate: "2026-09-25" });
  });

  it("does not mark sent when the email fails", async () => {
    const briefing = makeBriefing({ cachedLat: 48.1351, cachedLon: 11.582 });
    mocks.sendDailyBriefingEmail.mockResolvedValue({ sent: false });

    enqueue([{ email: "alice@example.com" }]);

    const result = await scheduler.sendTripBriefing(briefing as any, makeTrip() as any, "2026-09-25");

    expect(result).toEqual({ sent: false, recipientCount: 1 });
    expect(setCalls).toHaveLength(0);
  });

  it("returns without sending when there are no recipients", async () => {
    const briefing = makeBriefing({ cachedLat: 48.1351, cachedLon: 11.582 });

    enqueue([]); // no participant emails, no extra emails

    const result = await scheduler.sendTripBriefing(briefing as any, makeTrip() as any, "2026-09-25");

    expect(result).toEqual({ sent: false, recipientCount: 0 });
    expect(mocks.sendDailyBriefingEmail).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
  });

  it("geocodes fresh coordinates, caches them, and still sends when weather fails", async () => {
    const briefing = makeBriefing(); // no cached coords
    mocks.geocodeDestination.mockResolvedValue({ lat: 48.1351, lon: 11.582 });
    mocks.fetchWeatherForDate.mockResolvedValue(null);

    enqueue([]); // 1. cache update after geocode
    enqueue([{ email: "alice@example.com" }]); // 2. recipients
    enqueue([]); // 3. lastSentForDate update

    const result = await scheduler.sendTripBriefing(briefing as any, makeTrip() as any, "2026-09-25");

    expect(result.sent).toBe(true);
    expect(mocks.geocodeDestination).toHaveBeenCalledWith("Munich, Germany");
    // cachedLat/cachedLon persisted even though the weather fetch returned null
    expect(setCalls[0]).toMatchObject({ cachedLat: 48.1351, cachedLon: 11.582 });
    expect(setCalls[1]).toMatchObject({ lastSentForDate: "2026-09-25" });
  });

  it("does not throw on exception and does not mark sent", async () => {
    const briefing = makeBriefing({ cachedLat: 48.1351, cachedLon: 11.582 });
    mocks.buildDaySheet.mockRejectedValueOnce(new Error("day sheet exploded"));

    const result = await scheduler.sendTripBriefing(briefing as any, makeTrip() as any, "2026-09-25");

    expect(result).toEqual({ sent: false, recipientCount: 0 });
    expect(mocks.sendDailyBriefingEmail).not.toHaveBeenCalled();
    expect(setCalls).toHaveLength(0);
  });
});

// ── runBriefingTick ───────────────────────────────────────────────────────────

describe("runBriefingTick", () => {
  // 12:00 UTC = 08:00 EDT → today 2026-09-17, nowHM 08:00 ≥ 07:00
  const tickNow = new Date("2026-09-17T12:00:00Z");

  it("sends a due briefing and marks it sent", async () => {
    enqueue([
      {
        briefing: makeBriefing(),
        trip: makeTrip({ status: "active", startDate: "2026-09-01", endDate: "2026-09-30" }),
      },
    ]);
    enqueue([{ email: "alice@example.com" }]); // recipients
    enqueue([]); // lastSentForDate update

    await scheduler.runBriefingTick(tickNow);

    expect(mocks.sendDailyBriefingEmail).toHaveBeenCalledTimes(1);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]).toMatchObject({ lastSentForDate: "2026-09-17" });
  });

  it("skips a briefing already sent today", async () => {
    enqueue([
      {
        briefing: makeBriefing({ lastSentForDate: "2026-09-17" }),
        trip: makeTrip({ status: "active", startDate: "2026-09-01", endDate: "2026-09-30" }),
      },
    ]);

    await scheduler.runBriefingTick(tickNow);

    expect(mocks.sendDailyBriefingEmail).not.toHaveBeenCalled();
  });

  it("skips rows with an invalid timezone without failing the tick", async () => {
    enqueue([
      {
        briefing: makeBriefing({ timezone: "Not/AZone" }),
        trip: makeTrip({ status: "active", startDate: "2026-09-01", endDate: "2026-09-30" }),
      },
      {
        briefing: makeBriefing(),
        trip: makeTrip({ status: "active", startDate: "2026-09-01", endDate: "2026-09-30" }),
      },
    ]);
    enqueue([{ email: "alice@example.com" }]); // recipients for the valid row
    enqueue([]); // lastSentForDate update for the valid row

    await scheduler.runBriefingTick(tickNow);

    // Only the valid row was sent
    expect(mocks.sendDailyBriefingEmail).toHaveBeenCalledTimes(1);
  });

  it("skips trips that are still planning", async () => {
    enqueue([
      {
        briefing: makeBriefing(),
        trip: makeTrip({ status: "planning", startDate: "2026-09-01", endDate: "2026-09-30" }),
      },
    ]);

    await scheduler.runBriefingTick(tickNow);

    expect(mocks.sendDailyBriefingEmail).not.toHaveBeenCalled();
  });
});

// ── startBriefingScheduler ────────────────────────────────────────────────────

describe("startBriefingScheduler", () => {
  it("schedules a 15-minute cron job without ticking immediately", () => {
    scheduler.startBriefingScheduler();

    expect(mocks.schedule).toHaveBeenCalledTimes(1);
    expect(mocks.schedule.mock.calls[0][0]).toBe("*/15 * * * *");
    // No immediate send — the email mock stays silent
    expect(mocks.sendDailyBriefingEmail).not.toHaveBeenCalled();
  });
});
