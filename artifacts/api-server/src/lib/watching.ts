/**
 * Watching / advisory pipeline — service layer (architecture-north-star
 * §6.2). A thin DB shell over the pure logic in watchingLogic.ts:
 *
 *   MATCH → DEDUPE → MATERIALITY → IMPACT WALK → ADVISORY → NOTIFY
 *
 * Sources feeding the one core (`ingestFlightStatus`): FlightAware
 * alert pushes (webhook, real-time/event-driven) and the single T-24h
 * batch lookup per leg (§8.3.1). Nothing polls. An advisory never
 * books, moves, or charges anything — fixes surface later as priced
 * proposals through the Booking Gate; the advisory stores only the
 * option-set REFERENCE, priced at presentation (§8.3.3).
 *
 * Spike scope: watches key on the LEGACY flights table. When the
 * Booking Ledger lands (January), registration moves to BOOKED and the
 * watch gains a booking id; the pipeline itself does not change.
 */

import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  advisoriesTable,
  flightsTable,
  flightWatchesTable,
  tripsTable,
  tripParticipantsTable,
  usersTable,
  type Advisory,
  type AdvisoryState,
  type Flight,
  type FlightStatusSnapshot,
  type FlightWatch,
  type Trip,
} from "@workspace/db";
import { airportTimeZone, flightEventDate } from "@workspace/flight-time";
import {
  buildFlightIdent,
  flightAwareClientFromEnv,
  normalizeFlightStatus,
  FLIGHTAWARE_DISABLED_REASON,
  type AeroAlertPayload,
  type AeroFlight,
  type FlightAwareClient,
} from "./flightaware.js";
import { buildTimelineEvents } from "./timeline.js";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";
import {
  buildAdvisoryEmail,
  buildImpactSummary,
  detectChanges,
  isWorseThan,
  runImpactWalk,
  snapshotsEqual,
  thresholdsForTraveler,
  wallClockToUtcMs,
  WATCHING_CONFIG,
  type DetectedChange,
  type OnwardFlight,
  type WatchFlightContext,
} from "./watchingLogic.js";

export interface WatchingDeps {
  /** Inject a client (tests); `null` forces disabled; undefined = from env. */
  client?: FlightAwareClient | null;
  /** Per-alert delivery URL override (else FLIGHTAWARE_ALERT_TARGET_URL). */
  targetUrl?: string;
  now?: Date;
}

function resolveClient(deps: WatchingDeps): FlightAwareClient | null {
  return deps.client !== undefined ? deps.client : flightAwareClientFromEnv();
}

function resolveTargetUrl(deps: WatchingDeps): string | undefined {
  return deps.targetUrl ?? process.env.FLIGHTAWARE_ALERT_TARGET_URL;
}

// ─── Watch context from a legacy flight row ──────────────────────────────────

export function departureTimezoneOf(flight: Flight): string | null {
  return flight.departureTimezone ?? airportTimeZone(flight.departureAirport);
}

export function arrivalTimezoneOf(flight: Flight): string | null {
  return flight.arrivalTimezone ?? airportTimeZone(flight.arrivalAirport);
}

export function bookedDepartureMs(flight: Flight): number {
  return wallClockToUtcMs(flight.departureDatetime, departureTimezoneOf(flight));
}

export function bookedArrivalMs(flight: Flight): number {
  return wallClockToUtcMs(flight.arrivalDatetime, arrivalTimezoneOf(flight));
}

export function watchContextFor(flight: Flight): WatchFlightContext {
  return {
    label: flight.flightNumber.replace(/\s+/g, "").toUpperCase(),
    route: `${flight.departureAirport} → ${flight.arrivalAirport}`,
    originTimezone: departureTimezoneOf(flight),
    destinationTimezone: arrivalTimezoneOf(flight),
    bookedDepartureMs: bookedDepartureMs(flight),
    bookedArrivalMs: bookedArrivalMs(flight),
  };
}

// ─── Registration (§6.1: a watch per booked leg) ─────────────────────────────

export type RegisterWatchResult =
  | { created: true; watch: FlightWatch }
  | {
      created: false;
      reason: "flight_not_found" | "trip_completed" | "already_departed" | "ident_unresolved" | "already_registered";
      watch?: FlightWatch;
    };

/**
 * Register (idempotently) a watch for one legacy flight. The local
 * watch row is created even when FlightAware is not configured — it is
 * the dedupe/snapshot store — with `alertId` left null and the gap
 * logged plainly; alert registration is attempted only with a client.
 */
export async function registerWatchForFlight(
  flightId: number,
  deps: WatchingDeps = {},
): Promise<RegisterWatchResult> {
  const now = deps.now ?? new Date();
  const [flight] = await db.select().from(flightsTable).where(eq(flightsTable.id, flightId));
  if (!flight) return { created: false, reason: "flight_not_found" };

  const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, flight.tripId));
  if (trip && trip.status === "completed") return { created: false, reason: "trip_completed" };
  if (bookedDepartureMs(flight) < now.getTime()) return { created: false, reason: "already_departed" };

  const [existing] = await db
    .select()
    .from(flightWatchesTable)
    .where(eq(flightWatchesTable.flightId, flightId));
  if (existing) return { created: false, reason: "already_registered", watch: existing };

  const ident = buildFlightIdent(flight);
  if (!ident) {
    logger.warn(
      { flightId, flightNumber: flight.flightNumber },
      "[Watching] cannot resolve a FlightAware ident for flight; watch not registered",
    );
    return { created: false, reason: "ident_unresolved" };
  }

  const departureDate = flightEventDate(flight.departureDatetime, departureTimezoneOf(flight));
  const [watch] = await db
    .insert(flightWatchesTable)
    .values({
      flightId: flight.id,
      tripId: flight.tripId,
      ident,
      departureDate,
      state: "active",
    })
    .returning();
  if (!watch) throw new Error(`Failed to create flight watch for flight ${flightId}`);

  const client = resolveClient(deps);
  if (!client) {
    logger.info(
      { flightId, ident },
      `[Watching] watch recorded locally only — ${FLIGHTAWARE_DISABLED_REASON}`,
    );
    return { created: true, watch };
  }

  try {
    const start = new Date(`${departureDate}T00:00:00Z`);
    const end = new Date(start.getTime() + 3 * 86_400_000);
    const { alertId } = await client.createAlert({
      ident,
      origin: flight.departureAirport,
      destination: flight.arrivalAirport,
      start: start.toISOString(),
      end: end.toISOString(),
      targetUrl: resolveTargetUrl(deps),
    });
    const [updated] = await db
      .update(flightWatchesTable)
      .set({ alertId, updatedAt: new Date() })
      .where(eq(flightWatchesTable.id, watch.id))
      .returning();
    return { created: true, watch: updated ?? watch };
  } catch (err) {
    // The watch stands locally; a later sync can retry registration.
    logger.error({ err, flightId, ident }, "[Watching] FlightAware alert registration failed");
    return { created: true, watch };
  }
}

/**
 * Registration sweep: every flight on a non-completed trip that has no
 * watch yet gets one. Bounded by unwatched flights — a flight is
 * registered exactly once, ever (§8.4 cost invariant).
 */
export async function syncWatchRegistrations(
  deps: WatchingDeps = {},
): Promise<{ registered: number; skipped: number }> {
  const trips = await db.select().from(tripsTable);
  const openTripIds = new Set(trips.filter((t) => t.status !== "completed").map((t) => t.id));
  const flights = await db.select().from(flightsTable);
  const watches = await db.select().from(flightWatchesTable);
  const watchedFlightIds = new Set(watches.map((w) => w.flightId));

  let registered = 0;
  let skipped = 0;
  for (const flight of flights) {
    if (!openTripIds.has(flight.tripId) || watchedFlightIds.has(flight.id)) continue;
    try {
      const result = await registerWatchForFlight(flight.id, deps);
      if (result.created) registered++;
      else skipped++;
    } catch (err) {
      logger.error({ err, flightId: flight.id }, "[Watching] registration failed for flight");
      skipped++;
    }
  }
  return { registered, skipped };
}

// ─── The pipeline core (§6.2) ────────────────────────────────────────────────

export type IngestOutcome =
  | { outcome: "duplicate" }
  | { outcome: "quiet" }
  | { outcome: "suppressed"; changes: DetectedChange[] }
  | { outcome: "advisory"; advisories: Advisory[]; changes: DetectedChange[] };

async function loadTripParticipants(
  tripId: number,
): Promise<Array<{ userId: number; name: string; email: string; isTripAdmin: boolean }>> {
  const participants = await db
    .select()
    .from(tripParticipantsTable)
    .where(eq(tripParticipantsTable.tripId, tripId));
  const out: Array<{ userId: number; name: string; email: string; isTripAdmin: boolean }> = [];
  for (const p of participants) {
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, p.userId));
    if (user) out.push({ userId: user.id, name: user.name, email: user.email, isTripAdmin: p.isTripAdmin });
  }
  return out;
}

/** The option-set reference stored on an advisory — never priced here. */
function proposalReferenceFor(
  change: DetectedChange,
  flight: Flight,
  watch: FlightWatch,
): Record<string, unknown> | null {
  if (
    change.kind === "cancellation" ||
    change.kind === "diversion" ||
    change.kind === "arrival_delay"
  ) {
    return {
      kind: "rebooking_options",
      origin: flight.departureAirport,
      destination: flight.arrivalAirport,
      date: watch.departureDate,
      ident: watch.ident,
      note: "Option set is priced when the traveler opens this advisory, not at detection (§8.3.3).",
    };
  }
  return null;
}

/**
 * Feed one normalized status into the pipeline for a watch. This is
 * the single path every source uses — pushed alerts and the T-24h
 * lookup alike — so dedupe/materiality/worsening can never diverge
 * between them.
 */
export async function ingestFlightStatus(
  watch: FlightWatch,
  snapshot: FlightStatusSnapshot,
  deps: WatchingDeps = {},
): Promise<IngestOutcome> {
  const now = deps.now ?? new Date();
  const prev = watch.lastStatusSnapshot ?? null;

  // DEDUPE — the same situation re-delivered changes nothing.
  if (snapshotsEqual(prev, snapshot)) {
    await db
      .update(flightWatchesTable)
      .set({ snapshotAt: now, updatedAt: now })
      .where(eq(flightWatchesTable.id, watch.id));
    return { outcome: "duplicate" };
  }

  // The snapshot advances even for sub-threshold movement (§4.2.2:
  // sub-threshold events update the itinerary quietly).
  const [updatedWatch] = await db
    .update(flightWatchesTable)
    .set({
      lastStatusSnapshot: snapshot,
      snapshotAt: now,
      faFlightId: watch.faFlightId ?? snapshot.faFlightId,
      updatedAt: now,
    })
    .where(eq(flightWatchesTable.id, watch.id))
    .returning();
  const currentWatch = updatedWatch ?? { ...watch, lastStatusSnapshot: snapshot };

  const [flight] = await db.select().from(flightsTable).where(eq(flightsTable.id, watch.flightId));
  if (!flight) return { outcome: "quiet" };
  const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, watch.tripId));

  // MATERIALITY — legacy legs belong to the whole party; thresholds
  // resolve through the per-traveler seam (defaults today, §6.1).
  const participants = await loadTripParticipants(watch.tripId);
  const thresholds =
    participants.length > 0
      ? thresholdsForTraveler(participants[0].userId)
      : WATCHING_CONFIG.thresholds;
  const changes = detectChanges({
    prev,
    next: snapshot,
    flight: watchContextFor(flight),
    thresholds,
    now,
  });
  if (changes.length === 0) return { outcome: "quiet" };

  // WORSENING GATE — a situation already advised on (in ANY state,
  // dismissed included) re-fires only if it got worse (§6.2).
  const surviving: DetectedChange[] = [];
  for (const change of changes) {
    const [latest] = await db
      .select()
      .from(advisoriesTable)
      .where(
        and(
          eq(advisoriesTable.flightWatchId, watch.id),
          eq(advisoriesTable.kind, change.kind),
        ),
      )
      .orderBy(desc(advisoriesTable.id))
      .limit(1);
    if (latest && !isWorseThan(change.kind, latest.situation, change.situation)) {
      continue;
    }
    surviving.push(change);
  }
  if (surviving.length === 0) return { outcome: "suppressed", changes };

  // IMPACT WALK — over the trip timeline, forward from the changed leg.
  const timelineEvents = await buildTimelineEvents(watch.tripId);
  const tripFlights = await db
    .select()
    .from(flightsTable)
    .where(eq(flightsTable.tripId, watch.tripId));
  const onwardFlights: OnwardFlight[] = tripFlights.map((f) => ({
    flightId: f.id,
    label: `${f.flightNumber.replace(/\s+/g, "").toUpperCase()} ${f.departureAirport} → ${f.arrivalAirport}`,
    departureAirport: f.departureAirport,
    departureMs: bookedDepartureMs(f),
  }));
  const arrivalIso = snapshot.actualIn ?? snapshot.estimatedIn;
  const parsedArrival = arrivalIso ? Date.parse(arrivalIso) : NaN;
  const estimatedArrivalMs = Number.isNaN(parsedArrival) ? null : parsedArrival;
  const impacts = runImpactWalk({
    changedLeg: {
      flightId: flight.id,
      label: watchContextFor(flight).label,
      arrivalAirport: flight.arrivalAirport,
      arrivalTimezone: arrivalTimezoneOf(flight),
      scheduledArrivalMs: bookedArrivalMs(flight),
      estimatedArrivalMs,
      cancelled: snapshot.cancelled,
    },
    timelineEvents,
    onwardFlights,
    participantCount: participants.length,
  });
  const impactSummary = buildImpactSummary(impacts);

  // ADVISORY records.
  const advisories: Advisory[] = [];
  for (const change of surviving) {
    const [advisory] = await db
      .insert(advisoriesTable)
      .values({
        flightWatchId: watch.id,
        flightId: flight.id,
        tripId: watch.tripId,
        kind: change.kind,
        severity: change.severity,
        summary: change.summary,
        impactSummary,
        impacts,
        situation: change.situation,
        proposalPayload: proposalReferenceFor(change, flight, currentWatch),
        state: "open",
      })
      .returning();
    if (advisory) advisories.push(advisory);
  }

  // NOTIFY — one plain-language email per affected traveler (§4.2.4).
  // The advisory itself changes nothing about the trip.
  if (advisories.length > 0 && participants.length > 0) {
    const email = buildAdvisoryEmail({
      tripTitle: trip?.title ?? "Your trip",
      changes: surviving,
      impactSummary,
    });
    let anySent = false;
    for (const participant of participants) {
      try {
        const result = await sendEmail({ to: participant.email, ...email });
        if (result.sent) anySent = true;
      } catch (err) {
        logger.error(
          { err, tripId: watch.tripId, userId: participant.userId },
          "[Watching] advisory email failed",
        );
      }
    }
    if (anySent) {
      for (const advisory of advisories) {
        await db
          .update(advisoriesTable)
          .set({ notifiedAt: now, updatedAt: now })
          .where(eq(advisoriesTable.id, advisory.id));
      }
    } else {
      logger.warn(
        { tripId: watch.tripId, advisoryIds: advisories.map((a) => a.id) },
        "[Watching] advisories created but no notification was delivered (SMTP not configured?)",
      );
    }
  }

  logger.info(
    {
      watchId: watch.id,
      ident: watch.ident,
      kinds: surviving.map((c) => c.kind),
      impacts: impacts.length,
    },
    "[Watching] advisories issued",
  );
  return { outcome: "advisory", advisories, changes: surviving };
}

// ─── Alert intake (webhook) ──────────────────────────────────────────────────

export type AlertHandleOutcome =
  | { outcome: "invalid_payload" }
  | { outcome: "unmatched" }
  | { outcome: "watch_completed" }
  | IngestOutcome;

/** The origin-local date ("YYYY-MM-DD") of an ISO instant string — the
 * offset in the string is the airport's own, so the date part is local. */
function localDateOfIso(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.substring(0, 10) : null;
}

export function pickAlertFlight(payload: AeroAlertPayload): AeroFlight | null {
  return payload.flight ?? null;
}

/**
 * Match a pushed AeroAPI alert to its watch and run the pipeline.
 * Matching prefers the stable fa_flight_id; falls back to ident +
 * origin-local departure date (an ident is reused across dates).
 */
export async function handleAlertPayload(
  payload: AeroAlertPayload,
  deps: WatchingDeps = {},
): Promise<AlertHandleOutcome> {
  const flight = pickAlertFlight(payload);
  if (!flight || (!flight.ident && !flight.fa_flight_id)) {
    return { outcome: "invalid_payload" };
  }

  let watch: FlightWatch | undefined;
  if (flight.fa_flight_id) {
    const [byFaId] = await db
      .select()
      .from(flightWatchesTable)
      .where(eq(flightWatchesTable.faFlightId, flight.fa_flight_id));
    watch = byFaId;
  }
  if (!watch && flight.ident) {
    const ident = flight.ident.replace(/\s+/g, "").toUpperCase();
    const date = localDateOfIso(flight.scheduled_out);
    const candidates = await db
      .select()
      .from(flightWatchesTable)
      .where(eq(flightWatchesTable.ident, ident));
    watch = date
      ? candidates.find((w) => w.departureDate === date) ?? candidates[0]
      : candidates[0];
  }
  if (!watch) {
    logger.info(
      { ident: flight.ident, faFlightId: flight.fa_flight_id },
      "[Watching] alert received for a flight with no watch — ignored",
    );
    return { outcome: "unmatched" };
  }
  if (watch.state !== "active") return { outcome: "watch_completed" };

  const snapshot = normalizeFlightStatus(flight, "alert", (deps.now ?? new Date()).toISOString());
  return ingestFlightStatus(watch, snapshot, deps);
}

// ─── T-24h pre-departure lookup (§8.3.1: ONE lookup per leg, batch) ─────────

export interface PredepartureSummary {
  considered: number;
  checked: number;
  skipped: number;
  disabled: boolean;
}

/**
 * The pre-departure catch-all: for each active watch departing within
 * the next 24 hours that has not had its lookup yet, exactly ONE status
 * lookup — the row is stamped BEFORE ingesting, so no failure or retry
 * can turn this batch into a polling loop.
 */
export async function runPredepartureCheck(
  deps: WatchingDeps = {},
): Promise<PredepartureSummary> {
  const summary: PredepartureSummary = { considered: 0, checked: 0, skipped: 0, disabled: false };
  const client = resolveClient(deps);
  if (!client) {
    logger.info(`[Watching] T-24h check skipped — ${FLIGHTAWARE_DISABLED_REASON}`);
    summary.disabled = true;
    return summary;
  }
  const now = deps.now ?? new Date();
  const horizon = now.getTime() + 24 * 3_600_000;

  const watches = await db
    .select()
    .from(flightWatchesTable)
    .where(and(eq(flightWatchesTable.state, "active"), isNull(flightWatchesTable.predepartureCheckedAt)));

  for (const watch of watches) {
    try {
      const [flight] = await db.select().from(flightsTable).where(eq(flightsTable.id, watch.flightId));
      if (!flight) {
        summary.skipped++;
        continue;
      }
      const departureMs = bookedDepartureMs(flight);
      if (departureMs < now.getTime() || departureMs > horizon) continue;
      summary.considered++;

      // Stamp first: this watch gets one lookup, whatever happens next.
      await db
        .update(flightWatchesTable)
        .set({ predepartureCheckedAt: now, updatedAt: now })
        .where(eq(flightWatchesTable.id, watch.id));

      let aeroFlight: AeroFlight | null = null;
      if (watch.faFlightId) {
        aeroFlight = await client.getFlightByFaFlightId(watch.faFlightId);
      } else {
        const start = new Date(`${watch.departureDate}T00:00:00Z`);
        const end = new Date(start.getTime() + 2 * 86_400_000);
        const flights = await client.getFlightsByIdent(watch.ident, {
          start: start.toISOString(),
          end: end.toISOString(),
        });
        aeroFlight =
          flights.find(
            (f) =>
              localDateOfIso(f.scheduled_out) === watch.departureDate &&
              (f.origin?.code_iata ?? f.origin?.code) === flight.departureAirport &&
              (f.destination?.code_iata ?? f.destination?.code) === flight.arrivalAirport,
          ) ?? flights[0] ?? null;
      }
      if (!aeroFlight) {
        summary.skipped++;
        continue;
      }
      const snapshot = normalizeFlightStatus(aeroFlight, "lookup", now.toISOString());
      await ingestFlightStatus({ ...watch, predepartureCheckedAt: now }, snapshot, deps);
      summary.checked++;
    } catch (err) {
      logger.error({ err, watchId: watch.id }, "[Watching] T-24h lookup failed for watch");
      summary.skipped++;
    }
  }
  return summary;
}

// ─── Trip completion: deregister + close watches (§8.3.5) ────────────────────

export async function completeWatchesForFinishedTrips(
  deps: WatchingDeps = {},
): Promise<{ completed: number }> {
  const now = deps.now ?? new Date();
  const todayKey = now.toISOString().substring(0, 10);
  const client = resolveClient(deps);

  const watches = await db
    .select()
    .from(flightWatchesTable)
    .where(eq(flightWatchesTable.state, "active"));
  let completed = 0;
  for (const watch of watches) {
    try {
      const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, watch.tripId));
      if (!trip) continue;
      const finished = trip.status === "completed" || trip.endDate < todayKey;
      if (!finished) continue;

      if (watch.alertId && client) {
        try {
          await client.deleteAlert(watch.alertId);
        } catch (err) {
          // The trip is over either way; a stranded provider alert is
          // logged for cleanup, never a reason to keep the watch open.
          logger.error(
            { err, watchId: watch.id, alertId: watch.alertId },
            "[Watching] alert deregistration failed; closing watch locally",
          );
        }
      }
      await db
        .update(flightWatchesTable)
        .set({ state: "completed", updatedAt: now })
        .where(eq(flightWatchesTable.id, watch.id));
      completed++;
    } catch (err) {
      logger.error({ err, watchId: watch.id }, "[Watching] completion sweep failed for watch");
    }
  }
  return { completed };
}

// ─── Advisory state (dismissal is remembered, §6.2) ──────────────────────────

export async function setAdvisoryState(
  advisoryId: number,
  state: AdvisoryState,
): Promise<Advisory | null> {
  const [updated] = await db
    .update(advisoriesTable)
    .set({ state, updatedAt: new Date() })
    .where(eq(advisoriesTable.id, advisoryId))
    .returning();
  return updated ?? null;
}

export async function listAdvisoriesForTrip(tripId: number): Promise<Advisory[]> {
  return db
    .select()
    .from(advisoriesTable)
    .where(eq(advisoriesTable.tripId, tripId))
    .orderBy(desc(advisoriesTable.id));
}
