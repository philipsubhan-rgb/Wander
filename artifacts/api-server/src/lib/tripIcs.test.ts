/**
 * Unit tests for the ICS itinerary export (../lib/tripIcs).
 *
 * Mocks @workspace/db and the timeline builder so no Postgres is needed.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@workspace/db", () => ({
  db: { select: vi.fn() },
  tripsTable: new Proxy({}, { get: (_t, p) => p }),
}));

const mockBuildTimelineEvents = vi.fn();

vi.mock("./timeline.js", () => ({
  buildTimelineEvents: (...args: unknown[]) => mockBuildTimelineEvents(...args),
}));

import { db } from "@workspace/db";
import {
  buildTripIcs,
  escapeIcsText,
  foldIcsLine,
  toFloatingLocal,
  addMinutesToFloating,
} from "./tripIcs.js";

const tripRow = { id: 1, title: "Munich Trip" };

function mockTripRow(row: unknown) {
  (db.select as any).mockReturnValue({
    from: () => ({ where: () => Promise.resolve(row ? [row] : []) }),
  });
}

const sampleEvents = [
  {
    id: 1,
    type: "activity",
    date: "2026-09-24",
    title: "BMW Welt, 3:00 PM",
    description: null,
    location: "Am Olympiapark 1",
    time: "15:00",
    imageUrl: null,
    carrierCode: null,
    confirmationCode: null,
  },
  {
    id: 2,
    type: "reservation",
    date: "2026-09-24",
    title: "Schneider Bräuhaus",
    description: "Dinner; arrive early, bring cash",
    location: "Tal 7",
    time: "19:30",
    imageUrl: null,
    carrierCode: null,
    confirmationCode: "125113",
  },
  {
    id: 3,
    type: "activity",
    date: "2026-09-25",
    title: "Free morning, explore",
    description: null,
    location: null,
    time: null,
    imageUrl: null,
    carrierCode: null,
    confirmationCode: null,
  },
  {
    id: 4,
    type: "itinerary",
    date: "2026-09-24",
    title: "Day 1 notes",
    description: "should be excluded",
    location: null,
    time: null,
    imageUrl: null,
    carrierCode: null,
    confirmationCode: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockTripRow(tripRow);
  mockBuildTimelineEvents.mockResolvedValue(sampleEvents);
});

describe("escapeIcsText", () => {
  it("escapes commas, semicolons, backslashes and newlines", () => {
    expect(escapeIcsText("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
  });
});

describe("foldIcsLine", () => {
  it("leaves short lines alone", () => {
    expect(foldIcsLine("SUMMARY:hi")).toBe("SUMMARY:hi");
  });

  it("folds long lines at 75 octets with CRLF + space", () => {
    const folded = foldIcsLine("SUMMARY:" + "x".repeat(100));
    expect(folded).toContain("\r\n ");
    for (const piece of folded.split("\r\n ")) {
      expect(Buffer.byteLength(piece, "utf8")).toBeLessThanOrEqual(75);
    }
  });
});

describe("toFloatingLocal / addMinutesToFloating", () => {
  it("converts date + time to a floating timestamp", () => {
    expect(toFloatingLocal("2026-09-24", "17:15")).toBe("20260924T171500");
  });

  it("adds minutes across midnight", () => {
    expect(addMinutesToFloating("20260924T233000", 90)).toBe("20260925T010000");
  });
});

describe("buildTripIcs", () => {
  it("builds a well-formed calendar with one VEVENT per non-itinerary event", async () => {
    const { ics, filename, eventCount } = await buildTripIcs(1);

    expect(filename).toBe("wander-itinerary-1.ics");
    expect(eventCount).toBe(3);
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("END:VCALENDAR");
    expect(ics).toContain("X-WR-CALNAME:Munich Trip");
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(ics).not.toContain("Day 1 notes"); // itinerary rows excluded
  });

  it("gives timed events DTSTART/DTEND and untimed events all-day dates", async () => {
    const { ics } = await buildTripIcs(1);

    expect(ics).toContain("DTSTART:20260924T150000");
    expect(ics).toContain("DTEND:20260924T170000"); // activity → 2h default
    expect(ics).toContain("DTSTART:20260924T193000");
    expect(ics).toContain("DTEND:20260924T213000"); // reservation → 2h default
    expect(ics).toContain("DTSTART;VALUE=DATE:20260925");
  });

  it("includes location and confirmation in the event", async () => {
    const { ics } = await buildTripIcs(1);
    const unfolded = ics.replace(/\r\n /g, ""); // undo ICS line folding

    expect(unfolded).toContain("LOCATION:Tal 7");
    expect(unfolded).toContain("DESCRIPTION:Where: Tal 7\\nConfirmation: 125113\\nDinner\\; arrive early\\, bring cash");
  });

  it("uses stable UIDs so re-imports update rather than duplicate", async () => {
    const first = await buildTripIcs(1);
    const second = await buildTripIcs(1);
    const uids = (r: { ics: string }) => r.ics.match(/UID:[^\r\n]+/g) ?? [];
    expect(uids(first)).toEqual(uids(second));
    expect(uids(first)[0]).toBe("UID:wander-1-2026-09-24-0@wander");
  });

  it("throws when the trip does not exist", async () => {
    mockTripRow(null);
    await expect(buildTripIcs(999)).rejects.toThrow(/not found/);
  });
});
