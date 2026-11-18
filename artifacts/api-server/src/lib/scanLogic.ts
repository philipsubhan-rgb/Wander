/**
 * Pure helpers for the Gmail ingestion scan pipeline.
 *
 * Kept free of Express/DB imports so they are unit-testable in isolation:
 *   - confirmation-code normalization + cross-proposal duplicate detection
 *     (kills the "TripIt itinerary + direct vendor email for the same booking"
 *     double proposals)
 *   - trip date matching (exactly-one-trip wins, ambiguity keeps tripId null)
 *   - HMAC-signed stateless OAuth state for the Google connect flow
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// Confirmation-code dedup
// ---------------------------------------------------------------------------

/** Normalize a confirmation code for comparison (case/dash/space insensitive). */
export function normalizeConfirmationCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * True when the parsed reservation's confirmation code was already seen —
 * either in an earlier proposal for this account or earlier in this scan.
 */
export function isDuplicateConfirmationCode(
  seen: Set<string>,
  code: string | undefined,
): boolean {
  if (!code) return false;
  return seen.has(normalizeConfirmationCode(code));
}

// ---------------------------------------------------------------------------
// Trip matching
// ---------------------------------------------------------------------------

export interface MatchableTrip {
  id: number;
  startDate: string; // YYYY-MM-DD
  endDate: string; // YYYY-MM-DD
}

/**
 * Match a parsed reservation date against the user's trips.
 * Returns the trip id only when exactly one trip contains the date;
 * null when there is no date, no match, or ambiguity.
 */
export function matchTrip(trips: MatchableTrip[], date?: string): number | null {
  if (!date) return null;
  const hits = trips.filter((t) => date >= t.startDate && date <= t.endDate);
  return hits.length === 1 ? hits[0].id : null;
}

// ---------------------------------------------------------------------------
// OAuth state: HMAC-signed, stateless CSRF protection for the connect flow.
// ---------------------------------------------------------------------------

function stateSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required for the Google OAuth flow");
  return s;
}

export interface OAuthState {
  userId: number;
  returnTo: string;
  nonce: string;
  exp: number;
  /** Which flow started this consent: plain Gmail connect, or the
   *  incremental calendar write-back consent. Absent on pre-calendar states. */
  purpose?: "gmail" | "calendar";
}

export function signState(state: OAuthState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyState(raw: string): OAuthState | null {
  try {
    const [payload, sig] = raw.split(".");
    if (!payload || !sig) return null;
    const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
    if (sig.length !== expected.length) return null;
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (typeof state.exp !== "number" || state.exp < Date.now()) return null;
    return state;
  } catch {
    return null;
  }
}

/** Build a fresh signed OAuth state value (10-minute expiry). */
export function newOAuthState(
  userId: number,
  returnTo: string,
  purpose: "gmail" | "calendar" = "gmail",
): string {
  return signState({
    userId,
    returnTo,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + 10 * 60 * 1000,
    purpose,
  });
}

// ---------------------------------------------------------------------------
// Granted-scope bookkeeping. `connected_accounts.scopes` stores the union of
// scopes the user has granted (short names, space-separated, e.g.
// "gmail.readonly calendar.events"). Google returns full scope URLs in the
// token response; normalize them to short names before storing/comparing.
// ---------------------------------------------------------------------------

export const GMAIL_READONLY_SCOPE = "gmail.readonly";
export const CALENDAR_EVENTS_SCOPE = "calendar.events";

/** Normalize a Google scope URL (or short name) to its short name. */
export function normalizeScope(scope: string): string {
  return scope
    .trim()
    .replace(/^https:\/\/www\.googleapis\.com\/auth\//, "")
    .replace(/^https:\/\/www\.googleapis\.com\/auth\/userinfo\./, "userinfo.");
}

/** Parse a stored/granted scope string (spaces or commas) into short names. */
export function parseScopes(raw: string | null | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[\s,]+/)
      .map(normalizeScope)
      .filter((s) => s.length > 0),
  );
}

/** Union two scope strings into one canonical stored string (sorted). */
export function mergeScopes(
  existing: string | null | undefined,
  granted: string | null | undefined,
): string {
  const union = new Set([...parseScopes(existing), ...parseScopes(granted)]);
  return [...union].sort().join(" ");
}

/** True when the account has granted Google Calendar event write access. */
export function hasCalendarScope(scopes: string | null | undefined): boolean {
  return parseScopes(scopes).has(CALENDAR_EVENTS_SCOPE);
}
