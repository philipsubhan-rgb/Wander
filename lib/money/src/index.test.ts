import { describe, it, expect } from "vitest";
import {
  money,
  zero,
  isMoney,
  currencyExponent,
  isKnownCurrency,
  add,
  subtract,
  negate,
  abs,
  sum,
  multiplyByInt,
  compare,
  equals,
  isZero,
  isPositive,
  isNegative,
  min,
  max,
  splitEqually,
  fromMajorDecimal,
  toMajorString,
  toMajorNumber,
  formatMoney,
  fromLegacyPrice,
  toLegacyPrice,
  CurrencyMismatchError,
  UnknownCurrencyError,
  InvalidMoneyError,
} from "./index";

describe("currencyExponent — ISO 4217 exponents", () => {
  it("2-decimal currencies", () => {
    expect(currencyExponent("USD")).toBe(2);
    expect(currencyExponent("EUR")).toBe(2);
    expect(currencyExponent("GBP")).toBe(2);
    expect(currencyExponent("CHF")).toBe(2);
    expect(currencyExponent("INR")).toBe(2);
  });

  it("0-decimal currencies: JPY, KRW and friends", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(currencyExponent("KRW")).toBe(0);
    expect(currencyExponent("VND")).toBe(0);
    expect(currencyExponent("ISK")).toBe(0);
    expect(currencyExponent("XOF")).toBe(0);
  });

  it("3-decimal currencies: BHD, KWD and friends", () => {
    expect(currencyExponent("BHD")).toBe(3);
    expect(currencyExponent("KWD")).toBe(3);
    expect(currencyExponent("OMR")).toBe(3);
    expect(currencyExponent("JOD")).toBe(3);
    expect(currencyExponent("TND")).toBe(3);
  });

  it("normalizes case and whitespace", () => {
    expect(currencyExponent("usd")).toBe(2);
    expect(currencyExponent(" jpy ")).toBe(0);
  });

  it("unknown and non-payment codes resolve to null", () => {
    expect(currencyExponent("ZZZ")).toBeNull();
    expect(currencyExponent("XXX")).toBeNull(); // ISO "no currency" — not money
    expect(currencyExponent("XAU")).toBeNull(); // gold — not a payment currency
    expect(currencyExponent("")).toBeNull();
    expect(currencyExponent("US")).toBeNull();
    expect(isKnownCurrency("EUR")).toBe(true);
    expect(isKnownCurrency("FOO")).toBe(false);
  });
});

describe("money() construction", () => {
  it("normalizes the currency code and freezes the value", () => {
    const m = money(41200, "eur");
    expect(m).toEqual({ amountMinor: 41200, currency: "EUR" });
    expect(Object.isFrozen(m)).toBe(true);
  });

  it("throws on unknown currency", () => {
    expect(() => money(100, "ZZZ")).toThrow(UnknownCurrencyError);
  });

  it("throws on non-integer or unsafe amounts", () => {
    expect(() => money(10.5, "USD")).toThrow(InvalidMoneyError);
    expect(() => money(Number.MAX_SAFE_INTEGER + 1, "USD")).toThrow(InvalidMoneyError);
    expect(() => money(NaN, "USD")).toThrow(InvalidMoneyError);
  });

  it("zero() and isMoney()", () => {
    expect(zero("JPY")).toEqual({ amountMinor: 0, currency: "JPY" });
    expect(isMoney(money(1, "USD"))).toBe(true);
    expect(isMoney({ amountMinor: 1.5, currency: "USD" })).toBe(false);
    expect(isMoney({ amountMinor: 1, currency: "ZZZ" })).toBe(false);
    expect(isMoney(null)).toBe(false);
    expect(isMoney("100")).toBe(false);
  });
});

describe("arithmetic — same currency only", () => {
  it("add / subtract / negate / abs", () => {
    const a = money(1000, "USD");
    const b = money(250, "USD");
    expect(add(a, b)).toEqual(money(1250, "USD"));
    expect(subtract(a, b)).toEqual(money(750, "USD"));
    expect(negate(b)).toEqual(money(-250, "USD"));
    expect(abs(negate(b))).toEqual(b);
  });

  it("cross-currency arithmetic throws — conversion is never implicit", () => {
    const usd = money(100, "USD");
    const eur = money(100, "EUR");
    expect(() => add(usd, eur)).toThrow(CurrencyMismatchError);
    expect(() => subtract(usd, eur)).toThrow(CurrencyMismatchError);
    expect(() => compare(usd, eur)).toThrow(CurrencyMismatchError);
    expect(() => min(usd, eur)).toThrow(CurrencyMismatchError);
  });

  it("sum: empty → null, mixed currencies throw", () => {
    expect(sum([])).toBeNull();
    expect(sum([money(1, "JPY"), money(2, "JPY"), money(3, "JPY")])).toEqual(money(6, "JPY"));
    expect(() => sum([money(1, "USD"), money(1, "EUR")])).toThrow(CurrencyMismatchError);
  });

  it("multiplyByInt is exact and integer-only", () => {
    expect(multiplyByInt(money(333, "USD"), 3)).toEqual(money(999, "USD"));
    expect(multiplyByInt(money(100, "USD"), 0)).toEqual(money(0, "USD"));
    expect(() => multiplyByInt(money(100, "USD"), 1.5)).toThrow(InvalidMoneyError);
  });

  it("compare / equals / sign predicates / min / max", () => {
    const a = money(100, "BHD");
    const b = money(200, "BHD");
    expect(compare(a, b)).toBe(-1);
    expect(compare(b, a)).toBe(1);
    expect(compare(a, money(100, "BHD"))).toBe(0);
    expect(equals(a, money(100, "BHD"))).toBe(true);
    expect(equals(a, money(100, "USD"))).toBe(false);
    expect(min(a, b)).toEqual(a);
    expect(max(a, b)).toEqual(b);
    expect(isZero(zero("KRW"))).toBe(true);
    expect(isPositive(a)).toBe(true);
    expect(isNegative(negate(a))).toBe(true);
  });
});

describe("splitEqually — remainder to the organizer (first share), sums exact", () => {
  it("€412 split 4 ways is exact (international doc §2.6 example)", () => {
    const shares = splitEqually(money(41200, "EUR"), 4);
    expect(shares.map((s) => s.amountMinor)).toEqual([10300, 10300, 10300, 10300]);
  });

  it("uneven split: remainder lands on the first share, total preserved", () => {
    const shares = splitEqually(money(100, "USD"), 3);
    expect(shares.map((s) => s.amountMinor)).toEqual([34, 33, 33]);
    expect(sum(shares)).toEqual(money(100, "USD"));
  });

  it("0-decimal currency split stays integral", () => {
    const shares = splitEqually(money(1000, "JPY"), 3);
    expect(shares.map((s) => s.amountMinor)).toEqual([334, 333, 333]);
    expect(sum(shares)).toEqual(money(1000, "JPY"));
  });

  it("negative amounts split with the remainder on the first share", () => {
    const shares = splitEqually(money(-100, "USD"), 3);
    expect(shares.map((s) => s.amountMinor)).toEqual([-34, -33, -33]);
    expect(sum(shares)).toEqual(money(-100, "USD"));
  });

  it("rejects invalid part counts", () => {
    expect(() => splitEqually(money(100, "USD"), 0)).toThrow(InvalidMoneyError);
    expect(() => splitEqually(money(100, "USD"), 2.5)).toThrow(InvalidMoneyError);
  });
});

describe("major-unit conversion — exact string math per exponent class", () => {
  it("2-decimal: parse and render", () => {
    expect(fromMajorDecimal("1234.56", "USD")).toEqual(money(123456, "USD"));
    expect(fromMajorDecimal("0.05", "EUR")).toEqual(money(5, "EUR"));
    expect(fromMajorDecimal("100", "GBP")).toEqual(money(10000, "GBP"));
    expect(toMajorString(money(123456, "USD"))).toBe("1234.56");
    expect(toMajorString(money(5, "USD"))).toBe("0.05");
    expect(toMajorString(money(-50, "USD"))).toBe("-0.50");
    expect(toMajorString(money(0, "USD"))).toBe("0.00");
  });

  it("0-decimal (JPY/KRW): no fractional part, ever", () => {
    expect(fromMajorDecimal("15000", "JPY")).toEqual(money(15000, "JPY"));
    expect(toMajorString(money(15000, "JPY"))).toBe("15000");
    expect(toMajorString(money(0, "KRW"))).toBe("0");
    // Sub-minor precision in a source string rounds half-up.
    expect(fromMajorDecimal("15000.5", "JPY")).toEqual(money(15001, "JPY"));
    expect(fromMajorDecimal("15000.4", "JPY")).toEqual(money(15000, "JPY"));
  });

  it("3-decimal (BHD/KWD): thousandths survive exactly", () => {
    expect(fromMajorDecimal("1.234", "BHD")).toEqual(money(1234, "BHD"));
    expect(fromMajorDecimal("0.040", "KWD")).toEqual(money(40, "KWD"));
    expect(toMajorString(money(1234, "BHD"))).toBe("1.234");
    expect(toMajorString(money(40, "BHD"))).toBe("0.040");
    expect(toMajorString(money(-1, "OMR"))).toBe("-0.001");
  });

  it("excess precision rounds half-up on magnitude", () => {
    expect(fromMajorDecimal("0.005", "USD")).toEqual(money(1, "USD"));
    expect(fromMajorDecimal("2.675", "USD")).toEqual(money(268, "USD"));
    expect(fromMajorDecimal("-2.675", "USD")).toEqual(money(-268, "USD"));
    expect(fromMajorDecimal("1.2345", "BHD")).toEqual(money(1235, "BHD"));
  });

  it("rejects garbage", () => {
    expect(() => fromMajorDecimal("abc", "USD")).toThrow(InvalidMoneyError);
    expect(() => fromMajorDecimal("1,234.56", "USD")).toThrow(InvalidMoneyError);
    expect(() => fromMajorDecimal("", "USD")).toThrow(InvalidMoneyError);
    expect(() => fromMajorDecimal("1.00", "ZZZ")).toThrow(UnknownCurrencyError);
  });

  it("toMajorNumber is the numeric form of the exact string", () => {
    expect(toMajorNumber(money(123456, "USD"))).toBe(1234.56);
    expect(toMajorNumber(money(15000, "JPY"))).toBe(15000);
    expect(toMajorNumber(money(1234, "BHD"))).toBe(1.234);
  });
});

describe("formatMoney — Intl formatting per locale and currency", () => {
  it("formats USD for en-US", () => {
    expect(formatMoney(money(123456, "USD"), "en-US")).toBe("$1,234.56");
  });

  it("JPY renders with no decimals", () => {
    expect(formatMoney(money(15000, "JPY"), "en-US")).toBe("¥15,000");
  });

  it("EUR renders German-style for de-DE", () => {
    const out = formatMoney(money(123456, "EUR"), "de-DE");
    expect(out).toContain("1.234,56");
    expect(out).toContain("€");
  });

  it("BHD renders three decimals", () => {
    const out = formatMoney(money(1234, "BHD"), "en-US");
    expect(out).toContain("1.234");
  });
});
