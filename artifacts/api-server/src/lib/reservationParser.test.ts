/**
 * Reservation parser unit tests — pure functions, no I/O.
 */

import { describe, it, expect } from "vitest";
import {
  looksLikeBooking,
  parseReservation,
  extractConfirmationCode,
  extractDate,
  extractTime,
  extractPartySize,
  type InboundEmail,
} from "./reservationParser.js";

const gybEmail: InboundEmail = {
  from: "GetYourGuide <noreply@getyourguide.com>",
  subject: "Your booking confirmation - Neuschwanstein Castle Tour",
  snippet: "Booking reference GYGZGZRLXQ5V. Date: September 26, 2026 at 12:00 PM.",
  bodyText: "Thank you for your booking!\nBooking reference: GYGZGZRLXQ5V\nDate: September 26, 2026\nTime: 12:00 PM\n4 adults",
};

const promoEmail: InboundEmail = {
  from: "Deals <deals@example.com>",
  subject: "50% off this weekend only!",
  snippet: "Huge savings on hotels.",
  bodyText: "Book now and save big on your next getaway.",
};

describe("looksLikeBooking", () => {
  it("recognizes a GetYourGuide confirmation", () => {
    expect(looksLikeBooking(gybEmail)).toBe(true);
  });

  it("rejects a promo email", () => {
    expect(looksLikeBooking(promoEmail)).toBe(false);
  });

  it("requires at least two keyword hits for unknown senders", () => {
    const one: InboundEmail = {
      from: "friend@example.com",
      subject: "booking a call tomorrow?",
      snippet: "let's chat",
      bodyText: "are you free?",
    };
    expect(looksLikeBooking(one)).toBe(false);
  });
});

describe("parseReservation", () => {
  it("parses a GetYourGuide confirmation with high confidence", () => {
    const parsed = parseReservation(gybEmail);
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("tour");
    expect(parsed!.source).toBe("getyourguide");
    expect(parsed!.confirmationCode).toBe("GYGZGZRLXQ5V");
    expect(parsed!.date).toBe("2026-09-26");
    expect(parsed!.time).toBe("12:00 PM");
    expect(parsed!.confidence).toBe("high");
  });

  it("parses an OpenTable-style restaurant confirmation", () => {
    const parsed = parseReservation({
      from: "OpenTable <noreply@opentable.com>",
      subject: "Your reservation at Grill im Künstlerhaus is confirmed",
      snippet: "Table for 4 on September 26, 2026 at 8:30 PM. Confirmation: 2109847960",
      bodyText: "Confirmation: 2109847960\nDate: September 26, 2026\nTime: 8:30 PM\nParty of 4",
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.type).toBe("restaurant");
    expect(parsed!.time).toBe("8:30 PM");
    expect(parsed!.numberOfPeople).toBe(4);
    expect(parsed!.confidence).toBe("high");
  });

  it("returns null for non-booking mail", () => {
    expect(parseReservation(promoEmail)).toBeNull();
  });

  it("gives low confidence when little structure is found", () => {
    const parsed = parseReservation({
      from: "Some Venue <hello@somevenue.com>",
      subject: "Your reservation is confirmed",
      snippet: "We look forward to seeing you!",
      bodyText: "Your reservation is confirmed. See you soon!",
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.confidence).toBe("low");
  });
});

describe("extractConfirmationCode", () => {
  it("finds labeled codes", () => {
    expect(extractConfirmationCode("Confirmation number: ABC123")).toBe("ABC123");
    expect(extractConfirmationCode("Booking reference: GYGZGZRLXQ5V")).toBe("GYGZGZRLXQ5V");
    expect(extractConfirmationCode("PNR JQZZ2H")).toBe("JQZZ2H");
  });

  it("returns undefined when nothing looks like a code", () => {
    expect(extractConfirmationCode("see you soon")).toBeUndefined();
  });
});

describe("extractDate", () => {
  it("parses long-form dates", () => {
    expect(extractDate("on September 26, 2026")).toBe("2026-09-26");
    expect(extractDate("Sep 5, 2027")).toBe("2027-09-05");
  });

  it("parses ISO and US numeric dates", () => {
    expect(extractDate("2026-09-26")).toBe("2026-09-26");
    expect(extractDate("09/26/2026")).toBe("2026-09-26");
  });
});

describe("extractTime / extractPartySize", () => {
  it("parses times", () => {
    expect(extractTime("at 7:30 PM sharp")).toBe("7:30 PM");
    expect(extractTime("no time here")).toBeUndefined();
  });

  it("parses party sizes", () => {
    expect(extractPartySize("Party of 4")).toBe(4);
    expect(extractPartySize("Table for 2")).toBe(2);
    expect(extractPartySize("no party info")).toBeUndefined();
  });
});
