/**
 * Watching pipeline — pure logic (architecture-north-star §6.2,
 * international-foundation §4.2). No DB, no HTTP: every function here
 * is deterministic over its inputs so the whole pipeline — dedupe,
 * materiality, worsening, impact walk — is unit-testable, and the
 * service layer (watching.ts) is a thin shell over it.
 *
 * The pipeline's shape (§6.2):
 *   status → DEDUPE vs last_status_snapshot → MATERIALITY (thresholds)
 *   → IMPACT WALK → ADVISORY → NOTIFY. The advisory never books, moves,
 *   or charges anything; this module only decides and describes.
 */

import type {
  AdvisoryImpact,
  AdvisoryKind,
  AdvisorySeverity,
  AdvisorySituation,
  FlightStatusSnapshot,
} from "@workspace/db";
import type { TimelineEvent } from "./timeline.js";

// ─── Config — every watching number lives here (§6.1, Story 5.1) ─────────────

export interface WatchingThresholds {
  /** Arrival delay (estimated/actual vs scheduled) that is material. */
  arrivalDelayMinutes: number;
  /** Pre-departure shift of the scheduled times that is material. */
  scheduleChangeMinutes: number;
  /** Gate/terminal changes are material only within this many hours
   * before departure; days out they are noise (international §4.1). */
  gateChangeWindowHours: number;
  /** Any cancellation is material. */
  notifyOnCancellation: boolean;
  /** Any diversion is material. */
  notifyOnDiversion: boolean;
}

export interface WatchingConfig {
  thresholds: WatchingThresholds;
  /** Minimum plausible connection slack at an airport, minutes. There
   * is no MCT data source in the spike; this is the stated default the
   * impact walk compares against (international §4.2.3). */
  minConnectMinutes: number;
  /** Realistic airport → property transfer time used by check-in and
   * reservation risk math, minutes. */
  transferMinutes: number;
  /** Local hour at the destination from which an arrival counts as a
   * late arrival for check-in purposes (front-desk / hold territory). */
  lateArrivalHour: number;
}

export const WATCHING_CONFIG: WatchingConfig = {
  thresholds: {
    arrivalDelayMinutes: 30,
    scheduleChangeMinutes: 15,
    gateChangeWindowHours: 24,
    notifyOnCancellation: true,
    notifyOnDiversion: true,
  },
  minConnectMinutes: 60,
  transferMinutes: 60,
  lateArrivalHour: 21,
};

/**
 * Per-traveler materiality thresholds (§6.1: "per-traveler materiality
 * config on the profile"). Today every traveler resolves to the
 * defaults — the profile store carries notification channels and quiet
 * hours, not delay thresholds yet — and this resolver is the single
 * seam where stored per-traveler overrides plug in when they land.
 * Legacy flights belong to the whole trip party, so the service
 * evaluates materiality once per flight with these thresholds.
 */
export function thresholdsForTraveler(_userId: number): WatchingThresholds {
  return WATCHING_CONFIG.thresholds;
}

// ─── Time helpers ────────────────────────────────────────────────────────────

/**
 * Convert an airport-local wall-clock datetime ("YYYY-MM-DDTHH:mm", the
 * legacy flights storage shape) in an IANA zone to a UTC instant (ms).
 * Two-pass Intl offset resolution, independent of the server's own zone.
 */
export function wallClockToUtcMs(wall: string, timeZone: string | null): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(wall.trim());
  if (!m) {
    const parsed = Date.parse(wall);
    return Number.isNaN(parsed) ? NaN : parsed;
  }
  const [, y, mo, d, h, mi] = m;
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  if (!timeZone) return guess;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const offsetAt = (instantMs: number): number => {
    const parts = dtf.formatToParts(new Date(instantMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    return asUtc - instantMs;
  };
  const firstPass = guess - offsetAt(guess);
  return guess - offsetAt(firstPass);
}

/** "YYYY-MM-DD" of an instant in a zone (the traveler's local day). */
export function dateKeyInZone(instantMs: number, timeZone: string | null): string {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return dtf.format(new Date(instantMs));
}

/** Minutes since local midnight of an instant in a zone. */
export function minutesOfDayInZone(instantMs: number, timeZone: string | null): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ?? undefined,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = dtf.formatToParts(new Date(instantMs));
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** "7:10 AM" for an ISO instant in a zone. */
export function formatTimeInZone(iso: string | null, timeZone: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone ?? undefined,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(ms));
}

/** 125 → "2h 5m"; 45 → "45m"; 120 → "2h". */
export function formatDelay(minutes: number): string {
  const abs = Math.abs(Math.round(minutes));
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

// ─── Dedupe (§6.1: dedupe against last_status_snapshot) ──────────────────────

const SNAPSHOT_COMPARE_FIELDS: Array<keyof FlightStatusSnapshot> = [
  "faFlightId",
  "status",
  "cancelled",
  "diverted",
  "scheduledOut",
  "estimatedOut",
  "actualOut",
  "scheduledIn",
  "estimatedIn",
  "actualIn",
  "gateOrigin",
  "gateDestination",
  "terminalOrigin",
  "terminalDestination",
  "arrivalDelayMinutes",
  "departureDelayMinutes",
];

/** True when two snapshots describe the same situation (source and
 * observedAt deliberately excluded — a re-delivery is a duplicate). */
export function snapshotsEqual(
  a: FlightStatusSnapshot | null | undefined,
  b: FlightStatusSnapshot | null | undefined,
): boolean {
  if (!a || !b) return a === b || (!a && !b);
  return SNAPSHOT_COMPARE_FIELDS.every((f) => a[f] === b[f]);
}

// ─── Materiality (§4.2.2: score the event against the thresholds) ────────────

export interface WatchFlightContext {
  /** "UA30" */
  label: string;
  /** "EWR → MUC" */
  route: string;
  originTimezone: string | null;
  destinationTimezone: string | null;
  /** The booked (legacy row) scheduled instants — the baseline a
   * schedule change is measured against before any snapshot exists. */
  bookedDepartureMs: number;
  bookedArrivalMs: number;
}

export interface DetectedChange {
  kind: AdvisoryKind;
  severity: AdvisorySeverity;
  summary: string;
  situation: AdvisorySituation;
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const v = Date.parse(iso);
  return Number.isNaN(v) ? null : v;
}

function diffMinutes(later: number | null, earlier: number | null): number | null {
  if (later === null || earlier === null) return null;
  return Math.round((later - earlier) / 60000);
}

/**
 * Compare the incoming snapshot against the previous one (and the
 * booked baseline) and return every material change. Sub-threshold
 * movement returns nothing — it updates the itinerary quietly (§4.2.2).
 * Cancellation/diversion supersede the delay-family kinds: once a
 * flight is cancelled, a "delay" advisory about it is noise.
 */
export function detectChanges(input: {
  prev: FlightStatusSnapshot | null;
  next: FlightStatusSnapshot;
  flight: WatchFlightContext;
  thresholds: WatchingThresholds;
  now: Date;
}): DetectedChange[] {
  const { prev, next, flight, thresholds, now } = input;
  const changes: DetectedChange[] = [];
  const label = `${flight.label} (${flight.route})`;

  if (next.cancelled) {
    if (thresholds.notifyOnCancellation) {
      changes.push({
        kind: "cancellation",
        severity: "critical",
        summary: `${label} has been cancelled.`,
        situation: { signature: "cancelled", metric: 1 },
      });
    }
    return changes;
  }

  if (next.diverted) {
    if (thresholds.notifyOnDiversion) {
      changes.push({
        kind: "diversion",
        severity: "critical",
        summary: `${label} has been diverted${next.status ? ` — current status: ${next.status}` : ""}.`,
        situation: { signature: "diverted", metric: 1 },
      });
    }
    return changes;
  }

  // Arrival delay — estimated/actual arrival vs the flight's scheduled arrival.
  const arrivalDelay = next.arrivalDelayMinutes;
  if (arrivalDelay !== null && arrivalDelay >= thresholds.arrivalDelayMinutes) {
    const newArrival = next.actualIn ?? next.estimatedIn;
    changes.push({
      kind: "arrival_delay",
      severity: arrivalDelay >= 120 ? "high" : "medium",
      summary:
        `${label} is running about ${formatDelay(arrivalDelay)} late — ` +
        `now expected in at ${formatTimeInZone(newArrival, flight.destinationTimezone)}` +
        (next.scheduledIn
          ? ` instead of ${formatTimeInZone(next.scheduledIn, flight.destinationTimezone)}`
          : "") +
        ".",
      situation: { signature: `arrival-delay:${arrivalDelay}`, metric: arrivalDelay },
    });
  }

  // Schedule change — the SCHEDULED times themselves moved vs the
  // previous snapshot (or, for the first snapshot, vs what was booked).
  // Pre-departure only: once the flight has left, a moved schedule is
  // history, not news.
  if (!next.actualOut) {
    const baseOut = prev ? ms(prev.scheduledOut) : flight.bookedDepartureMs;
    const baseIn = prev ? ms(prev.scheduledIn) : flight.bookedArrivalMs;
    const outShift = diffMinutes(ms(next.scheduledOut), baseOut);
    const inShift = diffMinutes(ms(next.scheduledIn), baseIn);
    const metric = Math.max(Math.abs(outShift ?? 0), Math.abs(inShift ?? 0));
    if (metric >= thresholds.scheduleChangeMinutes) {
      const dominant = Math.abs(outShift ?? 0) >= Math.abs(inShift ?? 0) ? outShift : inShift;
      const direction = (dominant ?? 0) > 0 ? "later" : "earlier";
      changes.push({
        kind: "schedule_change",
        severity: "medium",
        summary:
          `${label} has been rescheduled ${formatDelay(metric)} ${direction} — ` +
          `now departing ${formatTimeInZone(next.scheduledOut, flight.originTimezone)}, ` +
          `arriving ${formatTimeInZone(next.scheduledIn, flight.destinationTimezone)}.`,
        situation: { signature: `schedule-shift:${outShift ?? 0}/${inShift ?? 0}`, metric },
      });
    }
  }

  // Gate / terminal change — material only inside the pre-departure
  // window (§4.1: day-of signal, days-out noise). A first-ever gate
  // assignment is not a change: there must be a previous value.
  if (prev) {
    const gateChanged =
      (prev.gateOrigin !== null && next.gateOrigin !== prev.gateOrigin) ||
      (prev.gateDestination !== null && next.gateDestination !== prev.gateDestination) ||
      (prev.terminalOrigin !== null && next.terminalOrigin !== prev.terminalOrigin) ||
      (prev.terminalDestination !== null && next.terminalDestination !== prev.terminalDestination);
    if (gateChanged) {
      const departureMs = ms(next.scheduledOut) ?? flight.bookedDepartureMs;
      const hoursUntil = (departureMs - now.getTime()) / 3_600_000;
      if (hoursUntil <= thresholds.gateChangeWindowHours && hoursUntil >= -1) {
        const parts: string[] = [];
        if (next.gateOrigin !== prev.gateOrigin && next.gateOrigin) {
          parts.push(`departure gate ${prev.gateOrigin ?? "—"} → ${next.gateOrigin}`);
        }
        if (next.terminalOrigin !== prev.terminalOrigin && next.terminalOrigin) {
          parts.push(`departure terminal ${prev.terminalOrigin ?? "—"} → ${next.terminalOrigin}`);
        }
        if (next.gateDestination !== prev.gateDestination && next.gateDestination) {
          parts.push(`arrival gate ${prev.gateDestination ?? "—"} → ${next.gateDestination}`);
        }
        if (next.terminalDestination !== prev.terminalDestination && next.terminalDestination) {
          parts.push(`arrival terminal ${prev.terminalDestination ?? "—"} → ${next.terminalDestination}`);
        }
        changes.push({
          kind: "gate_change",
          severity: "low",
          summary: `${label}: ${parts.join("; ")}.`,
          situation: {
            signature: `gate:${next.gateOrigin ?? ""}/${next.terminalOrigin ?? ""}->${next.gateDestination ?? ""}/${next.terminalDestination ?? ""}`,
            metric: 1,
          },
        });
      }
    }
  }

  return changes;
}

/**
 * Worsening (§6.2: a dismissed advisory re-fires only if the situation
 * worsens). Compared within a kind against the situation the last
 * advisory for that flight + kind fired for.
 */
export function isWorseThan(
  kind: AdvisoryKind,
  previous: AdvisorySituation,
  next: AdvisorySituation,
): boolean {
  switch (kind) {
    case "arrival_delay":
    case "schedule_change":
      return next.metric > previous.metric;
    case "gate_change":
      // A *different* gate/terminal assignment is a new situation; the
      // same one re-delivered was already deduped at the snapshot layer.
      return next.signature !== previous.signature;
    case "cancellation":
    case "diversion":
      // Terminal states — once reported, they cannot get "more cancelled".
      return false;
  }
}

// ─── Impact walk (§6.2 / §4.2.3: walk forward from the changed leg) ──────────

export interface OnwardFlight {
  flightId: number;
  label: string;
  departureAirport: string;
  /** Departure instant (ms) — computed by the service from the legacy
   * row's wall-clock time + airport zone. */
  departureMs: number;
}

export interface ImpactWalkInput {
  changedLeg: {
    flightId: number;
    label: string;
    arrivalAirport: string;
    arrivalTimezone: string | null;
    /** Booked scheduled arrival instant (ms). */
    scheduledArrivalMs: number;
    /** New best arrival instant (ms): actual ?? estimated ?? scheduled. */
    estimatedArrivalMs: number | null;
    cancelled: boolean;
  };
  timelineEvents: TimelineEvent[];
  onwardFlights: OnwardFlight[];
  participantCount: number;
  config?: WatchingConfig;
}

/**
 * Walk the trip's timeline forward from the changed leg and name every
 * knock-on effect: onward connections whose slack fell below the
 * minimum, the check-in the new arrival endangers, reservations the
 * traveler now lands after, and — for group trips — the coherence note
 * that this is the whole party's problem, not one traveler's.
 */
export function runImpactWalk(input: ImpactWalkInput): AdvisoryImpact[] {
  const config = input.config ?? WATCHING_CONFIG;
  const { changedLeg } = input;
  const impacts: AdvisoryImpact[] = [];
  const estimatedArrivalMs = changedLeg.estimatedArrivalMs ?? changedLeg.scheduledArrivalMs;
  const arrivalDateKey = dateKeyInZone(estimatedArrivalMs, changedLeg.arrivalTimezone);
  const readyAtMs = estimatedArrivalMs + config.transferMinutes * 60000;

  // Onward connections from the arrival airport.
  for (const onward of input.onwardFlights) {
    if (onward.flightId === changedLeg.flightId) continue;
    if (onward.departureAirport !== changedLeg.arrivalAirport) continue;
    if (onward.departureMs <= changedLeg.scheduledArrivalMs) continue; // wasn't reachable even on time
    if (changedLeg.cancelled) {
      impacts.push({
        type: "connection_missed",
        detail: `${onward.label} from ${onward.departureAirport} can no longer be reached — the inbound flight was cancelled.`,
      });
      continue;
    }
    const slackMinutes = Math.round((onward.departureMs - estimatedArrivalMs) / 60000);
    if (slackMinutes < 0) {
      impacts.push({
        type: "connection_missed",
        detail: `${onward.label} departs ${formatDelay(-slackMinutes)} before the new estimated arrival — this connection will be missed.`,
      });
    } else if (slackMinutes < config.minConnectMinutes) {
      impacts.push({
        type: "connection_risk",
        detail: `${onward.label} now has only ${slackMinutes}m between the new estimated arrival and departure (below the ${config.minConnectMinutes}m minimum we plan around).`,
      });
    }
  }

  if (!changedLeg.cancelled) {
    // Hotel check-in on the arrival day.
    for (const ev of input.timelineEvents) {
      if (ev.type !== "accommodation") continue;
      if (!ev.title.startsWith("Check-in:")) continue;
      if (ev.date !== arrivalDateKey) continue;
      const property = ev.title.replace(/^Check-in:\s*/, "");
      const readyMinutes = minutesOfDayInZone(readyAtMs, changedLeg.arrivalTimezone);
      const readyDateKey = dateKeyInZone(readyAtMs, changedLeg.arrivalTimezone);
      if (readyDateKey !== arrivalDateKey) {
        impacts.push({
          type: "checkin_at_risk",
          detail: `Check-in at ${property} is at risk — with transfer time you would not arrive until after midnight on check-in day. The property should be told to hold the room.`,
        });
      } else if (readyMinutes >= config.lateArrivalHour * 60) {
        impacts.push({
          type: "late_arrival",
          detail: `Late arrival at ${property} — you now reach it around ${formatTimeInZone(new Date(readyAtMs).toISOString(), changedLeg.arrivalTimezone)} after transfer; a late-arrival hold is worth arranging.`,
        });
      }
    }

    // Named reservations / activities on the arrival day that now start
    // before the traveler can realistically be there.
    for (const ev of input.timelineEvents) {
      if (ev.type !== "reservation" && ev.type !== "activity") continue;
      if (ev.date !== arrivalDateKey || !ev.time) continue;
      const [hh, mm] = ev.time.split(":").map(Number);
      if (Number.isNaN(hh) || Number.isNaN(mm)) continue;
      // Timeline times are wall-clock at the venue — the arrival airport's
      // zone is the spike's stated approximation for same-day plans.
      const eventMs = wallClockToUtcMs(`${ev.date}T${ev.time}`, changedLeg.arrivalTimezone);
      if (eventMs < readyAtMs) {
        impacts.push({
          type: "reservation_at_risk",
          detail: `${ev.title} (${ev.time}) is at risk — the new estimated arrival plus transfer time lands after it starts.`,
        });
      }
    }
  }

  // Group coherence (Story 5.4): a slipped leg against shared plans is
  // the party's problem; the organizer's copy names it as such.
  if (input.participantCount > 1 && impacts.length > 0) {
    impacts.push({
      type: "group_coherence",
      detail: `This affects all ${input.participantCount} travelers on the trip — the plans above are shared, so the group should decide together.`,
    });
  }

  return impacts;
}

/** The one-line impact statement every advisory carries (§4.2.4:
 * "no downstream impact" is stated, never left blank). */
export function buildImpactSummary(impacts: AdvisoryImpact[]): string {
  if (impacts.length === 0) {
    return "No downstream impact found on the rest of the itinerary.";
  }
  return impacts.map((i) => i.detail).join(" ");
}

// ─── Notification copy (§4.2.4: plain language, status + impact) ─────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildAdvisoryEmail(input: {
  tripTitle: string;
  changes: DetectedChange[];
  impactSummary: string;
}): { subject: string; text: string; html: string } {
  const first = input.changes[0];
  const subject =
    input.changes.length === 1
      ? `Wander travel update — ${first.summary.replace(/\.$/, "")}`
      : `Wander travel update — ${input.changes.length} changes to your flights`;
  const changeLines = input.changes.map((c) => c.summary);
  const text = [
    `Trip: ${input.tripTitle}`,
    "",
    ...changeLines,
    "",
    input.impactSummary,
    "",
    "Nothing has been rebooked or changed on your behalf — if a fix is needed, open the trip in Wander and you'll see priced options to confirm first.",
    "",
    "— Wander watching",
  ].join("\n");
  const html = [
    `<p><strong>Trip: ${escapeHtml(input.tripTitle)}</strong></p>`,
    ...changeLines.map((l) => `<p>${escapeHtml(l)}</p>`),
    `<p>${escapeHtml(input.impactSummary)}</p>`,
    `<p>Nothing has been rebooked or changed on your behalf — if a fix is needed, open the trip in Wander and you'll see priced options to confirm first.</p>`,
    `<p>— Wander watching</p>`,
  ].join("\n");
  return { subject, text, html };
}
