
import { describe, it, expect } from "vitest";
import {
  money,
  fromLegacyPrice,
  toLegacyPrice,
} from "./index";

// The legacy boundary (architecture ADR-6): legacy itinerary tables store
// numeric(12,2) major units + a currency text column. These converters are
// the only sanctioned crossing between that shape and the money type.
describe("fromLegacyPrice — legacy numeric + currency text → Money", () => {
  it("converts a standard 2-decimal pair (Drizzle numeric arrives as string)", () => {
    expect(fromLegacyPrice("1234.56", "USD")).toEqual(money(123456, "USD"));
    expect(fromLegacyPrice("267.92", "EUR")).toEqual(money(26792, "EUR"));
  });

  it("accepts a JS number amount and a lowercase currency", () => {
    expect(fromLegacyPrice(1234.56, "usd")).toEqual(money(123456, "USD"));
  });

  it("0-decimal currency: the numeric is whole major units, not hundredths", () => {
    // A JPY fare stored in flights.total_price as 15000.00 is ¥15,000 —
    // the converter must NOT divide by 100.
    expect(fromLegacyPrice("15000.00", "JPY")).toEqual(money(15000, "JPY"));
    expect(fromLegacyPrice("15000", "KRW")).toEqual(money(15000, "KRW"));
  });

  it("3-decimal currency: legacy scale-2 values convert at face value", () => {
    expect(fromLegacyPrice("1.23", "BHD")).toEqual(money(1230, "BHD"));
  });

  it("missing amount → null", () => {
    expect(fromLegacyPrice(null, "USD")).toBeNull();
    expect(fromLegacyPrice(undefined, "USD")).toBeNull();
    expect(fromLegacyPrice("", "USD")).toBeNull();
    expect(fromLegacyPrice("   ", "USD")).toBeNull();
  });

  it("missing currency → null, NEVER a guessed default", () => {
    // The one behavior that matters most: a price without a currency is
    // unknown money. Defaulting it to USD would fabricate a fact.
    expect(fromLegacyPrice("100.00", null)).toBeNull();
    expect(fromLegacyPrice("100.00", undefined)).toBeNull();
    expect(fromLegacyPrice("100.00", "")).toBeNull();
    expect(fromLegacyPrice("100.00", "   ")).toBeNull();
  });

  it("unknown currency → null", () => {
    expect(fromLegacyPrice("100.00", "ZZZ")).toBeNull();
    expect(fromLegacyPrice("100.00", "dollars")).toBeNull();
  });

  it("unparseable amount → null", () => {
    expect(fromLegacyPrice("free", "USD")).toBeNull();
    expect(fromLegacyPrice("$100", "USD")).toBeNull();
    expect(fromLegacyPrice(NaN, "USD")).toBeNull();
  });
});

describe("toLegacyPrice — Money → legacy numeric(12,2) projection", () => {
  it("2-decimal currencies project exactly", () => {
    expect(toLegacyPrice(money(123456, "USD"))).toEqual({ amount: "1234.56", currency: "USD" });
    expect(toLegacyPrice(money(5, "EUR"))).toEqual({ amount: "0.05", currency: "EUR" });
    expect(toLegacyPrice(money(-50, "USD"))).toEqual({ amount: "-0.50", currency: "USD" });
    expect(toLegacyPrice(money(0, "GBP"))).toEqual({ amount: "0.00", currency: "GBP" });
  });

  it("0-decimal currencies scale UP to the column's fixed scale (exponent-aware)", () => {
    // ¥15,000 must land in numeric(12,2) as 15000.00 — projecting minor
    // units naively would write 150.00, wrong by two orders of magnitude.
    expect(toLegacyPrice(money(15000, "JPY"))).toEqual({ amount: "15000.00", currency: "JPY" });
    expect(toLegacyPrice(money(7, "KRW"))).toEqual({ amount: "7.00", currency: "KRW" });
  });

  it("3-decimal currencies round half-up to the column's scale (documented lossy)", () => {
    expect(toLegacyPrice(money(1234, "BHD"))).toEqual({ amount: "1.23", currency: "BHD" });
    expect(toLegacyPrice(money(1235, "BHD"))).toEqual({ amount: "1.24", currency: "BHD" });
    expect(toLegacyPrice(money(999, "KWD"))).toEqual({ amount: "1.00", currency: "KWD" });
    expect(toLegacyPrice(money(-1235, "BHD"))).toEqual({ amount: "-1.24", currency: "BHD" });
  });

  it("round-trips exactly for 2-decimal currencies", () => {
    const original = money(98765, "USD");
    const legacy = toLegacyPrice(original);
    expect(fromLegacyPrice(legacy.amount, legacy.currency)).toEqual(original);
  });

  it("round-trips exactly for 0-decimal currencies", () => {
    const original = money(15000, "JPY");
    const legacy = toLegacyPrice(original);
    expect(fromLegacyPrice(legacy.amount, legacy.currency)).toEqual(original);
  });
});
