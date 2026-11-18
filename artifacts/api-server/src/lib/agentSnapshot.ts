/**
 * Marco agent — server-side trip snapshot.
 *
 * Loads the trip's core tables in one parallel batch (modeled on
 * buildTimelineEvents in src/lib/timeline.ts) and serializes a LEAN context
 * block: trip basics + per-table counts + the next few upcoming timeline
 * items. Full detail comes via the agent tools; the snapshot just orients
 * the model. Capped at ~4000 chars.
 */

import { eq } from "drizzle-orm";
import {
  db,
  tripsTable,
  usersTable,
  itineraryDaysTable,
  reservationsTable,
  flightsTable,
  accommodationsTable,
  activitiesTable,
  carRentalsTable,
} from "@workspace/db";
import { buildTimelineEvents } from "./timeline";
import type { IntakeSessionView } from "./intake";

const SNAPSHOT_MAX_CHARS = 4000;

export interface TripSnapshot {
  tripId: number;
  title: string;
  destination: string;
  startDate: string;
  endDate: string;
  status: string;
  counts: {
    itineraryDays: number;
    reservations: number;
    flights: number;
    accommodations: number;
    activities: number;
    carRentals: number;
  };
  /** Next few upcoming timeline items, one line each. */
  upcoming: string[];
}

export async function loadTripSnapshot(tripId: number): Promise<TripSnapshot> {
  const [
    tripRows,
    itineraryDays,
    reservations,
    flights,
    accommodations,
    activities,
    carRentals,
  ] = await Promise.all([
    db.select().from(tripsTable).where(eq(tripsTable.id, tripId)),
    db.select().from(itineraryDaysTable).where(eq(itineraryDaysTable.tripId, tripId)),
    db.select().from(reservationsTable).where(eq(reservationsTable.tripId, tripId)),
    db.select().from(flightsTable).where(eq(flightsTable.tripId, tripId)),
    db.select().from(accommodationsTable).where(eq(accommodationsTable.tripId, tripId)),
    db.select().from(activitiesTable).where(eq(activitiesTable.tripId, tripId)),
    db.select().from(carRentalsTable).where(eq(carRentalsTable.tripId, tripId)),
  ]);

  const trip = tripRows[0];
  if (!trip) {
    throw new Error(`Trip ${tripId} not found`);
  }

  // buildTimelineEvents re-queries the same tables (not the rows above) — it
  // does its own batched Promise.all, and reuse keeps the merge/sort logic in
  // exactly one place. One extra round of cheap indexed selects is fine.
  const events = await buildTimelineEvents(tripId);
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = events
    .filter((e) => e.date >= today)
    .slice(0, 6)
    .map(
      (e) =>
        `${e.date}${e.time ? " " + e.time : ""} [${e.type}] ${e.title}` +
        (e.location ? ` @ ${e.location}` : ""),
    );

  return {
    tripId: trip.id,
    title: trip.title,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    status: trip.status,
    counts: {
      itineraryDays: itineraryDays.length,
      reservations: reservations.length,
      flights: flights.length,
      accommodations: accommodations.length,
      activities: activities.length,
      carRentals: carRentals.length,
    },
    upcoming,
  };
}

/** Render the snapshot as a system ChatMessage for the model API. */

/** "2026-09-26" -> "Sat" / "Saturday". Noon UTC avoids any TZ day-shift. */
function weekday(isoDate: string, style: "short" | "long"): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: style,
    timeZone: "UTC",
  });
}

export function buildSnapshotSystemMessage(snapshot: TripSnapshot): { role: "system"; content: string } {
  const c = snapshot.counts;
  const todayIso = new Date().toISOString().slice(0, 10);
  const body = [
    `Today is ${weekday(todayIso, "long")} (${todayIso}).`,
    `Trip: ${snapshot.title} (ID ${snapshot.tripId} — pass this as tripId in every tool call)`,
    `Destination: ${snapshot.destination}`,
    `Dates: ${weekday(snapshot.startDate, "short")} ${snapshot.startDate} – ` +
      `${weekday(snapshot.endDate, "short")} ${snapshot.endDate} (status: ${snapshot.status})`,
    `On file: ${c.itineraryDays} itinerary day(s), ${c.reservations} reservation(s), ` +
      `${c.flights} flight(s), ${c.accommodations} stay(s), ${c.activities} activit${c.activities === 1 ? "y" : "ies"}, ` +
      `${c.carRentals} car rental(s).`,
    snapshot.upcoming.length > 0
      ? `Next upcoming items:\n${snapshot.upcoming.map((u) => `  ${u}`).join("\n")}`
      : "No upcoming timeline items.",
    "Full detail is available via your tools — query them for times, confirmation codes, and the full itinerary.",
  ].join("\n");

  const content = (
    "Current trip context (server-loaded; do not invent anything beyond it).\n" +
    body
  ).slice(0, SNAPSHOT_MAX_CHARS);

  return { role: "system", content };
}

// ─── Planner snapshot (intake scope — architecture §2.3/§4.3) ────────────────

export interface PlannerSnapshot {
  userId: number;
  userName: string;
  locale: string | null;
  homeCurrency: string | null;
  timezone: string | null;
  conversationLanguage: string | null;
}

/**
 * The trip snapshot's mirror image: orients Marco on the TRAVELER and on
 * the intake machine's state when no trip exists yet. Same ~4000-char cap
 * discipline. Contains no vault data and no other traveler's data (§4.3).
 */
export async function loadPlannerSnapshot(userId: number): Promise<PlannerSnapshot> {
  const [user] = await db
    .select({
      id: usersTable.id,
      name: usersTable.name,
      locale: usersTable.locale,
      homeCurrency: usersTable.homeCurrency,
      timezone: usersTable.timezone,
      conversationLanguage: usersTable.conversationLanguage,
    })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return {
    userId,
    userName: user?.name ?? "Traveler",
    locale: user?.locale ?? null,
    homeCurrency: user?.homeCurrency ?? null,
    timezone: user?.timezone ?? null,
    conversationLanguage: user?.conversationLanguage ?? null,
  };
}

export function buildPlannerSystemMessage(
  planner: PlannerSnapshot,
  view: IntakeSessionView,
): { role: "system"; content: string } {
  const todayIso = new Date().toISOString().slice(0, 10);
  const profileBits = [
    planner.locale ? `locale ${planner.locale}` : null,
    planner.homeCurrency ? `home currency ${planner.homeCurrency}` : null,
    planner.timezone ? `timezone ${planner.timezone}` : null,
    planner.conversationLanguage ? `conversation language ${planner.conversationLanguage}` : null,
  ].filter(Boolean);

  const body = [
    `Today is ${weekday(todayIso, "long")} (${todayIso}).`,
    `Traveler: ${planner.userName}${profileBits.length > 0 ? ` (${profileBits.join(", ")})` : ""}.`,
    "",
    "You are running a PLANNER INTAKE conversation. No trip exists yet in this conversation, " +
      "and trip tools are unavailable — use only the intake_* tools. You are a human-style travel " +
      "planner, not a form: converse warmly, ask ONE question at a time, and confirm each answer " +
      "back in natural language as you go.",
    "",
    `Intake state: ${view.state}`,
    "Intake so far:",
    ...view.reviewSummary.map((l) => `  ${l}`),
    view.nextAsk
      ? `NEXT ASK — ask exactly this one question next, in your own warm wording but with this meaning: "${view.nextAsk.question}"`
      : "NEXT ASK — none: the trip has been created; continue as a normal trip-planning conversation.",
    "",
    "Intake rules:",
    "- Record every answer with the matching intake_* tool BEFORE replying, so the state machine stays the source of truth.",
    "- Provenance: 'stated' when the traveler volunteers a value unprompted (including inside their opening intent message), " +
      "'asked' when it answers your current question, 'from_context' only for values this snapshot itself states as known.",
    "- If the traveler gives you a later piece of information early (dates while you asked about the party), record it too — then return to the NEXT ASK.",
    "- Corrections are slot writes: call the matching intake_set_* tool with the full corrected value. Never restart the intake.",
    "- If the traveler declines a question ('not sure yet'), call intake_skip for it and move on — never block.",
    "- At REVIEW, read back the intake_get_review summary, and call intake_confirm only after the traveler explicitly confirms.",
  ].join("\n");

  const content = (
    "Planner intake context (server-loaded; do not invent anything beyond it).\n" +
    body
  ).slice(0, SNAPSHOT_MAX_CHARS);

  return { role: "system", content };
}
