import { describe, expect, it } from "vitest";
import type { DaySheet } from "./daySheet.js";
import { renderDaySheetPdf, renderDaySheetsPdf } from "./daySheetPdf.js";

const realisticSheet: DaySheet = {
  tripTitle: "Oktoberfest Guys' Trip",
  destination: "Munich, Germany",
  dateISO: "2026-09-25",
  dateLabel: "Friday, September 25",
  dayNumber: 2,
  dayCount: 4,
  items: [
    {
      time: "09:00",
      title: "Dachau Concentration Camp Memorial",
      location: "Alte Römerstraße 75, 85221 Dachau",
      confirmationCode: null,
      type: "activity",
    },
    {
      time: "12:30",
      title: "Lunch at Augustiner-Keller",
      location: "Arnulfstraße 52, 80335 München",
      confirmationCode: null,
      type: "dining",
    },
    {
      time: null,
      title: "Walk-in beer garden backup option",
      location: "Biergarten am Viktualienmarkt",
      confirmationCode: null,
      type: "activity",
    },
    {
      time: "17:15",
      title: "Paulaner Festzelt — Oktoberfest",
      location: "Theresienwiese",
      confirmationCode: "125113",
      type: "dining",
    },
    {
      time: "22:30",
      title: "Nightcap at hotel bar",
      location: null,
      confirmationCode: null,
      type: "dining",
    },
  ],
  stayTonight: {
    name: "The Westin Grand Munich",
    address: "Arabellastraße 6, 81925 München",
  },
  dayNotes:
    "Tent reservation is under Philip S. Arrive a little before 5:15 PM so the group can get in together. Cash for the maß — cards are slow in the tent.",
  weather: { highF: 64, lowF: 47, condition: "Partly cloudy", rainChancePct: 20 },
};

const emptySheet: DaySheet = {
  tripTitle: "Quiet Day",
  destination: "Munich, Germany",
  dateISO: "2026-09-27",
  dateLabel: "Sunday, September 27",
  dayNumber: 4,
  dayCount: 4,
  items: [],
  stayTonight: null,
  dayNotes: null,
  weather: null,
};

const minimalSheet: DaySheet = {
  tripTitle: "X".repeat(300),
  destination: "",
  dateISO: "",
  dateLabel: "",
  dayNumber: 0,
  dayCount: 0,
  items: [
    { time: null, title: "", location: null, confirmationCode: null, type: "" },
    { time: "25:99", title: "A".repeat(500), location: "B".repeat(500), confirmationCode: "C".repeat(200), type: "x" },
  ],
  stayTonight: { name: "", address: null },
  dayNotes: " ".repeat(1000),
  weather: { highF: 78, lowF: 64, condition: "Partly cloudy", rainChancePct: 20 },
};

describe("renderDaySheetPdf", () => {
  it("renders a realistic sheet to a valid one-page PDF", async () => {
    const pdf = await renderDaySheetPdf(realisticSheet);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(500);
    // Single page: the PDF catalog should describe exactly one page.
    const pageRefs = pdf.toString("ascii").match(/\/Type\s*\/Page\b/g) ?? [];
    expect(pageRefs.length).toBe(1);
  });

  it("renders an empty sheet without throwing", async () => {
    const pdf = await renderDaySheetPdf(emptySheet);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(500);
  });

  it("never throws on minimal/oversized data", async () => {
    const pdf = await renderDaySheetPdf(minimalSheet);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });
});

describe("renderDaySheetsPdf", () => {
  const day2: DaySheet = { ...realisticSheet, dateISO: "2026-09-26", dateLabel: "Saturday, September 26", dayNumber: 3 };

  it("renders one page per sheet", async () => {
    const pdf = await renderDaySheetsPdf([realisticSheet, day2]);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1000);
    const pageRefs = pdf.toString("ascii").match(/\/Type\s*\/Page\b/g) ?? [];
    expect(pageRefs.length).toBe(2);
  });

  it("still renders a single-page PDF for one sheet", async () => {
    const pdf = await renderDaySheetsPdf([realisticSheet]);
    const pageRefs = pdf.toString("ascii").match(/\/Type\s*\/Page\b/g) ?? [];
    expect(pageRefs.length).toBe(1);
  });

  it("renders an empty list without throwing", async () => {
    const pdf = await renderDaySheetsPdf([]);
    expect(Buffer.isBuffer(pdf)).toBe(true);
    expect(pdf.subarray(0, 4).toString("ascii")).toBe("%PDF");
  });
});
