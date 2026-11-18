/**
 * Extras engine — pure-logic tests (no DB, no I/O).
 *
 * Covers: pack selection by trip character, applicability rules, the
 * golf three-way math with labeled inputs, pricing honesty over every
 * generated fixture (an invented firm price is a defect), the budget
 * report, and TC-8's tier invariant (the pass fires at every tier).
 */

import { describe, it, expect } from "vitest";
import {
  RATE_ASSUMPTIONS,
  assertPricingHonesty,
  buildBudgetReport,
  detectInternational,
  generateSuggestions,
  matchPacks,
  pricingHonestyProblems,
  type TripFacts,
} from "./extrasLogic";

function facts(overrides: Partial<TripFacts> = {}): TripFacts {
  return {
    tripId: 7,
    destinationText: "Scottsdale, Arizona",
    styleText: null,
    tier: "premium",
    budgetCap: null,
    startDate: "2027-03-10",
    endDate: "2027-03-14", // 5 days
    tripDays: 5,
    participantCount: 2,
    flightCount: 0,
    flightAirports: [],
    hasStay: false,
    hasHomeStay: false,
    hasCarRental: false,
    ...overrides,
  };
}

describe("pack selection by trip character", () => {
  it("golf style → golf pack", () => {
    expect(matchPacks(facts({ styleText: "golf trip with the guys" }))).toContain("golf");
  });

  it("beach destination → beach pack", () => {
    expect(matchPacks(facts({ destinationText: "Turks & Caicos — island resort", styleText: "relaxing getaway" }))).toContain("beach");
  });

  it("ski style → ski pack; family style → family pack; Oktoberfest → festival pack", () => {
    expect(matchPacks(facts({ styleText: "ski weekend" }))).toContain("ski");
    expect(matchPacks(facts({ styleText: "family getaway with the kids" }))).toContain("family");
    expect(matchPacks(facts({ styleText: "Oktoberfest guys trip", destinationText: "Munich" }))).toContain("festival");
  });

  it("international via a non-US hub airport on a flight", () => {
    const f = facts({ styleText: "city break", destinationText: "Munich", flightAirports: ["EWR", "MUC"] });
    expect(detectInternational(f)).toBe(true);
    expect(matchPacks(f)).toContain("international");
  });

  it("international via destination country name, no flights yet", () => {
    expect(matchPacks(facts({ destinationText: "Bavaria, Germany", styleText: "road trip" }))).toContain("international");
  });

  it("domestic US trip is not international", () => {
    const f = facts({ flightAirports: ["EWR", "ORD"] });
    expect(detectInternational(f)).toBe(false);
    expect(matchPacks(f)).not.toContain("international");
  });

  it("unmatched character → no packs, no suggestions", () => {
    const f = facts({ styleText: "work conference", destinationText: "Chicago" });
    expect(matchPacks(f)).toEqual([]);
    expect(generateSuggestions(f)).toEqual([]);
  });
});

describe("golf three-way math (TC-8 worked example)", () => {
  const f = facts({ styleText: "golf trip", participantCount: 4, tripDays: 5 });
  const club = generateSuggestions(f).find((s) => s.itemKey === "club_shipping")!;

  it("computes each option's total from the labeled assumptions", () => {
    const math = club.detailData.math!;
    const byLabel = new Map(math.map((m) => [m.label, m]));
    // Ship: $89–$199 per golfer × 4 golfers.
    expect(byLabel.get("Ship your clubs (door-to-door, insured)")?.rangeMinor).toEqual({ min: 8900 * 4, max: 19900 * 4 });
    // Rent: $55–$80 per golfer-day × 4 golfers × 5 days.
    expect(byLabel.get("Rent premium clubs at the destination")?.rangeMinor).toEqual({ min: 5500 * 4 * 5, max: 8000 * 4 * 5 });
    // Check: $70–$80 per golfer round trip × 4.
    expect(byLabel.get("Check them as baggage on your flights")?.rangeMinor).toEqual({ min: 7000 * 4, max: 8000 * 4 });
  });

  it("prices the suggestion as the ship option's midpoint, labeled estimate", () => {
    const shipMid = Math.round(((8900 * 4 + 19900 * 4) / 2));
    expect(club.priceAmountMinor).toBe(shipMid);
    expect(club.priceNature).toBe("estimate");
    expect(club.priceCurrency).toBe("USD");
    expect(club.detailData.assumptions).toEqual(
      expect.arrayContaining(["club_shipping_round_trip", "premium_club_rental_day", "airline_checked_golf_bag_round_trip"]),
    );
  });

  it("shows its inputs and the damage-risk note in the detail", () => {
    expect(club.detail).toContain("4 golfers");
    expect(club.detail).toContain("5 days");
    expect(club.detail).toContain("damaged shaft");
    expect(club.detail).toContain("before your flights are final");
  });

  it("tee times and resort packages are quote-only; caddie is a labeled estimate", () => {
    const all = generateSuggestions(f);
    const tee = all.find((s) => s.itemKey === "tee_times")!;
    const pkg = all.find((s) => s.itemKey === "resort_packages")!;
    const caddie = all.find((s) => s.itemKey === "caddie")!;
    expect(tee.priceNature).toBe("quote");
    expect(tee.priceAmountMinor).toBeNull();
    expect(pkg.priceNature).toBe("quote");
    expect(pkg.priceAmountMinor).toBeNull();
    expect(caddie.priceNature).toBe("estimate");
    // 4 golfers → 1 foursome → 1 caddie × 5 rounds at the caddie range midpoint.
    const mid = Math.round((RATE_ASSUMPTIONS.caddie_round.minMinor + RATE_ASSUMPTIONS.caddie_round.maxMinor) / 2);
    expect(caddie.priceAmountMinor).toBe(mid * 5);
  });
});

describe("applicability rules", () => {
  it("grocery pre-stocking fires only for a home stay", () => {
    const hotel = generateSuggestions(facts({ styleText: "beach week", hasStay: true, hasHomeStay: false }));
    expect(hotel.find((s) => s.itemKey === "grocery_prestock")).toBeUndefined();
    const home = generateSuggestions(facts({ styleText: "beach week", hasStay: true, hasHomeStay: true }));
    expect(home.find((s) => s.itemKey === "grocery_prestock")).toBeDefined();
  });

  it("crib check needs a stay; car seats need a rental car; kid pricing always fires for family", () => {
    const bare = generateSuggestions(facts({ styleText: "family trip" }));
    expect(bare.map((s) => s.itemKey)).toEqual(["kid_pass_pricing"]);
    const full = generateSuggestions(facts({ styleText: "family trip", hasStay: true, hasCarRental: true }));
    expect(full.map((s) => s.itemKey)).toEqual(
      expect.arrayContaining(["crib_highchair", "car_seats", "kid_pass_pricing"]),
    );
  });

  it("international pack: entry check is note-only, eSIM scales with travelers", () => {
    const all = generateSuggestions(facts({ destinationText: "Munich, Germany", styleText: "city break", participantCount: 3 }));
    const entry = all.find((s) => s.itemKey === "entry_requirements")!;
    expect(entry.priceAmountMinor).toBeNull();
    expect(entry.priceNature).toBeNull();
    const esim = all.find((s) => s.itemKey === "esim")!;
    const mid = Math.round((RATE_ASSUMPTIONS.esim_trip.minMinor + RATE_ASSUMPTIONS.esim_trip.maxMinor) / 2);
    expect(esim.priceAmountMinor).toBe(mid * 3);
  });
});

describe("pricing honesty over every generated fixture", () => {
  const megaTrip = facts({
    styleText: "golf ski beach family festival trip",
    destinationText: "Munich, Germany",
    participantCount: 4,
    hasStay: true,
    hasHomeStay: true,
    hasCarRental: true,
    flightAirports: ["EWR", "MUC"],
  });

  it("the mega trip generates every pack's items and all of them are honest", () => {
    const all = generateSuggestions(megaTrip);
    expect(all.length).toBeGreaterThanOrEqual(15);
    expect(() => assertPricingHonesty(all)).not.toThrow();
    for (const s of all) {
      expect(pricingHonestyProblems(s)).toEqual([]);
      if (s.priceAmountMinor !== null) expect(s.priceNature).not.toBeNull();
      expect(s.priceNature).not.toBe("firm"); // no rail serves extras in v1 — a firm price would be invented
      if (s.priceNature === "quote") expect(s.priceAmountMinor).toBeNull();
    }
  });

  it("every estimate names a real rate assumption", () => {
    for (const s of generateSuggestions(megaTrip)) {
      if (s.priceNature !== "estimate") continue;
      for (const key of s.detailData.assumptions ?? []) {
        expect(RATE_ASSUMPTIONS).toHaveProperty(key);
      }
      expect(s.detail).toContain("Estimate:");
      expect(s.detail).toContain("Basis:");
    }
  });
});

describe("TC-8: the pass fires at every tier", () => {
  for (const tier of ["white_glove", "premium", "family_budget"] as const) {
    it(`golf trip at ${tier} produces suggestions`, () => {
      const all = generateSuggestions(facts({ styleText: "golf trip", tier }));
      expect(all.length).toBeGreaterThan(0);
      expect(all.find((s) => s.itemKey === "club_shipping")).toBeDefined();
    });
  }
});

describe("budget report", () => {
  it("sums priced items in the cap currency, excludes dismissed, counts the unpriced", () => {
    const report = buildBudgetReport({ amountMinor: 50000, currency: "USD" }, [
      { priceAmountMinor: 30000, priceCurrency: "USD", state: "suggested" },
      { priceAmountMinor: 25000, priceCurrency: "USD", state: "accepted" },
      { priceAmountMinor: 99999, priceCurrency: "USD", state: "dismissed" },
      { priceAmountMinor: null, priceCurrency: null, state: "suggested" }, // quote-only
      { priceAmountMinor: 10000, priceCurrency: "EUR", state: "suggested" }, // never silently converted
    ]);
    expect(report.pricedTotalMinor).toBe(55000);
    expect(report.pricedItemCount).toBe(2);
    expect(report.unpricedItemCount).toBe(2);
    expect(report.overCap).toBe(true);
    expect(report.remainingMinor).toBe(-5000);
  });

  it("under-cap report leaves room", () => {
    const report = buildBudgetReport({ amountMinor: 50000, currency: "USD" }, [
      { priceAmountMinor: 12000, priceCurrency: "USD", state: "suggested" },
    ]);
    expect(report.overCap).toBe(false);
    expect(report.remainingMinor).toBe(38000);
  });
});
