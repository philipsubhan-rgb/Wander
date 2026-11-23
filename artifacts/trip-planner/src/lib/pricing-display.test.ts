import { describe, it, expect } from "vitest";
import {
  summarizeFlightPricing,
  summarizeStayPricing,
  nightsBetween,
} from "./pricing-display";

describe("summarizeFlightPricing", () => {
  it("shows the full total, passenger caption, and per-person split", () => {
    const s = summarizeFlightPricing({
      totalPrice: "1286.26",
      currency: "USD",
      passengerCount: 2,
      fareBrand: "Main Cabin",
      refundable: false,
      changeable: true,
      checkedBags: "2 checked bags included",
    });
    expect(s.total).toBe("$1,286.26");
    expect(s.totalCaption).toBe("Total for 2 passengers");
    expect(s.perPerson).toBe("$643.13");
    expect(s.fareBrand).toBe("Main Cabin");
    expect(s.terms).toEqual(["Non-refundable", "Changeable", "2 checked bags included"]);
    expect(s.hasPricing).toBe(true);
  });

  it("uses the flight's currency", () => {
    const s = summarizeFlightPricing({ totalPrice: "450.00", currency: "EUR" });
    expect(s.total).toBe("€450.00");
    expect(s.totalCaption).toBe("Total");
    expect(s.perPerson).toBeNull();
  });

  it("does not split per-person for a single passenger", () => {
    const s = summarizeFlightPricing({ totalPrice: "300.00", currency: "USD", passengerCount: 1 });
    expect(s.totalCaption).toBe("Total for 1 passenger");
    expect(s.perPerson).toBeNull();
  });

  it("keeps fare info visible when no price was recorded", () => {
    const s = summarizeFlightPricing({ fareBrand: "Economy", refundable: true });
    expect(s.total).toBeNull();
    expect(s.fareBrand).toBe("Economy");
    expect(s.terms).toEqual(["Refundable"]);
    expect(s.hasPricing).toBe(true);
  });

  it("reports no pricing for an unpriced flight", () => {
    const s = summarizeFlightPricing({});
    expect(s.hasPricing).toBe(false);
    expect(s.total).toBeNull();
    expect(s.terms).toEqual([]);
  });

  it("treats an unparseable price as absent rather than $0", () => {
    const s = summarizeFlightPricing({ totalPrice: "not-a-price", currency: "USD" });
    expect(s.total).toBeNull();
    expect(s.hasPricing).toBe(false);
  });

  it("ignores unknown (null) fare terms instead of guessing", () => {
    const s = summarizeFlightPricing({ totalPrice: "100", refundable: null, changeable: null });
    expect(s.terms).toEqual([]);
  });
});

describe("nightsBetween", () => {
  it("counts whole nights from the stored date prefixes", () => {
    expect(nightsBetween("2026-09-24T15:00:00.000Z", "2026-09-29T11:00:00.000Z")).toBe(5);
  });

  it("never shifts with the viewer's timezone", () => {
    expect(nightsBetween("2026-09-24", "2026-09-25")).toBe(1);
  });

  it("returns null for same-day, reversed, or unparseable dates", () => {
    expect(nightsBetween("2026-09-24", "2026-09-24")).toBeNull();
    expect(nightsBetween("2026-09-29", "2026-09-24")).toBeNull();
    expect(nightsBetween("soon", "2026-09-24")).toBeNull();
    expect(nightsBetween(null, null)).toBeNull();
  });
});

describe("summarizeStayPricing", () => {
  it("leads with the full-stay total and gives rate + nights as context", () => {
    const s = summarizeStayPricing({
      nightlyRate: "450.00",
      totalPrice: "2250.00",
      currency: "USD",
      checkIn: "2026-09-24T15:00:00.000Z",
      checkOut: "2026-09-29T11:00:00.000Z",
    });
    expect(s.primary).toBe("$2,250.00");
    expect(s.primaryCaption).toBe("Total for the stay");
    expect(s.detailLine).toBe("$450.00 per night · 5 nights");
    expect(s.nights).toBe(5);
    expect(s.hasPricing).toBe(true);
  });

  it("shows nights as context when only the total is known", () => {
    const s = summarizeStayPricing({
      totalPrice: "900.00",
      currency: "USD",
      checkIn: "2026-09-24",
      checkOut: "2026-09-27",
    });
    expect(s.primary).toBe("$900.00");
    expect(s.detailLine).toBe("3 nights");
  });

  it("leads with the nightly rate when no total was recorded", () => {
    const s = summarizeStayPricing({
      nightlyRate: "180.50",
      currency: "USD",
      checkIn: "2026-09-24",
      checkOut: "2026-09-26",
    });
    expect(s.primary).toBe("$180.50");
    expect(s.primaryCaption).toBe("Per night");
    expect(s.detailLine).toBe("2 nights");
  });

  it("has no detail line when only a nightly rate exists", () => {
    const s = summarizeStayPricing({ nightlyRate: "180.50", currency: "USD" });
    expect(s.primary).toBe("$180.50");
    expect(s.detailLine).toBeNull();
  });

  it("reports no pricing for an unpriced stay", () => {
    const s = summarizeStayPricing({ checkIn: "2026-09-24", checkOut: "2026-09-29" });
    expect(s.hasPricing).toBe(false);
    expect(s.primary).toBeNull();
  });

  it("uses the stay's currency", () => {
    const s = summarizeStayPricing({ totalPrice: "1200", currency: "EUR" });
    expect(s.primary).toBe("€1,200.00");
  });
});
