/**
 * Unit tests for the pure day-sheet helpers in ../lib/daySheet.
 *
 * buildDaySheet itself touches the DB, so these tests cover the pure,
 * extractable pieces: date-label formatting, day-number/day-count math,
 * item sorting (null times last), and stay-tonight selection.
 */

import { describe, it, expect, vi } from "vitest";

// daySheet.ts imports @workspace/db at module top level, and the real module
// throws when DATABASE_URL is unset. These tests only cover the pure helpers,
// so mock the DB module the same way the route tests do.
vi.mock("@workspace/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() },
  tripsTable: new Proxy({}, { get: (_t, p) => p }),
  accommodationsTable: new Proxy({}, { get: (_t, p) => p }),
  tripBriefingsTable: new Proxy({}, { get: (_t, p) => p }),
}));

import {
  formatDayLabel,
  dayNumberFor,
  dayCountFor,
  tripDates,
  sortDayItems,
  pickStayTonight,
  timelineEventToItem,
  type DaySheetItem,
} from "./daySheet.js";

describe("formatDayLabel", () => {
  it('formats "2026-09-24" as "Thursday, September 24" in America/New_York', () => {
    expect(formatDayLabel("2026-09-24", "America/New_York")).toBe("Thursday, September 24");
  });

  it("formats in the trip's briefing timezone (Munich day sheet example)", () => {
    // Same calendar date rendered from a different zone — the date must not shift.
    expect(formatDayLabel("2026-09-24", "Europe/Berlin")).toBe("Thursday, September 24");
  });

  it("formats year-boundary dates correctly", () => {
    expect(formatDayLabel("2026-01-01", "America/New_York")).toBe("Thursday, January 1");
  });
});

describe("dayNumberFor", () => {
  it("returns 1 for the first day of the trip", () => {
    expect(dayNumberFor("2026-09-24", "2026-09-24")).toBe(1);
  });

  it("returns 3 for the third day", () => {
    expect(dayNumberFor("2026-09-26", "2026-09-24")).toBe(3);
  });

  it("clamps dates before the trip start to day 1", () => {
    expect(dayNumberFor("2026-09-20", "2026-09-24")).toBe(1);
  });
});

describe("dayCountFor", () => {
  it("counts a 4-day trip (Sep 24–27) as 4", () => {
    expect(dayCountFor("2026-09-24", "2026-09-27")).toBe(4);
  });

  it("counts a single-day trip as 1", () => {
    expect(dayCountFor("2026-09-24", "2026-09-24")).toBe(1);
  });
});

describe("tripDates", () => {
  it("lists every date from start through end, inclusive", () => {
    expect(tripDates("2026-09-24", "2026-09-27")).toEqual([
      "2026-09-24",
      "2026-09-25",
      "2026-09-26",
      "2026-09-27",
    ]);
  });

  it("returns a single-element list for a one-day trip", () => {
    expect(tripDates("2026-09-24", "2026-09-24")).toEqual(["2026-09-24"]);
  });

  it("falls back to the start date on a degenerate range", () => {
    expect(tripDates("2026-09-27", "2026-09-24")).toEqual(["2026-09-27"]);
  });
});

describe("sortDayItems", () => {
  const mk = (overrides: Partial<DaySheetItem>): DaySheetItem => ({
    time: null,
    title: "x",
    location: null,
    confirmationCode: null,
    type: "activity",
    ...overrides,
  });

  it("sorts by time ascending", () => {
    const sorted = sortDayItems([
      mk({ title: "late", time: "18:00" }),
      mk({ title: "early", time: "09:00" }),
    ]);
    expect(sorted.map(i => i.title)).toEqual(["early", "late"]);
  });

  it("puts null-time items last", () => {
    const sorted = sortDayItems([
      mk({ title: "all-day", time: null }),
      mk({ title: "morning", time: "08:30" }),
    ]);
    expect(sorted.map(i => i.title)).toEqual(["morning", "all-day"]);
  });

  it("keeps relative order among multiple null-time items", () => {
    const sorted = sortDayItems([
      mk({ title: "a", time: null }),
      mk({ title: "b", time: "10:00" }),
      mk({ title: "c", time: null }),
    ]);
    expect(sorted.map(i => i.title)).toEqual(["b", "a", "c"]);
  });

  it("treats midnight 00:00 as a real time, not null", () => {
    const sorted = sortDayItems([
      mk({ title: "no-time", time: null }),
      mk({ title: "midnight", time: "00:00" }),
    ]);
    expect(sorted.map(i => i.title)).toEqual(["midnight", "no-time"]);
  });
});

describe("pickStayTonight", () => {
  const stays = [
    { name: "Hotel Alpha", address: "1 Alpha St", checkIn: "2026-09-24", checkOut: "2026-09-26" },
    { name: "Hotel Beta",  address: null,        checkIn: "2026-09-26", checkOut: "2026-09-28" },
  ];

  it("picks the stay whose range contains the date (inclusive check-in)", () => {
    expect(pickStayTonight(stays, "2026-09-24")).toEqual({
      name: "Hotel Alpha",
      address: "1 Alpha St",
    });
  });

  it("treats the check-out date as belonging to the next stay", () => {
    expect(pickStayTonight(stays, "2026-09-26")).toEqual({
      name: "Hotel Beta",
      address: null,
    });
  });

  it("returns null when no stay covers the date", () => {
    expect(pickStayTonight(stays, "2026-09-29")).toBeNull();
  });

  it("handles datetime-format check-in/out strings by truncating to the date", () => {
    expect(
      pickStayTonight(
        [{ name: "Late Hotel", address: null, checkIn: "2026-09-24T15:00", checkOut: "2026-09-26T11:00" }],
        "2026-09-25",
      ),
    ).toEqual({ name: "Late Hotel", address: null });
  });

  it("picks the first stay when ranges overlap", () => {
    const overlapping = [
      { name: "First", address: null, checkIn: "2026-09-24", checkOut: "2026-09-27" },
      { name: "Second", address: null, checkIn: "2026-09-25", checkOut: "2026-09-28" },
    ];
    expect(pickStayTonight(overlapping, "2026-09-25")?.name).toBe("First");
  });
});

describe("timelineEventToItem", () => {
  it("maps the relevant fields onto a DaySheetItem", () => {
    expect(
      timelineEventToItem({
        id: 7,
        type: "flight",
        date: "2026-09-24",
        title: "Lufthansa LH401: JFK → FRA",
        description: "notes",
        location: "JFK",
        time: "18:45",
        imageUrl: null,
        carrierCode: "LH",
        confirmationCode: "ABC123",
      }),
    ).toEqual({
      time: "18:45",
      title: "Lufthansa LH401: JFK → FRA",
      location: "JFK",
      confirmationCode: "ABC123",
      type: "flight",
      description: "notes",
      photoUrl: null,
    });
  });
});
