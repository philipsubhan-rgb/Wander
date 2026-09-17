/**
 * Shared flight-time helpers for Wander.
 *
 * Flights store their departure/arrival as airport-local wall-clock datetimes
 * (e.g. "2027-05-08T09:41") together with the IANA timezone of the airport
 * (e.g. "America/New_York"). All UI surfaces — flight cards, overview,
 * itinerary, trip guide, and the timeline API — must render through these
 * helpers so a 9:41 AM departure always reads 9:41 AM, no matter which
 * timezone the viewer's device is in.
 *
 * Legacy rows (saved before timezones were stored) keep an ISO instant with a
 * `Z` suffix. When the airport timezone is known, the instant is converted to
 * wall time in that zone; otherwise it falls back to the viewer's local zone
 * (the historical behaviour).
 */

// ─── IATA → IANA timezone map ─────────────────────────────────────────────────
// Covers the airports Wander travellers actually use. Unknown codes resolve to
// null, which keeps the legacy rendering path instead of guessing wrong.

const IATA_TIMEZONES: Record<string, string> = {
  // United States
  EWR: 'America/New_York', JFK: 'America/New_York', LGA: 'America/New_York',
  BOS: 'America/New_York', PHL: 'America/New_York', PIT: 'America/New_York',
  BWI: 'America/New_York', DCA: 'America/New_York', IAD: 'America/New_York',
  RDU: 'America/New_York', CLT: 'America/New_York', ATL: 'America/New_York',
  MIA: 'America/New_York', FLL: 'America/New_York', TPA: 'America/New_York',
  MCO: 'America/New_York', JAX: 'America/New_York', MSY: 'America/Chicago',
  BNA: 'America/Chicago', ORD: 'America/Chicago', MDW: 'America/Chicago',
  DFW: 'America/Chicago', IAH: 'America/Chicago', AUS: 'America/Chicago',
  MSP: 'America/Chicago', STL: 'America/Chicago', MCI: 'America/Chicago',
  DEN: 'America/Denver', SLC: 'America/Denver', PHX: 'America/Phoenix',
  LAS: 'America/Los_Angeles', LAX: 'America/Los_Angeles', SFO: 'America/Los_Angeles',
  SJC: 'America/Los_Angeles', SAN: 'America/Los_Angeles', SEA: 'America/Los_Angeles',
  PDX: 'America/Los_Angeles', ANC: 'America/Anchorage', HNL: 'Pacific/Honolulu',
  DTW: 'America/Detroit',
  // Caribbean
  UVF: 'America/St_Lucia', PLS: 'America/Grand_Turk', SJU: 'America/Puerto_Rico',
  STT: 'America/St_Thomas', STX: 'America/St_Thomas', NAS: 'America/Nassau',
  MBJ: 'America/Jamaica', KIN: 'America/Jamaica', PUJ: 'America/Santo_Domingo',
  SDQ: 'America/Santo_Domingo', AUA: 'America/Aruba', CUR: 'America/Curacao',
  SXM: 'America/Lower_Princes', BGI: 'America/Barbados', ANU: 'America/Antigua',
  SKB: 'America/St_Kitts', POS: 'America/Port_of_Spain', GCM: 'America/Cayman',
  HAV: 'America/Havana', CUN: 'America/Cancun', CZM: 'America/Cancun',
  BZE: 'America/Belize', PTY: 'America/Panama', LIR: 'America/Costa_Rica',
  // Canada
  YYZ: 'America/Toronto', YVR: 'America/Vancouver', YUL: 'America/Montreal',
  YYC: 'America/Edmonton', YOW: 'America/Toronto',
  // Europe
  LHR: 'Europe/London', LGW: 'Europe/London', STN: 'Europe/London',
  DUB: 'Europe/Dublin', CDG: 'Europe/Paris', ORY: 'Europe/Paris',
  NCE: 'Europe/Paris', AMS: 'Europe/Amsterdam', BRU: 'Europe/Brussels',
  FRA: 'Europe/Berlin', MUC: 'Europe/Berlin', BER: 'Europe/Berlin',
  ZRH: 'Europe/Zurich', GVA: 'Europe/Zurich', VIE: 'Europe/Vienna',
  PRG: 'Europe/Prague', WAW: 'Europe/Warsaw', CPH: 'Europe/Copenhagen',
  OSL: 'Europe/Oslo', ARN: 'Europe/Stockholm', HEL: 'Europe/Helsinki',
  LIS: 'Europe/Lisbon', MAD: 'Europe/Madrid', BCN: 'Europe/Madrid',
  PMI: 'Europe/Madrid', FCO: 'Europe/Rome', MXP: 'Europe/Rome',
  VCE: 'Europe/Rome', NAP: 'Europe/Rome', ATH: 'Europe/Athens',
  IST: 'Europe/Istanbul',
  // Latin America
  MEX: 'America/Mexico_City', GDL: 'America/Mexico_City', PVR: 'America/Mexico_City',
  BOG: 'America/Bogota', LIM: 'America/Lima', SCL: 'America/Santiago',
  EZE: 'America/Argentina/Buenos_Aires', GRU: 'America/Sao_Paulo',
  GIG: 'America/Sao_Paulo',
  // Middle East / Africa
  DXB: 'Asia/Dubai', AUH: 'Asia/Dubai', DOH: 'Asia/Qatar',
  TLV: 'Asia/Jerusalem', CAI: 'Africa/Cairo', JNB: 'Africa/Johannesburg',
  CPT: 'Africa/Johannesburg', CMN: 'Africa/Casablanca', RAK: 'Africa/Casablanca',
  // Asia Pacific
  DEL: 'Asia/Kolkata', BOM: 'Asia/Kolkata', BLR: 'Asia/Kolkata',
  BKK: 'Asia/Bangkok', HKG: 'Asia/Hong_Kong', SIN: 'Asia/Singapore',
  ICN: 'Asia/Seoul', HND: 'Asia/Tokyo', NRT: 'Asia/Tokyo',
  KIX: 'Asia/Tokyo', PEK: 'Asia/Shanghai', PKX: 'Asia/Shanghai',
  PVG: 'Asia/Shanghai', SYD: 'Australia/Sydney', MEL: 'Australia/Melbourne',
  BNE: 'Australia/Brisbane', AKL: 'Pacific/Auckland',
};

/**
 * Resolve an IANA timezone for an airport field. The field usually holds a
 * bare IATA code ("EWR") but may contain free text — the first 3-letter
 * uppercase token is treated as the code. Returns null when unknown.
 */
export function airportTimeZone(airport: string | null | undefined): string | null {
  if (!airport) return null;
  const code = airport.toUpperCase().match(/\b[A-Z]{3}\b/)?.[0];
  if (!code) return null;
  return IATA_TIMEZONES[code] ?? null;
}

// ─── Wall-clock conversion ────────────────────────────────────────────────────

const OFFSET_SUFFIX = /([zZ]|[+-]\d{2}:?\d{2})$/;
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?/;

function wallPartsInZone(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

function fromNaiveParts(value: string): Date {
  const m = value.match(NAIVE);
  if (!m) return new Date(value);
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
}

/**
 * Convert a stored flight datetime into a `Date` whose *viewer-local* fields
 * equal the wall-clock time at the airport, so plain local formatting
 * (`date-fns` `format`, `Intl`, …) renders the airport-local time.
 *
 * - With a timezone: naive values are taken literally as airport wall time;
 *   legacy `Z`-suffixed instants are converted into that zone's wall time.
 * - Without a timezone: `Z`-suffixed instants keep the historical behaviour
 *   (rendered in the viewer's zone); naive values are taken literally.
 */
export function flightWallDate(value: string, timeZone?: string | null): Date {
  if (!value) return new Date(NaN);
  const trimmed = value.trim();
  const hasOffset = OFFSET_SUFFIX.test(trimmed);
  if (timeZone) {
    if (hasOffset) {
      const p = wallPartsInZone(new Date(trimmed), timeZone);
      return new Date(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    }
    return fromNaiveParts(trimmed);
  }
  if (hasOffset) return new Date(trimmed);
  return fromNaiveParts(trimmed);
}

// ─── Formatters (single shared surface for all flight rendering) ──────────────

const TIME_12 = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
const TIME_24 = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
const DATE_SHORT = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const DATE_MED = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DATE_FULL = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

/** "9:41 AM" — airport-local time, 12-hour clock. */
export function formatFlightTime(value: string, timeZone?: string | null): string {
  return TIME_12.format(flightWallDate(value, timeZone));
}

/** "09:41" — airport-local time, 24-hour clock. */
export function formatFlightTime24(value: string, timeZone?: string | null): string {
  return TIME_24.format(flightWallDate(value, timeZone));
}

/** "Sat, May 8" — airport-local date. */
export function formatFlightDate(value: string, timeZone?: string | null): string {
  return DATE_SHORT.format(flightWallDate(value, timeZone));
}

/** "Sat, May 8 · 9:41 AM" — airport-local date and time. */
export function formatFlightDateTime(value: string, timeZone?: string | null): string {
  const d = flightWallDate(value, timeZone);
  return `${DATE_SHORT.format(d)} · ${TIME_12.format(d)}`;
}

/** "May 8" — airport-local month/day (compact card subtitles). */
export function formatFlightMonthDay(value: string, timeZone?: string | null): string {
  return DATE_MED.format(flightWallDate(value, timeZone));
}

/** "May 8, 2027" — airport-local full date (card detail lines). */
export function formatFlightFullDate(value: string, timeZone?: string | null): string {
  return DATE_FULL.format(flightWallDate(value, timeZone));
}

/** "2027-05-08" — airport-local calendar day, for grouping flights into days. */
export function flightDateKey(value: string, timeZone?: string | null): string {
  const d = flightWallDate(value, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Timeline-event helpers. Date-only values (no time component) keep the
 * historical behaviour: the calendar day is taken literally and the time is
 * null, so day-grouping never shifts across midnight in the server's zone.
 */

/** Airport-local calendar day for a timeline event. */
export function flightEventDate(value: string, timeZone?: string | null): string {
  const v = value.trim();
  return v.length > 10 ? flightDateKey(v, timeZone) : v.substring(0, 10);
}

/** "HH:mm" airport-local time for a timeline event, or null when date-only. */
export function flightEventTime(value: string, timeZone?: string | null): string | null {
  const v = value.trim();
  return v.length > 10 ? formatFlightTime24(v, timeZone) : null;
}

/**
 * Convert a stored flight datetime to the "YYYY-MM-DDTHH:mm" shape used by
 * `datetime-local` inputs, expressed in airport-local wall time.
 */
export function toDatetimeLocalValue(value: string, timeZone?: string | null): string {
  const d = flightWallDate(value, timeZone);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Format a money amount for fare / stay pricing, e.g. formatMoney("1286.26", "USD")
 * → "$1,286.26". Falls back to a plain "amount CODE" rendering when the
 * currency is not a valid ISO code.
 */
export function formatMoney(amount: string | number | null | undefined, currency?: string | null): string | null {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n)) return null;
  const code = (currency || 'USD').toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(n);
  } catch {
    return `${n.toFixed(2)} ${code}`;
  }
}
