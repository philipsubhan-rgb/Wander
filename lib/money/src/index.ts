/**
 * Shared money type for Wander — the international foundation.
 *
 * Every price in Wander is a money value: an integer count of minor units
 * plus an ISO 4217 currency code (`{ amountMinor: 41200, currency: "EUR" }`).
 * A bare number is never a price. Minor units use the currency's own ISO 4217
 * exponent (EUR/USD/GBP = 2, JPY/KRW = 0, BHD/KWD = 3) — code that assumes 2
 * decimals is a bug by definition.
 *
 * Rules this library enforces structurally:
 * - Arithmetic refuses cross-currency operations (add USD to EUR and it
 *   throws — conversion is a display act with an FX snapshot, never a
 *   silent arithmetic step).
 * - Supplier amounts are stored untouched in the currency quoted; nothing
 *   here converts between currencies.
 * - Legacy itinerary tables (`flights.total_price`, `accommodations.*`)
 *   store `numeric(12,2)` major units + a currency text column. The legacy
 *   converters at the bottom of this file are the ONLY sanctioned boundary
 *   between that shape and the money type (architecture ADR-6).
 */

// ─── ISO 4217 exponents ─────────────────────────────────────────────────────
// Zero-decimal currencies (minor unit == major unit).
const EXPONENT_0 = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF",
  "UGX", "VND", "VUV", "XAF", "XOF", "XPF",
]);

// Three-decimal currencies.
const EXPONENT_3 = new Set([
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
]);

// Every other active ISO 4217 alphabetic currency code is 2-decimal.
// (Precious-metal / funds codes like XAU, XDR, XXX are deliberately absent:
// they are not payment currencies and money in them is meaningless here.)
const EXPONENT_2 = new Set([
  "AED", "AFN", "ALL", "AMD", "ANG", "AOA", "ARS", "AUD", "AWG", "AZN",
  "BAM", "BBD", "BDT", "BGN", "BMD", "BND", "BOB", "BRL", "BSD", "BTN",
  "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CNY",
  "COP", "COU", "CRC", "CUC", "CUP", "CVE", "CZK", "DKK", "DOP", "DZD",
  "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP",
  "GMD", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR",
  "IRR", "JMD", "KES", "KGS", "KHR", "KPW", "KYD", "KZT", "LAK", "LBP",
  "LKR", "LRD", "LSL", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP",
  "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN",
  "NIO", "NOK", "NPR", "NZD", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN",
  "QAR", "RON", "RSD", "RUB", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD",
  "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB",
  "TJS", "TMT", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "USD", "USN",
  "UYI", "UYU", "UYW", "UZS", "VED", "VES", "WST", "XCD", "YER", "ZAR",
  "ZMW", "ZWL",
]);

/** Normalize a currency code for lookup: trim + uppercase. */
function normalizeCurrency(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * The ISO 4217 minor-unit exponent for a currency code, or null when the
 * code is not a known payment currency. Case/whitespace-insensitive.
 */
export function currencyExponent(code: string): number | null {
  if (typeof code !== "string") return null;
  const c = normalizeCurrency(code);
  if (EXPONENT_0.has(c)) return 0;
  if (EXPONENT_3.has(c)) return 3;
  if (EXPONENT_2.has(c)) return 2;
  return null;
}

/** True when the code is a known ISO 4217 payment currency. */
export function isKnownCurrency(code: string): boolean {
  return currencyExponent(code) !== null;
}

// ─── Errors ─────────────────────────────────────────────────────────────────

export class UnknownCurrencyError extends Error {
  constructor(code: string) {
    super(`Unknown ISO 4217 currency code: ${JSON.stringify(code)}`);
    this.name = "UnknownCurrencyError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: cannot combine ${a} with ${b} (conversion requires an FX rate snapshot, never implicit arithmetic)`);
    this.name = "CurrencyMismatchError";
  }
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
  }
}

// ─── The money type ─────────────────────────────────────────────────────────

export interface Money {
  /** Integer count of minor units (cents for USD, yen for JPY, thousandths for BHD). */
  readonly amountMinor: number;
  /** ISO 4217 alphabetic code, uppercase (e.g. "EUR"). */
  readonly currency: string;
}

/**
 * Construct a money value. Validates that the amount is a safe integer and
 * the currency is known; normalizes the code to uppercase. Throws
 * UnknownCurrencyError / InvalidMoneyError on bad input — money that cannot
 * be represented exactly must fail loudly at construction, never downstream.
 */
export function money(amountMinor: number, currency: string): Money {
  const code = typeof currency === "string" ? normalizeCurrency(currency) : "";
  if (currencyExponent(code) === null) throw new UnknownCurrencyError(currency);
  if (!Number.isSafeInteger(amountMinor)) {
    throw new InvalidMoneyError(`amountMinor must be a safe integer, got ${amountMinor}`);
  }
  return Object.freeze({ amountMinor, currency: code });
}

/** Zero in the given currency. */
export function zero(currency: string): Money {
  return money(0, currency);
}

/** True when `value` is a well-formed money value in a known currency. */
export function isMoney(value: unknown): value is Money {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.amountMinor === "number" &&
    Number.isSafeInteger(v.amountMinor) &&
    typeof v.currency === "string" &&
    isKnownCurrency(v.currency)
  );
}

// ─── Arithmetic (same-currency only) ────────────────────────────────────────

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor + b.amountMinor, a.currency);
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return money(a.amountMinor - b.amountMinor, a.currency);
}

export function negate(m: Money): Money {
  return money(-m.amountMinor, m.currency);
}

export function abs(m: Money): Money {
  return money(Math.abs(m.amountMinor), m.currency);
}

/** Sum a list of same-currency values. Empty list → null (no currency to name). */
export function sum(values: readonly Money[]): Money | null {
  if (values.length === 0) return null;
  let total = values[0];
  for (let i = 1; i < values.length; i++) total = add(total, values[i]);
  return total;
}

/** Exact multiplication by an integer factor (e.g. per-person × party size). */
export function multiplyByInt(m: Money, factor: number): Money {
  if (!Number.isSafeInteger(factor)) {
    throw new InvalidMoneyError(`multiplyByInt factor must be a safe integer, got ${factor}`);
  }
  return money(m.amountMinor * factor, m.currency);
}

/** -1 / 0 / 1 ordering. Throws on currency mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amountMinor === b.amountMinor;
}

export function isZero(m: Money): boolean {
  return m.amountMinor === 0;
}

export function isPositive(m: Money): boolean {
  return m.amountMinor > 0;
}

export function isNegative(m: Money): boolean {
  return m.amountMinor < 0;
}

export function min(a: Money, b: Money): Money {
  return compare(a, b) <= 0 ? a : b;
}

export function max(a: Money, b: Money): Money {
  return compare(a, b) >= 0 ? a : b;
}

/**
 * Split a money value into `parts` equal shares that sum EXACTLY to the
 * original (international-foundation §2.6): the rounding remainder — at most
 * a few minor units — goes entirely to the FIRST share, which callers treat
 * as the organizer's share. Splits are computed in the charge currency;
 * conversion happens per person afterwards, at one shared FX snapshot.
 */
export function splitEqually(m: Money, parts: number): Money[] {
  if (!Number.isSafeInteger(parts) || parts < 1) {
    throw new InvalidMoneyError(`splitEqually parts must be a positive integer, got ${parts}`);
  }
  const base = Math.trunc(m.amountMinor / parts);
  const remainder = m.amountMinor - base * parts;
  const shares: Money[] = [];
  for (let i = 0; i < parts; i++) {
    shares.push(money(base + (i === 0 ? remainder : 0), m.currency));
  }
  return shares;
}

// ─── Major-unit conversion (exact, string-based) ────────────────────────────

const MAJOR_PATTERN = /^([+-]?)([0-9]+)(?:\.([0-9]+))?$/;

/**
 * Parse a major-unit decimal string ("1234.56") into minor units for the
 * currency, exactly, using BigInt math. Excess precision beyond the
 * currency's exponent rounds half-up on magnitude (legacy numeric(12,2)
 * columns can carry sub-minor-unit values for 0/3-decimal currencies).
 * Returns null for unparseable input.
 */
function parseMajorToMinor(text: string, exponent: number): bigint | null {
  const match = MAJOR_PATTERN.exec(text.trim());
  if (!match) return null;
  const sign = match[1];
  const intPart = match[2];
  const fracPart = match[3] ?? "";
  let minor: bigint;
  if (fracPart.length <= exponent) {
    minor = BigInt(intPart) * 10n ** BigInt(exponent) +
      (fracPart ? BigInt(fracPart.padEnd(exponent, "0")) : 0n);
  } else {
    const kept = fracPart.slice(0, exponent);
    const dropped = fracPart.slice(exponent);
    minor = BigInt(intPart) * 10n ** BigInt(exponent) + (kept ? BigInt(kept) : 0n);
    if (dropped[0] >= "5") minor += 1n;
  }
  return sign === "-" ? -minor : minor;
}

function bigintToSafeNumber(value: bigint): number | null {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
    return null;
  }
  return Number(value);
}

/**
 * Build a money value from a major-unit decimal string ("1234.56" USD →
 * 123456 minor). Throws on unparseable input / unknown currency / overflow.
 * Prefer this over float math anywhere a decimal string exists.
 */
export function fromMajorDecimal(text: string, currency: string): Money {
  const code = typeof currency === "string" ? normalizeCurrency(currency) : "";
  const exponent = currencyExponent(code);
  if (exponent === null) throw new UnknownCurrencyError(currency);
  const minor = typeof text === "string" ? parseMajorToMinor(text, exponent) : null;
  const amount = minor === null ? null : bigintToSafeNumber(minor);
  if (amount === null) {
    throw new InvalidMoneyError(`Cannot parse ${JSON.stringify(text)} as a ${code} amount`);
  }
  return money(amount, code);
}

/** Exact major-unit decimal string for a money value ("1234.56", "15000", "1.234"). */
export function toMajorString(m: Money): string {
  const exponent = currencyExponent(m.currency)!;
  const negative = m.amountMinor < 0;
  const digits = Math.abs(m.amountMinor).toString().padStart(exponent + 1, "0");
  if (exponent === 0) return (negative ? "-" : "") + digits;
  const intPart = digits.slice(0, -exponent);
  const fracPart = digits.slice(-exponent);
  return `${negative ? "-" : ""}${intPart}.${fracPart}`;
}

/**
 * Major-unit value as a JS number. DISPLAY ONLY (floats cannot represent
 * every decimal exactly) — used for Intl formatting and chart-style output,
 * never for storage or arithmetic.
 */
export function toMajorNumber(m: Money): number {
  return Number(toMajorString(m));
}

/**
 * Format a money value for a traveler, in their locale, through
 * Intl.NumberFormat (international-foundation §1.2: formatting is locale,
 * not language). Intl applies the currency's own fraction digits.
 */
export function formatMoney(m: Money, locale?: string, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
    ...options,
  }).format(toMajorNumber(m));
}

// ─── Legacy boundary converters (architecture ADR-6) ────────────────────────
// Legacy itinerary tables store price as numeric(12,2) major units (a string
// when Drizzle returns it) plus a separate currency text column — and some
// rows carry no price at all. These two helpers are the only sanctioned
// crossing between that shape and the money type.

/**
 * Convert a legacy (numeric amount, currency text) pair into Money.
 * Returns null — never a guessed value — when the amount is missing or
 * unparseable, OR when the currency is missing, blank, or unknown. A null
 * here means "we do not know what this costs"; callers must surface the
 * supplier's original text instead of a fabricated money value.
 */
export function fromLegacyPrice(
  amount: string | number | null | undefined,
  currency: string | null | undefined,
): Money | null {
  if (amount === null || amount === undefined) return null;
  if (typeof currency !== "string" || currency.trim() === "") return null;
  const code = normalizeCurrency(currency);
  const exponent = currencyExponent(code);
  if (exponent === null) return null;
  const text = typeof amount === "number" ? String(amount) : amount;
  if (text.trim() === "") return null;
  const minor = parseMajorToMinor(text, exponent);
  const value = minor === null ? null : bigintToSafeNumber(minor);
  if (value === null) return null;
  return money(value, code);
}

/**
 * Project a money value back into the legacy numeric(12,2) shape. The
 * projection is exponent-aware (JPY 15000 minor → "15000.00", not "150.00")
 * but the legacy column's fixed scale of 2 makes it LOSSY for 3-decimal
 * currencies: BHD 1.234 → "1.23". That loss is a property of the legacy
 * table, named here so nobody mistakes the projection for the fact — the
 * money value remains canonical (ADR-7).
 */
export function toLegacyPrice(m: Money): { amount: string; currency: string } {
  const exponent = currencyExponent(m.currency)!;
  // Rescale minor units to scale-2 (the legacy column's fixed scale),
  // rounding half-up on magnitude when the currency has more precision.
  let scaled: bigint;
  const minor = BigInt(m.amountMinor);
  if (exponent >= 2) {
    const divisor = 10n ** BigInt(exponent - 2);
    const quotient = minor / divisor;
    const remainder = minor % divisor;
    const absRemainder = remainder < 0n ? -remainder : remainder;
    scaled = quotient + (absRemainder * 2n >= divisor ? (minor < 0n ? -1n : 1n) : 0n);
  } else {
    scaled = minor * 10n ** BigInt(2 - exponent);
  }
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(3, "0");
  const amount = `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)}`;
  return { amount, currency: m.currency };
}
