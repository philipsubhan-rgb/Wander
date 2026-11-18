/**
 * Calendar write-back mapping for flights / stays / car rentals —
 * the item kinds the completion bundle added beyond reservations.
 * Pure mapping tests (the sync service is covered separately).
 */

import { describe, it, expect } from "vitest";
import {
  mapAccommodationToCalendarEvent,
  mapCarRentalToCalendarEvent,
  mapFlightToCalendarEvent,
  normalizeWallClock,
  type MappableFlight,
  type MappableAccommodation,
  type MappableCarRental,
} from "./calendarEventMapping";

const FLIGHT: MappableFlight = {
  id: 55,
  flightNumber: "UA30",
  airline: "United Airlines",
  departureAirport: "EWR",
  arrivalAirport: "MUC",
  departureDatetime: "2026-09-23T17:00",
  arrivalDatetime: "2026-09-24T07:10",
  departureTimezone: "America/New_York",
  arrivalTimezone: "Europe/Berlin",
  confirmationCode: "JQZZ2H",
};

describe("mapFlightToCalendarEvent", () => {
  it("maps departure → arrival with each end in its own airport timezone", () => {
    const payload = mapFlightToCalendarEvent(FLIGHT, { tripTitle: "Munich guys' trip" });
    expect(payload).not.toBeNull();
    expect(payload!.summary).toBe("United Airlines UA30 — EWR → MUC");
    expect(payload!.start).toEqual({
      dateTime: "2026-09-23T17:00:00",
      timeZone: "America/New_York",
    });
    expect(payload!.end).toEqual({
      dateTime: "2026-09-24T07:10:00",
      timeZone: "Europe/Berlin",
    });
    expect(payload!.location).toBe("EWR");
    expect(payload!.description).toContain("Confirmation: JQZZ2H");
    expect(payload!.description).toContain("Trip: Munich guys' trip");
  });

  it("omits the timezone when Wander doesn't know it (floating local time)", () => {
    const payload = mapFlightToCalendarEvent({
      ...FLIGHT,
      departureTimezone: null,
      arrivalTimezone: null,
    });
    expect(payload!.start).toEqual({ dateTime: "2026-09-23T17:00:00" });
    expect(payload!.end).toEqual({ dateTime: "2026-09-24T07:10:00" });
  });

  it("accepts datetimes that already carry seconds", () => {
    const payload = mapFlightToCalendarEvent({
      ...FLIGHT,
      departureDatetime: "2026-09-23T17:00:30",
    });
    expect((payload!.start as { dateTime?: string }).dateTime).toBe("2026-09-23T17:00:30");
  });

  it("returns null for an unparseable datetime rather than guessing", () => {
    expect(mapFlightToCalendarEvent({ ...FLIGHT, departureDatetime: "next Friday" })).toBeNull();
    expect(mapFlightToCalendarEvent({ ...FLIGHT, arrivalDatetime: "" })).toBeNull();
  });
});

const STAY: MappableAccommodation = {
  id: 9,
  name: "Westin Grand Munich",
  address: "Arabellastrasse 6, Munich",
  checkIn: "2026-09-24",
  checkOut: "2026-09-28",
  confirmationCode: "WST-1",
};

describe("mapAccommodationToCalendarEvent", () => {
  it("maps to an all-day span [check-in, check-out) — Google's exclusive end IS the checkout date", () => {
    const payload = mapAccommodationToCalendarEvent(STAY);
    expect(payload!.summary).toBe("Westin Grand Munich");
    expect(payload!.start).toEqual({ date: "2026-09-24" });
    expect(payload!.end).toEqual({ date: "2026-09-28" });
    expect(payload!.location).toBe("Arabellastrasse 6, Munich");
    expect(payload!.description).toContain("Confirmation: WST-1");
  });

  it("takes the date part when check-in/out carry datetimes", () => {
    const payload = mapAccommodationToCalendarEvent({
      ...STAY,
      checkIn: "2026-09-24T15:00",
      checkOut: "2026-09-28T11:00",
    });
    expect(payload!.start).toEqual({ date: "2026-09-24" });
    expect(payload!.end).toEqual({ date: "2026-09-28" });
  });

  it("returns null for a zero-length or inverted stay", () => {
    expect(mapAccommodationToCalendarEvent({ ...STAY, checkOut: "2026-09-24" })).toBeNull();
    expect(mapAccommodationToCalendarEvent({ ...STAY, checkOut: "2026-09-20" })).toBeNull();
  });
});

const CAR: MappableCarRental = {
  id: 4,
  company: "Sixt",
  pickupLocation: "Munich Airport",
  dropoffLocation: "Munich Airport",
  pickupDatetime: "2026-09-24T08:00",
  dropoffDatetime: "2026-09-28T08:00",
  confirmationCode: "9739037749",
  driverName: "Philip Subhan",
};

describe("mapCarRentalToCalendarEvent", () => {
  it("maps pickup → drop-off as a timed event in the calendar's timezone", () => {
    const payload = mapCarRentalToCalendarEvent(CAR, { timeZone: "Europe/Berlin" });
    expect(payload!.summary).toBe("Sixt car rental");
    expect(payload!.start).toEqual({
      dateTime: "2026-09-24T08:00:00",
      timeZone: "Europe/Berlin",
    });
    expect(payload!.end).toEqual({
      dateTime: "2026-09-28T08:00:00",
      timeZone: "Europe/Berlin",
    });
    expect(payload!.location).toBe("Munich Airport");
    expect(payload!.description).toContain("Confirmation: 9739037749");
    expect(payload!.description).toContain("Driver: Philip Subhan");
    // Same pickup/drop-off location → no redundant drop-off line.
    expect(payload!.description).not.toContain("Drop-off:");
  });

  it("names a different drop-off location in the description", () => {
    const payload = mapCarRentalToCalendarEvent({ ...CAR, dropoffLocation: "Munich City" });
    expect(payload!.description).toContain("Drop-off: Munich City");
  });

  it("falls back to an all-day span (+1 exclusive end) for date-only values", () => {
    const payload = mapCarRentalToCalendarEvent({
      ...CAR,
      pickupDatetime: "2026-09-24",
      dropoffDatetime: "2026-09-28",
    });
    expect(payload!.start).toEqual({ date: "2026-09-24" });
    expect(payload!.end).toEqual({ date: "2026-09-29" });
  });

  it("returns null when neither datetimes nor dates parse", () => {
    expect(
      mapCarRentalToCalendarEvent({ ...CAR, pickupDatetime: "soon", dropoffDatetime: "later" }),
    ).toBeNull();
  });
});

describe("normalizeWallClock", () => {
  it("normalizes HH:mm to HH:mm:ss and rejects junk", () => {
    expect(normalizeWallClock("2026-09-23T17:00")).toBe("2026-09-23T17:00:00");
    expect(normalizeWallClock("2026-09-23T17:00:45")).toBe("2026-09-23T17:00:45");
    expect(normalizeWallClock("2026-09-23")).toBeNull();
    expect(normalizeWallClock("2026-09-23T25:00")).toBeNull();
    expect(normalizeWallClock(null)).toBeNull();
    expect(normalizeWallClock(undefined)).toBeNull();
  });
});
