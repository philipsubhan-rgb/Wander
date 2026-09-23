/**
 * Reservation parser: turns booking-confirmation emails into structured
 * reservation proposals. Pure functions — no I/O, fully unit-testable.
 *
 * v1 is heuristic: sender classification + regex extraction. Anything
 * ambiguous still becomes a proposal but with confidence "low" so the user
 * reviews it before it touches their trip.
 */

import type { ParsedReservation } from "@workspace/db";

export interface InboundEmail {
  from: string;
  subject: string;
  snippet: string;
  bodyText: string;
  receivedAt?: string;
}

type ReservationType = ParsedReservation["type"];

const BOOKING_KEYWORDS = [
  "confirmation", "confirmed", "booking", "reservation", "reserved",
  "e-ticket", "eticket", "itinerary", "check-in", "check in",
  "your trip", "your stay", "booking reference", "order confirmation",
];

const SENDER_RULES: { match: RegExp; type: ReservationType; source: string }[] = [
  { match: /getyourguide/i, type: "tour", source: "getyourguide" },
  { match: /opentable/i, type: "restaurant", source: "opentable" },
  { match: /resy/i, type: "restaurant", source: "resy" },
  { match: /united\.com/i, type: "transport", source: "united" },
  { match: /aa\.com|americanairlines/i, type: "transport", source: "american" },
  { match: /delta\.com/i, type: "transport", source: "delta" },
  { match: /marriott/i, type: "other", source: "marriott" },
  { match: /hyatt/i, type: "other", source: "hyatt" },
  { match: /airbnb/i, type: "other", source: "airbnb" },
  { match: /vrbo/i, type: "other", source: "vrbo" },
  { match: /sixt/i, type: "transport", source: "sixt" },
  { match: /hertz|avis|enterprise/i, type: "transport", source: "rental-car" },
  { match: /ticketmaster|eventbrite/i, type: "event", source: "tickets" },
];

function classifySender(from: string): { type: ReservationType; source: string } | null {
  for (const rule of SENDER_RULES) {
    if (rule.match.test(from)) return { type: rule.type, source: rule.source };
  }
  return null;
}

/** Does this email look like a booking confirmation at all? */
export function looksLikeBooking(email: InboundEmail): boolean {
  const haystack = `${email.subject}\n${email.snippet}\n${email.from}`.toLowerCase();
  if (classifySender(email.from)) {
    return BOOKING_KEYWORDS.some((k) => haystack.includes(k));
  }
  const hits = BOOKING_KEYWORDS.filter((k) => haystack.includes(k)).length;
  return hits >= 2;
}

const CODE_PATTERNS = [
  // Labeled codes, colon required: "Booking reference: GYGZGZRLXQ5V"
  /(?:confirmation|booking|reservation|order)(?:\s+(?:number|code|reference|#|no\.?))?\s*[:#]\s*([A-Z0-9-]{5,12})/i,
  // Standalone PNR / record locator without a colon
  /\bPNR\s+([A-Z0-9]{5,8})\b/i,
  /record locator\s+([A-Z0-9]{5,8})/i,
];

export function extractConfirmationCode(text: string): string | undefined {
  for (const pattern of CODE_PATTERNS) {
    const m = pattern.exec(text);
    if (m?.[1]) return m[1].toUpperCase();
  }
  return undefined;
}

const DATE_PATTERNS = [
  // September 26, 2026 / Sep 26, 2026
  /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i,
  // 2026-09-26 or 09/26/2026
  /\b(\d{4})-(\d{2})-(\d{2})\b/,
  /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/,
];

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04", jun: "06", jul: "07", aug: "08",
  sep: "09", sept: "09", oct: "10", nov: "11", dec: "12",
};

/** Extract an ISO date (YYYY-MM-DD) from free text, if one is clearly present. */
export function extractDate(text: string): string | undefined {
  let m = DATE_PATTERNS[0].exec(text);
  if (m) {
    const month = MONTHS[m[1].toLowerCase()];
    if (month) return `${m[3]}-${month}-${m[2].padStart(2, "0")}`;
  }
  m = DATE_PATTERNS[1].exec(text);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = DATE_PATTERNS[2].exec(text);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  return undefined;
}

const TIME_PATTERN = /\b(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)\b/;

/** Extract a time like "7:30 PM" from free text. */
export function extractTime(text: string): string | undefined {
  const m = TIME_PATTERN.exec(text);
  if (m) return `${m[1]}:${m[2]} ${m[3].toUpperCase()}`;
  return undefined;
}

const PARTY_PATTERN = /(?:party of|table for|guests?|party|people|persons)\s*[:#]?\s*(\d{1,2})\b/i;

export function extractPartySize(text: string): number | undefined {
  const m = PARTY_PATTERN.exec(text);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 50) return n;
  }
  return undefined;
}

/**
 * Parse a booking email into a reservation proposal. Returns null when the
 * email doesn't look like a booking confirmation.
 */
export function parseReservation(email: InboundEmail): ParsedReservation | null {
  if (!looksLikeBooking(email)) return null;

  const senderHit = classifySender(email.from);
  const combined = `${email.subject}\n${email.bodyText}`;
  const snippetFirst = `${email.subject}\n${email.snippet}\n${email.bodyText.slice(0, 2000)}`;

  const confirmationCode = extractConfirmationCode(combined);
  const date = extractDate(snippetFirst);
  const time = extractTime(snippetFirst);
  const numberOfPeople = extractPartySize(combined);

  // Title: prefer a cleaned subject line.
  let title = email.subject
    .replace(/^(re:\s*|fwd?:\s*)/i, "")
    .replace(/\s*[-–|]\s*(confirmation|confirmed|booking).*/i, "")
    .trim()
    .slice(0, 120);
  if (!title) title = `Booking from ${senderHit?.source ?? email.from}`;

  let confidence: ParsedReservation["confidence"] = "low";
  if (senderHit && confirmationCode && date) confidence = "high";
  else if (senderHit || (confirmationCode && date)) confidence = "medium";

  return {
    type: senderHit?.type ?? "other",
    title,
    date,
    time,
    confirmationCode,
    numberOfPeople,
    notes: email.snippet.slice(0, 300) || undefined,
    confidence,
    source: senderHit?.source ?? "generic",
  };
}
