/**
 * Integration tests for the daily briefing routes.
 *
 *   GET  /trips/:tripId/briefing
 *   PUT  /trips/:tripId/briefing
 *   POST /trips/:tripId/briefing/send-now
 *   GET  /trips/:tripId/briefing/preview.pdf
 *
 * Strategy: mock @workspace/db with a lazy dequeue queue (no real Postgres),
 * mock the scheduler/day-sheet/PDF collaborators, mount only the briefings
 * router on a minimal Express app with a fake admin session, then drive
 * requests with the built-in fetch (Node ≥ 18).
 */

import http from "node:http";
import express from "express";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// ── Mock drizzle-orm operators ────────────────────────────────────────────────

vi.mock("drizzle-orm", () => ({
  eq:  (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
}));

// ── Chainable DB mock (lazy dequeue) ──────────────────────────────────────────

const resultQueue: unknown[] = [];

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
  tripBriefingsTable: fakeTable,
  tripsTable:          fakeTable,
  tripParticipantsTable: fakeTable,
  usersTable:          fakeTable,
}));

// ── Mock the scheduler / day-sheet / PDF collaborators ───────────────────────

const mocks = vi.hoisted(() => ({
  todayISO: "2026-09-17",
  sendTripBriefing: vi.fn(
    async (_briefing: unknown, _trip: unknown, _dateISO: string) => ({ sent: true, recipientCount: 2 })
  ),
  attachWeather: vi.fn(async () => {}),
  buildDaySheet: vi.fn(async (tripId: number, dateISO: string) => ({
    tripId,
    date: dateISO,
    dateLabel: "Thu Sep 17",
    weather: null,
  })),
  renderDaySheetPdf: vi.fn(async () => Buffer.from("%PDF-mock")),
}));

vi.mock("../lib/briefingScheduler.js", () => ({
  isValidTimeZone: (tz: string) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  },
  todayInZone: () => mocks.todayISO,
  sendTripBriefing: mocks.sendTripBriefing,
  attachWeather: mocks.attachWeather,
}));

vi.mock("../lib/daySheet.js", () => ({
  buildDaySheet: mocks.buildDaySheet,
}));

vi.mock("../lib/daySheetPdf.js", () => ({
  renderDaySheetPdf: mocks.renderDaySheetPdf,
}));

// ── Test app ──────────────────────────────────────────────────────────────────

async function buildTestApp() {
  const { default: briefingsRouter } = await import("./briefings.js");

  const app = express();
  app.use(express.json());

  // Fake session: userId=1, role="admin" — NOT super_admin, so the
  // trip-scoped middleware exercises its DB participant checks.
  app.use((req: any, _res: any, next: any) => {
    req.session = { userId: 1, role: "admin" };
    next();
  });

  app.use("/api", briefingsRouter);
  return app;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

let server: http.Server;
let base: string;

beforeAll(async () => {
  const app = await buildTestApp();
  await new Promise<void>((resolve) => {
    server = http.createServer(app).listen(0, resolve);
  });
  base = `http://localhost:${(server.address() as { port: number }).port}/api`;
});

afterAll(() => server.close());

beforeEach(() => {
  resultQueue.length = 0;
  mocks.todayISO = "2026-09-17"; // outside the mocked trip window (Sep 24–27)
  vi.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function get(path: string) {
  const res = await fetch(`${base}${path}`);
  const contentType = res.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? ((await res.json()) as any)
    : await res.arrayBuffer();
  return { status: res.status, body, headers: res.headers };
}

async function put(path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function post(path: string) {
  const res = await fetch(`${base}${path}`, { method: "POST" });
  return { status: res.status, body: (await res.json()) as any };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const participantRow = { tripId: 1, userId: 1, isTripAdmin: false };
const adminRow = { tripId: 1, userId: 1, isTripAdmin: true };
const tripRow = {
  id: 1,
  title: "Munich Trip",
  destination: "Munich, Germany",
  startDate: "2026-09-24",
  endDate: "2026-09-27",
  status: "active",
};
const briefingRow = {
  id: 5,
  tripId: 1,
  enabled: true,
  sendTimeLocal: "07:00",
  timezone: "America/New_York",
  extraEmails: ["x@y.z"],
  cachedLat: null,
  cachedLon: null,
  lastSentForDate: null,
  createdAt: new Date("2026-09-01T00:00:00Z"),
  updatedAt: new Date("2026-09-01T00:00:00Z"),
};

// ── GET /trips/:tripId/briefing ───────────────────────────────────────────────

describe("GET /trips/:tripId/briefing", () => {
  it("returns 403 for a non-participant", async () => {
    enqueue([]); // participant check → no row

    const { status, body } = await get("/trips/1/briefing");

    expect(status).toBe(403);
    expect(body.error).toMatch(/trip access/i);
  });

  it("returns 400 for an invalid tripId", async () => {
    const { status } = await get("/trips/abc/briefing");
    expect(status).toBe(400);
  });

  it("returns defaults when no briefing row exists (never 404)", async () => {
    enqueue([participantRow]); // participant check
    enqueue([]); // briefing select → no row

    const { status, body } = await get("/trips/1/briefing");

    expect(status).toBe(200);
    expect(body.tripId).toBe(1);
    expect(body.enabled).toBe(false);
    expect(body.sendTimeLocal).toBe("07:00");
    expect(body.timezone).toBe("America/New_York");
    expect(body.extraEmails).toEqual([]);
    expect(body.lastSentForDate).toBeNull();
  });

  it("returns the persisted settings when a row exists", async () => {
    enqueue([participantRow]);
    enqueue([briefingRow]);

    const { status, body } = await get("/trips/1/briefing");

    expect(status).toBe(200);
    expect(body.id).toBe(5);
    expect(body.enabled).toBe(true);
    expect(body.sendTimeLocal).toBe("07:00");
    expect(body.extraEmails).toEqual(["x@y.z"]);
    expect(typeof body.createdAt).toBe("string");
  });
});

// ── PUT /trips/:tripId/briefing ───────────────────────────────────────────────

describe("PUT /trips/:tripId/briefing", () => {
  const validBody = {
    enabled: true,
    sendTimeLocal: "08:30",
    timezone: "Europe/Berlin",
    extraEmails: ["a@example.com"],
  };

  it("returns 403 for a non-admin participant", async () => {
    enqueue([]); // admin check → no row (not a trip admin)

    const { status } = await put("/trips/1/briefing", validBody);

    expect(status).toBe(403);
  });

  it("inserts a new row when none exists (upsert)", async () => {
    enqueue([adminRow]); // admin check
    enqueue([tripRow]); // trip lookup
    enqueue([]); // briefing select → no row
    enqueue([{ ...briefingRow, id: 9, ...validBody }]); // insert returning

    const { status, body } = await put("/trips/1/briefing", validBody);

    expect(status).toBe(200);
    expect(body.id).toBe(9);
    expect(body.enabled).toBe(true);
    expect(body.sendTimeLocal).toBe("08:30");
    expect(body.timezone).toBe("Europe/Berlin");
    expect(body.extraEmails).toEqual(["a@example.com"]);
  });

  it("updates the existing row when one exists (upsert)", async () => {
    enqueue([adminRow]);
    enqueue([tripRow]);
    enqueue([briefingRow]); // existing row
    enqueue([{ ...briefingRow, enabled: false }]); // update returning

    const { status, body } = await put("/trips/1/briefing", { ...validBody, enabled: false });

    expect(status).toBe(200);
    expect(body.id).toBe(5);
    expect(body.enabled).toBe(false);
  });

  it("returns 400 for an invalid sendTimeLocal", async () => {
    enqueue([adminRow]);

    const { status, body } = await put("/trips/1/briefing", { ...validBody, sendTimeLocal: "25:00" });

    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 for an invalid timezone", async () => {
    enqueue([adminRow]);

    const { status } = await put("/trips/1/briefing", { ...validBody, timezone: "Mars/Olympus" });

    expect(status).toBe(400);
  });

  it("returns 400 for too many extra emails", async () => {
    enqueue([adminRow]);

    const { status } = await put("/trips/1/briefing", {
      ...validBody,
      extraEmails: Array.from({ length: 11 }, (_, i) => `e${i}@example.com`),
    });

    expect(status).toBe(400);
  });

  it("defaults extraEmails to [] when omitted", async () => {
    enqueue([adminRow]);
    enqueue([tripRow]);
    enqueue([]);
    enqueue([{ ...briefingRow, id: 10, extraEmails: [] }]);

    const { status, body } = await put("/trips/1/briefing", {
      enabled: true,
      sendTimeLocal: "07:00",
      timezone: "America/New_York",
    });

    expect(status).toBe(200);
    expect(body.extraEmails).toEqual([]);
  });

  it("returns 404 when the trip does not exist", async () => {
    enqueue([adminRow]);
    enqueue([]); // trip lookup → no row

    const { status } = await put("/trips/999/briefing", validBody);

    expect(status).toBe(404);
  });
});

// ── POST /trips/:tripId/briefing/send-now ─────────────────────────────────────

describe("POST /trips/:tripId/briefing/send-now", () => {
  it("returns 403 for a non-admin participant", async () => {
    enqueue([]);

    const { status } = await post("/trips/1/briefing/send-now");

    expect(status).toBe(403);
  });

  it("returns 404 when the trip does not exist", async () => {
    enqueue([adminRow]);
    enqueue([]);

    const { status } = await post("/trips/999/briefing/send-now");

    expect(status).toBe(404);
  });

  it("sends with defaults when no briefing row exists (and creates no row)", async () => {
    enqueue([adminRow]);
    enqueue([tripRow]);
    enqueue([]); // no briefing row

    const { status, body } = await post("/trips/1/briefing/send-now");

    expect(status).toBe(200);
    expect(body).toEqual({ sent: true, recipientCount: 2 });
    expect(mocks.sendTripBriefing).toHaveBeenCalledTimes(1);
    const [briefingArg, tripArg, dateArg] = mocks.sendTripBriefing.mock.calls[0] as [
      any,
      any,
      string,
    ];
    expect(briefingArg.enabled).toBe(false); // transient defaults
    expect(briefingArg.id).toBeUndefined(); // no persisted row → no id
    expect(tripArg.id).toBe(1);
    expect(dateArg).toBe("2026-09-24"); // today (2026-09-17) is outside the trip window → trip start
  });

  it("honours an explicit ?date= parameter", async () => {
    enqueue([adminRow]);
    enqueue([tripRow]);
    enqueue([briefingRow]);

    const { status, body } = await post("/trips/1/briefing/send-now?date=2026-09-20");

    expect(status).toBe(200);
    expect(body.sent).toBe(true);
    expect(mocks.sendTripBriefing.mock.calls[0]?.[2]).toBe("2026-09-20");
  });

  it("returns 400 for a malformed ?date=", async () => {
    enqueue([adminRow]);
    enqueue([tripRow]);
    enqueue([briefingRow]);

    const { status, body } = await post("/trips/1/briefing/send-now?date=not-a-date");

    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(mocks.sendTripBriefing).not.toHaveBeenCalled();
  });
});

// ── GET /trips/:tripId/briefing/preview.pdf ───────────────────────────────────

describe("GET /trips/:tripId/briefing/preview.pdf", () => {
  it("returns 403 for a non-participant", async () => {
    enqueue([]);

    const { status } = await get("/trips/1/briefing/preview.pdf");

    expect(status).toBe(403);
  });

  it("renders the PDF inline for a participant", async () => {
    enqueue([participantRow]);
    enqueue([tripRow]);
    enqueue([briefingRow]);

    const { status, body, headers } = await get("/trips/1/briefing/preview.pdf");

    expect(status).toBe(200);
    expect(headers.get("content-type")).toContain("application/pdf");
    expect(headers.get("content-disposition")).toContain("inline");
    expect(headers.get("content-disposition")).toContain("wander-preview-1-2026-09-24.pdf");
    expect(Buffer.from(body as ArrayBuffer).toString()).toBe("%PDF-mock");
    expect(mocks.buildDaySheet).toHaveBeenCalledWith(1, "2026-09-24"); // today outside trip window → day 1
    expect(mocks.attachWeather).toHaveBeenCalledTimes(1);
    expect(mocks.renderDaySheetPdf).toHaveBeenCalledTimes(1);
  });

  it("uses today when it falls inside the trip window", async () => {
    mocks.todayISO = "2026-09-25";
    enqueue([participantRow]);
    enqueue([tripRow]);
    enqueue([briefingRow]);

    const { status } = await get("/trips/1/briefing/preview.pdf");

    expect(status).toBe(200);
    expect(mocks.buildDaySheet).toHaveBeenCalledWith(1, "2026-09-25");
  });

  it("honours ?date= in the preview", async () => {
    enqueue([participantRow]);
    enqueue([tripRow]);
    enqueue([]);

    const { status, headers } = await get("/trips/1/briefing/preview.pdf?date=2026-09-20");

    expect(status).toBe(200);
    expect(mocks.buildDaySheet).toHaveBeenCalledWith(1, "2026-09-20");
    expect(headers.get("content-disposition")).toContain("wander-preview-1-2026-09-20.pdf");
  });
});
