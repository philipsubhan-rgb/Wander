/**
 * Unit tests for Google Calendar write-back: event mapping, sync planning
 * (idempotency), time parsing, and the scope/state helpers it relies on.
 * Pure logic — no Express server, no DB, no Google calls.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  parseTimeToMinutes,
  floatingDateTime,
  addDays,
  mapReservationToCalendarEvent,
  hashCalendarEventPayload,
  planEventSync,
  type MappableReservation,
} from "./calendarEventMapping.js";
import {
  parseScopes,
  mergeScopes,
  hasCalendarScope,
  newOAuthState,
  verifyState,
} from "./scanLogic.js";

const base: MappableReservation = {
  id: 42,
  type: "restaurant",
  title: "Dinner at Schneider Bräuhaus",
  venue: "Schneider Bräuhaus",
  address: "Tal 7, Munich",
  date: "2026-09-24",
  time: "19:30",
  endTime: null,
  confirmationCode: "125113",
  numberOfPeople: 5,
  notes: null,
  url: null,
};

describe("parseTimeToMinutes", () => {
  it("parses 24h times", () => {
    expect(parseTimeToMinutes("19:30")).toBe(1170);
    expect(parseTimeToMinutes("9:05")).toBe(545);
    expect(parseTimeToMinutes("00:00")).toBe(0);
  });

  it("parses 12h times from the Gmail parser", () => {
    expect(parseTimeToMinutes("7:30 PM")).toBe(1170);
    expect(parseTimeToMinutes("7:30PM")).toBe(1170);
    expect(parseTimeToMinutes("8:00 AM")).toBe(480);
    expect(parseTimeToMinutes("12:00 PM")).toBe(720);
    expect(parseTimeToMinutes("12:00 AM")).toBe(0);
    expect(parseTimeToMinutes("12:30 am")).toBe(30);
  });

  it("rejects garbage", () => {
    expect(parseTimeToMinutes("25:00")).toBeNull();
    expect(parseTimeToMinutes("7:60 PM")).toBeNull();
    expect(parseTimeToMinutes("13:00 PM")).toBeNull();
    expect(parseTimeToMinutes("soon")).toBeNull();
    expect(parseTimeToMinutes(null)).toBeNull();
    expect(parseTimeToMinutes(undefined)).toBeNull();
    expect(parseTimeToMinutes("")).toBeNull();
  });
});

describe("floatingDateTime / addDays", () => {
  it("formats a floating local datetime", () => {
    expect(floatingDateTime("2026-09-24", 1170)).toBe("2026-09-24T19:30:00");
  });

  it("rolls past midnight into the next day", () => {
    expect(floatingDateTime("2026-09-24", 1410 + 120)).toBe("2026-09-25T01:30:00");
  });

  it("adds days across month boundaries", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("mapReservationToCalendarEvent", () => {
  it("maps a timed reservation with the default 2h duration", () => {
    const ev = mapReservationToCalendarEvent(base, {
      timeZone: "Europe/Berlin",
      tripTitle: "Munich 2026",
    });
    expect(ev).not.toBeNull();
    expect(ev!.summary).toBe("Dinner at Schneider Bräuhaus");
    expect(ev!.location).toBe("Schneider Bräuhaus, Tal 7, Munich");
    expect(ev!.start).toEqual({ dateTime: "2026-09-24T19:30:00", timeZone: "Europe/Berlin" });
    expect(ev!.end).toEqual({ dateTime: "2026-09-24T21:30:00", timeZone: "Europe/Berlin" });
    expect(ev!.description).toContain("Confirmation: 125113");
    expect(ev!.description).toContain("Party of 5");
    expect(ev!.description).toContain("Trip: Munich 2026");
  });

  it("honors an explicit end time", () => {
    const ev = mapReservationToCalendarEvent({ ...base, endTime: "23:00" });
    expect(ev!.end).toEqual({ dateTime: "2026-09-24T23:00:00" });
  });

  it("falls back to the default duration when end <= start", () => {
    const ev = mapReservationToCalendarEvent({ ...base, endTime: "18:00" });
    expect(ev!.end).toEqual({ dateTime: "2026-09-24T21:30:00" });
  });

  it("accepts 12h parser times", () => {
    const ev = mapReservationToCalendarEvent({ ...base, time: "7:30 PM", endTime: null });
    expect(ev!.start).toEqual({ dateTime: "2026-09-24T19:30:00" });
  });

  it("maps untimed reservations to all-day events with an exclusive end", () => {
    const ev = mapReservationToCalendarEvent({ ...base, time: null });
    expect(ev!.start).toEqual({ date: "2026-09-24" });
    expect(ev!.end).toEqual({ date: "2026-09-25" });
  });

  it("treats an unparseable time as untimed", () => {
    const ev = mapReservationToCalendarEvent({ ...base, time: "whenever" });
    expect(ev!.start).toEqual({ date: "2026-09-24" });
  });

  it("returns null for an unusable date", () => {
    expect(mapReservationToCalendarEvent({ ...base, date: "Sept 24" })).toBeNull();
    expect(mapReservationToCalendarEvent({ ...base, date: "" })).toBeNull();
  });

  it("omits location/description parts that are absent", () => {
    const ev = mapReservationToCalendarEvent({
      ...base,
      venue: null,
      address: null,
      confirmationCode: null,
      numberOfPeople: null,
    });
    expect(ev!.location).toBeUndefined();
    expect(ev!.description).toBe("Booked via Wander");
  });
});

describe("hashCalendarEventPayload / planEventSync (idempotency)", () => {
  const payload = mapReservationToCalendarEvent(base)!;

  it("hashes identical payloads identically", () => {
    const again = mapReservationToCalendarEvent({ ...base })!;
    expect(hashCalendarEventPayload(again)).toBe(hashCalendarEventPayload(payload));
  });

  it("hash changes when the booking changes", () => {
    const moved = mapReservationToCalendarEvent({ ...base, time: "20:00" })!;
    expect(hashCalendarEventPayload(moved)).not.toBe(hashCalendarEventPayload(payload));
  });

  it("creates when there is no link yet", () => {
    expect(planEventSync(null, payload)).toEqual({ action: "create" });
  });

  it("skips when the stored hash matches (re-accept / re-scan is a no-op)", () => {
    const link = { googleEventId: "evt_1", lastSyncedHash: hashCalendarEventPayload(payload) };
    expect(planEventSync(link, payload)).toEqual({ action: "skip", googleEventId: "evt_1" });
  });

  it("updates the stored event when the payload changed", () => {
    const link = { googleEventId: "evt_1", lastSyncedHash: "stale-hash" };
    expect(planEventSync(link, payload)).toEqual({ action: "update", googleEventId: "evt_1" });
  });
});

describe("scope helpers", () => {
  it("normalizes Google scope URLs to short names", () => {
    const scopes = parseScopes(
      "openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events",
    );
    expect(scopes.has("gmail.readonly")).toBe(true);
    expect(scopes.has("calendar.events")).toBe(true);
    expect(scopes.has("openid")).toBe(true);
  });

  it("detects the calendar scope", () => {
    expect(hasCalendarScope("gmail.readonly")).toBe(false);
    expect(hasCalendarScope("gmail.readonly calendar.events")).toBe(true);
    expect(hasCalendarScope(null)).toBe(false);
    expect(hasCalendarScope(undefined)).toBe(false);
  });

  it("merges scopes as a union (reconnect never drops a grant)", () => {
    expect(mergeScopes("gmail.readonly", "calendar.events")).toBe(
      "calendar.events gmail.readonly",
    );
    expect(mergeScopes("gmail.readonly calendar.events", "gmail.readonly")).toBe(
      "calendar.events gmail.readonly",
    );
    expect(mergeScopes(null, "https://www.googleapis.com/auth/calendar.events")).toBe(
      "calendar.events",
    );
  });
});

describe("OAuth state purpose", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-secret-for-calendar-writeback";
  });

  it("round-trips the calendar purpose", () => {
    const state = verifyState(newOAuthState(7, "/settings", "calendar"));
    expect(state?.userId).toBe(7);
    expect(state?.purpose).toBe("calendar");
  });

  it("defaults to the gmail purpose", () => {
    const state = verifyState(newOAuthState(7, "/settings"));
    expect(state?.purpose).toBe("gmail");
  });
});
