/**
 * Booking Gate — the REVIEW confirmation surface, as data
 * (architecture-north-star §5.2, design decision 6).
 *
 * The gate's REVIEW state is a designed confirmation moment: exact
 * charge-currency total, home equivalent with its FX stamp,
 * plain-language terms, covered travelers, the why-this-option line,
 * and a distinct on-screen Confirm action bound to the attempt id.
 * Marco's review TEXT (agentBookingTools.formatReviewText) is the
 * conversational rendering of the same facts; this module is the
 * structured projection the on-screen card renders — built read-only
 * from the attempt + coverage rows, so the card can never show a
 * total the gate doesn't hold.
 *
 * Discipline carried over from the gate:
 *  - Money is the international type ({amountMinor, currency}) and
 *    stays in the CHARGE currency. The home equivalent rides along
 *    ONLY when the attempt carries one backed by a stored FX snapshot
 *    — the snapshot's rate/as-of/source are the provenance stamp, and
 *    a missing snapshot means no equivalent is shown, never a
 *    computed guess.
 *  - Covered travelers are NAMES ONLY (plus payer/confirmed flags) —
 *    the projection never touches the profile vault.
 *  - `confirmable` is evaluated for the requesting viewer through the
 *    gate's own ConfirmationPolicy instance, so the card's Confirm
 *    button can never promise what the gate would refuse.
 */

import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  bookingAttemptsTable,
  fxRateSnapshotsTable,
  tripRosterEntriesTable,
  usersTable,
  type BookingAttempt,
  type BookingAttemptTraveler,
} from "@workspace/db";
import { getDefaultBookingGate, type BookingGate } from "./bookingGate";
import type { BookingGateState } from "@workspace/db";

// ─── The projection ──────────────────────────────────────────────────────────

export interface BookingReviewMoney {
  amountMinor: number;
  currency: string;
}

export interface BookingReviewFxStamp {
  snapshotId: number;
  baseCurrency: string;
  quoteCurrency: string;
  /** Units of quote currency per 1 unit of base, as stored (numeric string). */
  rate: string;
  /** ISO timestamp of the rate (the snapshot's as-of). */
  asOf: string;
  /** The feed the rate came from (e.g. "ECB/Frankfurter"). */
  source: string;
}

export interface BookingReviewProjection {
  attemptId: number;
  tripId: number;
  kind: string;
  supplier: string;
  state: BookingGateState;
  /** What is being booked, in travel terms: the option's own label. */
  label: string;
  /** Per-kind travel-term lines (route/dates, property/nights…). */
  detailLines: string[];
  /** The total a confirmation binds to — CHARGE currency, untouched. */
  total: BookingReviewMoney;
  /** True when `total` is the re-verified (reviewed) figure. */
  totalIsReviewed: boolean;
  /** Snapshot-backed home-currency equivalent, or null — never guessed. */
  homeEquivalent: (BookingReviewMoney & { fx: BookingReviewFxStamp | null }) | null;
  /** Plain-language terms lines, exactly as the gate recorded them. */
  terms: string[];
  /** Names only — never profile data. */
  coveredTravelers: Array<{ name: string; isPayer: boolean; confirmed: boolean }>;
  whyThisOption: { value: string; text: string } | null;
  reviewVersion: number;
  /** May the REQUESTING viewer complete the confirmation right now? */
  confirmable: boolean;
  /** The policy's own reason when in REVIEW but not confirmable by this viewer. */
  confirmBlockedReason: string | null;
  confirmedBy: { name: string; at: string | null } | null;
  failureReason: string | null;
  bookingId: number | null;
  updatedAt: string;
}

// ─── Snapshot summary, in travel terms ───────────────────────────────────────

type RawRecord = Record<string, unknown>;

function asRecord(v: unknown): RawRecord {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as RawRecord) : {};
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * The option exactly as presented (§5.2), described in travel terms.
 * Reads the snapshotted summary defensively — the snapshot is JSON the
 * Options Service produced; anything absent is simply not claimed.
 */
export function summarizeSnapshotOption(attempt: BookingAttempt): {
  label: string;
  detailLines: string[];
} {
  const option = asRecord(attempt.optionSnapshot?.option);
  const summary = asRecord(option.summary);
  const label =
    asString(summary.label) ?? `${attempt.supplier} (${attempt.kind})`;
  const lines: string[] = [];

  if (attempt.optionSnapshot?.change) {
    lines.push(
      `Change to booking #${attempt.optionSnapshot.change.bookingId} — the total below is the change amount (extra charge, or a refund when negative), on top of the original booking.`,
    );
  }

  if (attempt.kind === "flight") {
    const slices = Array.isArray(summary.slices) ? summary.slices : [];
    for (const raw of slices) {
      const slice = asRecord(raw);
      const origin = asString(slice.origin);
      const destination = asString(slice.destination);
      if (!origin || !destination) continue;
      const flightNumbers = Array.isArray(slice.flightNumbers)
        ? slice.flightNumbers.filter((n): n is string => typeof n === "string")
        : [];
      const departAt = asString(slice.departAt);
      const stops = asNumber(slice.stops);
      lines.push(
        [
          `${origin} → ${destination}`,
          flightNumbers.length > 0 ? flightNumbers.join(", ") : null,
          departAt ? `departs ${departAt.slice(0, 10)}` : null,
          stops !== null ? (stops === 0 ? "nonstop" : `${stops} stop${stops === 1 ? "" : "s"}`) : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
    }
    const fareClass = asString(summary.fareClass);
    const cabinClass = asString(summary.cabinClass);
    if (fareClass) lines.push(`Fare: ${fareClass}`);
    else if (cabinClass) lines.push(`Cabin: ${cabinClass}`);
  } else if (attempt.kind === "stay") {
    const propertyName = asString(summary.propertyName);
    if (propertyName && propertyName !== label) lines.push(propertyName);
    const checkIn = asString(summary.checkInDate);
    const checkOut = asString(summary.checkOutDate);
    const nights = asNumber(summary.nights);
    const guests = asNumber(summary.guestCount);
    if (checkIn && checkOut) {
      lines.push(
        [
          `${checkIn} → ${checkOut}`,
          nights !== null ? `${nights} night${nights === 1 ? "" : "s"}` : null,
          guests !== null ? `${guests} guest${guests === 1 ? "" : "s"}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      );
    }
    const roomName = asString(summary.roomName);
    if (roomName) lines.push(`Room: ${roomName}`);
  }

  return { label, detailLines: lines };
}

// ─── Name resolution (names only — the vault is never read here) ────────────

async function resolveNames(
  coverage: BookingAttemptTraveler[],
  extraUserIds: Array<number | null | undefined>,
): Promise<{ userName: (id: number | null) => string | null; rosterName: (id: number | null) => string | null }> {
  const userIds = [
    ...new Set([
      ...coverage.map((c) => c.userId),
      ...extraUserIds,
    ].filter((id): id is number => typeof id === "number")),
  ];
  const rosterIds = [
    ...new Set(coverage.map((c) => c.rosterEntryId).filter((id): id is number => typeof id === "number")),
  ];

  const users = new Map<number, string>();
  if (userIds.length > 0) {
    const rows = await db
      .select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(inArray(usersTable.id, userIds));
    for (const row of rows) users.set(row.id, row.name);
  }
  const roster = new Map<number, string>();
  if (rosterIds.length > 0) {
    const rows = await db
      .select({ id: tripRosterEntriesTable.id, invitedName: tripRosterEntriesTable.invitedName })
      .from(tripRosterEntriesTable)
      .where(inArray(tripRosterEntriesTable.id, rosterIds));
    for (const row of rows) roster.set(row.id, row.invitedName);
  }

  return {
    userName: (id) => (id !== null ? (users.get(id) ?? null) : null),
    rosterName: (id) => (id !== null ? (roster.get(id) ?? null) : null),
  };
}

// ─── The builder ─────────────────────────────────────────────────────────────

/**
 * Build the review projection for one attempt, from the attempt +
 * coverage rows (read-only — this function writes nothing). Access
 * control is the caller's job (the gate's getAttemptView enforces it
 * on the read paths below).
 */
export async function buildBookingReviewProjection(
  gate: BookingGate,
  attempt: BookingAttempt,
  coverage: BookingAttemptTraveler[],
  viewerUserId: number,
): Promise<BookingReviewProjection> {
  const { label, detailLines } = summarizeSnapshotOption(attempt);
  const names = await resolveNames(coverage, [attempt.confirmedByUserId]);

  // Home equivalent: only the snapshot-backed figure the attempt
  // already carries, with the snapshot itself as the FX stamp.
  let homeEquivalent: BookingReviewProjection["homeEquivalent"] = null;
  if (attempt.homeEquivalentMinor !== null && attempt.homeCurrency) {
    let fx: BookingReviewFxStamp | null = null;
    if (attempt.fxSnapshotId !== null) {
      const [snapshot] = await db
        .select()
        .from(fxRateSnapshotsTable)
        .where(eq(fxRateSnapshotsTable.id, attempt.fxSnapshotId));
      if (snapshot) {
        fx = {
          snapshotId: snapshot.id,
          baseCurrency: snapshot.baseCurrency,
          quoteCurrency: snapshot.quoteCurrency,
          rate: String(snapshot.rate),
          asOf: snapshot.asOf.toISOString(),
          source: snapshot.source,
        };
      }
    }
    homeEquivalent = {
      amountMinor: attempt.homeEquivalentMinor,
      currency: attempt.homeCurrency,
      fx,
    };
  }

  const terms: string[] = [];
  if (attempt.changeTerms) terms.push(`Changes: ${attempt.changeTerms}`);
  if (attempt.cancelTerms) terms.push(`Cancellation: ${attempt.cancelTerms}`);
  if (attempt.visibility === "private") {
    terms.push("Visibility: private — this won't be broadcast on the shared itinerary.");
  }

  // Confirmability is the gate policy's verdict for THIS viewer — the
  // same instance confirmAttempt consults, so card and gate agree.
  let confirmable = false;
  let confirmBlockedReason: string | null = null;
  if (attempt.state === "review") {
    const decision = gate.policyDecisionFor(coverage, viewerUserId);
    confirmable = decision.allowed;
    if (!decision.allowed) confirmBlockedReason = decision.reason;
  }

  return {
    attemptId: attempt.id,
    tripId: attempt.tripId,
    kind: attempt.kind,
    supplier: attempt.supplier,
    state: attempt.state,
    label,
    detailLines,
    total: {
      amountMinor: attempt.reviewedAmountMinor ?? attempt.presentedAmountMinor,
      currency: attempt.reviewedCurrency ?? attempt.presentedCurrency,
    },
    totalIsReviewed: attempt.reviewedAmountMinor !== null,
    homeEquivalent,
    terms,
    coveredTravelers: coverage.map((c) => ({
      name:
        names.userName(c.userId) ??
        names.rosterName(c.rosterEntryId) ??
        "Traveler",
      isPayer: c.isPayer,
      confirmed: c.confirmedAt !== null,
    })),
    whyThisOption: attempt.whyThisOptionText
      ? { value: attempt.whyThisOption, text: attempt.whyThisOptionText }
      : null,
    reviewVersion: attempt.reviewVersion,
    confirmable,
    confirmBlockedReason,
    confirmedBy:
      attempt.confirmedByUserId !== null
        ? {
            name: names.userName(attempt.confirmedByUserId) ?? "A traveler",
            at: attempt.confirmedAt ? attempt.confirmedAt.toISOString() : null,
          }
        : null,
    failureReason: attempt.failureReason,
    bookingId: attempt.bookingId,
    updatedAt: attempt.updatedAt.toISOString(),
  };
}

/** One attempt's projection, access-checked through the gate. */
export async function getBookingReviewProjection(
  attemptId: number,
  actor: { userId: number; role: string },
  gate: BookingGate = getDefaultBookingGate(),
): Promise<BookingReviewProjection> {
  const { attempt, coverage } = await gate.getAttemptView(attemptId, actor);
  return buildBookingReviewProjection(gate, attempt, coverage, actor.userId);
}

/**
 * The trip's attempts in one gate state (the trip page's "waiting on
 * your confirmation" mirror reads state=review), as projections.
 * Access is re-checked per attempt through the gate; attempts the
 * actor may not see are skipped, never leaked (the voice gateway's
 * pending-confirmation precedent).
 */
export async function listBookingReviewProjections(
  tripId: number,
  state: BookingGateState,
  actor: { userId: number; role: string },
  gate: BookingGate = getDefaultBookingGate(),
): Promise<BookingReviewProjection[]> {
  const rows = await db
    .select()
    .from(bookingAttemptsTable)
    .where(and(eq(bookingAttemptsTable.tripId, tripId), eq(bookingAttemptsTable.state, state)));
  const out: BookingReviewProjection[] = [];
  for (const row of [...rows].sort((a, b) => a.id - b.id)) {
    try {
      const { attempt, coverage } = await gate.getAttemptView(row.id, actor);
      if (attempt.state !== state) continue;
      out.push(await buildBookingReviewProjection(gate, attempt, coverage, actor.userId));
    } catch {
      // Not visible to this actor — not theirs to confirm.
    }
  }
  return out;
}
