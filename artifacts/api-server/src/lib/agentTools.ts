/**
 * Marco agent — trip read tools.
 *
 * These mirror the MCP tool conventions (src/mcp/tools.ts): zod input schema,
 * trip access assert first, a structured `[Agent]` log line per call, and a
 * plain `{ ok, text, data? }` result shape. This is the agent loop, NOT the
 * MCP server, so results are plain objects rather than MCP CallToolResult.
 *
 * Tool registration for the model API lives here too: each ToolDefinition
 * pairs a hand-written JSON Schema `parameters` object (kept in sync with the
 * zod schema manually — `zod-to-json-schema` is not installed and new
 * dependencies may not be added) with the zod schema used to validate args at
 * execution time.
 */

import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  tripsTable,
  tripParticipantsTable,
  itineraryDaysTable,
  reservationsTable,
  flightsTable,
  accommodationsTable,
  activitiesTable,
  carRentalsTable,
} from "@workspace/db";
import { buildTimelineEvents, type TimelineEvent } from "./timeline";
import { logger } from "./logger";

// ─── Context & result shapes ──────────────────────────────────────────────────

/** Caller identity, derived from auth — never from tool args. */
export interface ToolContext {
  userId: number;
  role: string;
}

/** Plain result returned to the agent loop (not an MCP CallToolResult). */
export interface AgentToolResult {
  ok: boolean;
  text: string;
  data?: unknown;
}

function toolOk(text: string, data?: unknown): AgentToolResult {
  return { ok: true, text, data };
}

function toolErr(text: string, data?: unknown): AgentToolResult {
  return { ok: false, text, data };
}

// ─── Shared trip access guard (assertTripAccess idiom from src/mcp/tools.ts) ──

class TripAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TripAccessDenied";
  }
}

async function assertTripAccess(userId: number, role: string, tripId: number): Promise<void> {
  if (role === "super_admin") return;

  const [participant] = await db
    .select()
    .from(tripParticipantsTable)
    .where(
      and(
        eq(tripParticipantsTable.tripId, tripId),
        eq(tripParticipantsTable.userId, userId),
      ),
    );

  if (!participant) {
    throw new TripAccessDenied(`You are not a participant of trip ${tripId}.`);
  }
}

// ─── Time helpers for conflict checking ──────────────────────────────────────

/** Parse "HH:MM" (or the time portion of a longer datetime string) to minutes. */
function parseMinutes(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = s.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

// ─── get_trip_summary ─────────────────────────────────────────────────────────

const GetTripSummaryInput = z.object({
  tripId: z.number().int().positive().describe("The trip ID"),
});

// NOTE: `parameters` is hand-written JSON Schema — keep in sync with
// GetTripSummaryInput above. (zod-to-json-schema is not available.)

async function getTripSummary(ctx: ToolContext, args: z.infer<typeof GetTripSummaryInput>): Promise<AgentToolResult> {
  logger.info({ tool: "get_trip_summary", userId: ctx.userId, tripId: args.tripId }, "[Agent] tool call");
  try {
    await assertTripAccess(ctx.userId, ctx.role, args.tripId);

    const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, args.tripId));
    if (!trip) return toolErr(`Trip ${args.tripId} not found.`);

    const [flights, accom, acts, res, itDays, cars, parts] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(flightsTable).where(eq(flightsTable.tripId, args.tripId)),
      db.select({ count: sql<number>`count(*)` }).from(accommodationsTable).where(eq(accommodationsTable.tripId, args.tripId)),
      db.select({ count: sql<number>`count(*)` }).from(activitiesTable).where(eq(activitiesTable.tripId, args.tripId)),
      db.select({ count: sql<number>`count(*)` }).from(reservationsTable).where(eq(reservationsTable.tripId, args.tripId)),
      db.select({ count: sql<number>`count(*)` }).from(itineraryDaysTable).where(eq(itineraryDaysTable.tripId, args.tripId)),
      db.select({ count: sql<number>`count(*)` }).from(carRentalsTable).where(eq(carRentalsTable.tripId, args.tripId)),
      db.select({ count: sql<number>`count(*)` }).from(tripParticipantsTable).where(eq(tripParticipantsTable.tripId, args.tripId)),
    ]);
    const n = (r: Array<{ count: number | string }>) => Number(r[0]?.count ?? 0);
    const counts = {
      participants: n(parts),
      itineraryDays: n(itDays),
      flights: n(flights),
      accommodations: n(accom),
      activities: n(acts),
      reservations: n(res),
      carRentals: n(cars),
    };

    const start = new Date(trip.startDate);
    const end = new Date(trip.endDate);
    const daysCount = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1);

    const text = [
      `Trip: ${trip.title}`,
      `Destination: ${trip.destination}`,
      `Dates: ${trip.startDate} – ${trip.endDate} (${daysCount} days)`,
      `Status: ${trip.status}`,
      trip.description ? `Description: ${trip.description}` : null,
      `Participants: ${counts.participants}`,
      `Flights: ${counts.flights} | Stays: ${counts.accommodations} | Activities: ${counts.activities} | Reservations: ${counts.reservations} | Car rentals: ${counts.carRentals} | Itinerary days: ${counts.itineraryDays}`,
    ]
      .filter(Boolean)
      .join("\n");

    logger.info({ tool: "get_trip_summary", userId: ctx.userId, tripId: args.tripId, outcome: "ok" }, "[Agent] tool success");
    return toolOk(text, {
      tripId: trip.id,
      title: trip.title,
      destination: trip.destination,
      startDate: trip.startDate,
      endDate: trip.endDate,
      daysCount,
      status: trip.status,
      description: trip.description ?? null,
      counts,
    });
  } catch (err) {
    if (err instanceof TripAccessDenied) return toolErr(err.message);
    logger.error({ tool: "get_trip_summary", userId: ctx.userId, tripId: args.tripId, err }, "[Agent] tool error");
    return toolErr("An internal error occurred while loading the trip summary.");
  }
}

// ─── get_itinerary ────────────────────────────────────────────────────────────

const GetItineraryInput = z.object({
  tripId: z.number().int().positive().describe("The trip ID"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD, e.g. 2026-09-26")
    .optional()
    .describe("Filter to a specific date (YYYY-MM-DD)"),
});

// NOTE: `parameters` is hand-written JSON Schema — keep in sync with
// GetItineraryInput above.

function formatEvent(e: TimelineEvent): string {
  const parts = [`${e.date}${e.time ? " " + e.time : ""}`, `[${e.type}]`, e.title];
  if (e.location) parts.push(`@ ${e.location}`);
  if (e.confirmationCode) parts.push(`(conf ${e.confirmationCode})`);
  if (e.description) parts.push(`— ${e.description.slice(0, 140)}`);
  return parts.join(" ");
}

async function getItinerary(ctx: ToolContext, args: z.infer<typeof GetItineraryInput>): Promise<AgentToolResult> {
  logger.info({ tool: "get_itinerary", userId: ctx.userId, tripId: args.tripId, date: args.date }, "[Agent] tool call");
  try {
    await assertTripAccess(ctx.userId, ctx.role, args.tripId);

    const events = await buildTimelineEvents(args.tripId);
    const filtered = args.date ? events.filter((e) => e.date === args.date) : events;

    const text =
      filtered.length === 0
        ? args.date
          ? `No itinerary events on ${args.date}.`
          : `No itinerary events for trip ${args.tripId}.`
        : `${filtered.length} event(s):\n` + filtered.map(formatEvent).join("\n");

    logger.info({ tool: "get_itinerary", userId: ctx.userId, tripId: args.tripId, eventCount: filtered.length, outcome: "ok" }, "[Agent] tool success");
    return toolOk(text, { tripId: args.tripId, date: args.date ?? null, events: filtered });
  } catch (err) {
    if (err instanceof TripAccessDenied) return toolErr(err.message);
    logger.error({ tool: "get_itinerary", userId: ctx.userId, tripId: args.tripId, err }, "[Agent] tool error");
    return toolErr("An internal error occurred while loading the itinerary.");
  }
}

// ─── get_reservations ─────────────────────────────────────────────────────────

const RESERVATION_TYPES = ["restaurant", "attraction", "tour", "transport", "event", "spa", "other"] as const;

const GetReservationsInput = z.object({
  tripId: z.number().int().positive().describe("The trip ID"),
  type: z
    .enum(RESERVATION_TYPES)
    .optional()
    .describe("Filter by reservation type"),
});

// NOTE: `parameters` is hand-written JSON Schema — keep in sync with
// GetReservationsInput above.

async function getReservations(ctx: ToolContext, args: z.infer<typeof GetReservationsInput>): Promise<AgentToolResult> {
  logger.info({ tool: "get_reservations", userId: ctx.userId, tripId: args.tripId, type: args.type }, "[Agent] tool call");
  try {
    await assertTripAccess(ctx.userId, ctx.role, args.tripId);

    const rows = await db
      .select()
      .from(reservationsTable)
      .where(
        args.type
          ? and(eq(reservationsTable.tripId, args.tripId), eq(reservationsTable.type, args.type))
          : eq(reservationsTable.tripId, args.tripId),
      );

    rows.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.time ?? "00:00").localeCompare(b.time ?? "00:00");
    });

    const items = rows.map((r) => ({
      id: r.id,
      type: r.type,
      title: r.title,
      venue: r.venue ?? null,
      address: r.address ?? null,
      date: r.date,
      time: r.time ?? null,
      endTime: r.endTime ?? null,
      confirmationCode: r.confirmationCode ?? null,
      numberOfPeople: r.numberOfPeople ?? null,
      notes: r.notes ?? null,
    }));

    const text =
      items.length === 0
        ? `No reservations${args.type ? ` of type "${args.type}"` : ""} for trip ${args.tripId}.`
        : `${items.length} reservation(s):\n` +
          items
            .map(
              (r) =>
                `• ${r.date}${r.time ? " " + r.time : ""} [${r.type}] ${r.title}` +
                (r.venue ? ` at ${r.venue}` : "") +
                (r.address ? ` (${r.address})` : "") +
                (r.confirmationCode ? ` — conf ${r.confirmationCode}` : "") +
                (r.numberOfPeople ? ` — party of ${r.numberOfPeople}` : ""),
            )
            .join("\n");

    logger.info({ tool: "get_reservations", userId: ctx.userId, tripId: args.tripId, count: items.length, outcome: "ok" }, "[Agent] tool success");
    return toolOk(text, { tripId: args.tripId, type: args.type ?? null, reservations: items });
  } catch (err) {
    if (err instanceof TripAccessDenied) return toolErr(err.message);
    logger.error({ tool: "get_reservations", userId: ctx.userId, tripId: args.tripId, err }, "[Agent] tool error");
    return toolErr("An internal error occurred while loading reservations.");
  }
}

// ─── get_flights ──────────────────────────────────────────────────────────────

const GetFlightsInput = z.object({
  tripId: z.number().int().positive().describe("The trip ID"),
});

// NOTE: `parameters` is hand-written JSON Schema — keep in sync with
// GetFlightsInput above.

async function getFlights(ctx: ToolContext, args: z.infer<typeof GetFlightsInput>): Promise<AgentToolResult> {
  logger.info({ tool: "get_flights", userId: ctx.userId, tripId: args.tripId }, "[Agent] tool call");
  try {
    await assertTripAccess(ctx.userId, ctx.role, args.tripId);

    const rows = await db.select().from(flightsTable).where(eq(flightsTable.tripId, args.tripId));
    rows.sort((a, b) => a.departureDatetime.localeCompare(b.departureDatetime));

    const items = rows.map((f) => ({
      id: f.id,
      airline: f.airline,
      flightNumber: f.flightNumber,
      from: f.departureAirport,
      to: f.arrivalAirport,
      departure: f.departureDatetime,
      arrival: f.arrivalDatetime,
      confirmationCode: f.confirmationCode ?? null,
      notes: f.notes ?? null,
    }));

    const text =
      items.length === 0
        ? `No flights for trip ${args.tripId}.`
        : `${items.length} flight(s):\n` +
          items
            .map(
              (f) =>
                `• ${f.airline} ${f.flightNumber}: ${f.from} → ${f.to}` +
                ` — dep ${f.departure}, arr ${f.arrival}` +
                (f.confirmationCode ? ` — conf ${f.confirmationCode}` : ""),
            )
            .join("\n");

    logger.info({ tool: "get_flights", userId: ctx.userId, tripId: args.tripId, count: items.length, outcome: "ok" }, "[Agent] tool success");
    return toolOk(text, { tripId: args.tripId, flights: items });
  } catch (err) {
    if (err instanceof TripAccessDenied) return toolErr(err.message);
    logger.error({ tool: "get_flights", userId: ctx.userId, tripId: args.tripId, err }, "[Agent] tool error");
    return toolErr("An internal error occurred while loading flights.");
  }
}

// ─── get_stays ────────────────────────────────────────────────────────────────

const GetStaysInput = z.object({
  tripId: z.number().int().positive().describe("The trip ID"),
});

// NOTE: `parameters` is hand-written JSON Schema — keep in sync with
// GetStaysInput above.

async function getStays(ctx: ToolContext, args: z.infer<typeof GetStaysInput>): Promise<AgentToolResult> {
  logger.info({ tool: "get_stays", userId: ctx.userId, tripId: args.tripId }, "[Agent] tool call");
  try {
    await assertTripAccess(ctx.userId, ctx.role, args.tripId);

    const rows = await db.select().from(accommodationsTable).where(eq(accommodationsTable.tripId, args.tripId));
    rows.sort((a, b) => a.checkIn.localeCompare(b.checkIn));

    const items = rows.map((a) => ({
      id: a.id,
      name: a.name,
      address: a.address ?? null,
      checkIn: a.checkIn,
      checkOut: a.checkOut,
      confirmationCode: a.confirmationCode ?? null,
      notes: a.notes ?? null,
    }));

    const text =
      items.length === 0
        ? `No accommodations for trip ${args.tripId}.`
        : `${items.length} stay(s):\n` +
          items
            .map(
              (a) =>
                `• ${a.name}` +
                (a.address ? ` — ${a.address}` : "") +
                ` — check-in ${a.checkIn}, check-out ${a.checkOut}` +
                (a.confirmationCode ? ` — conf ${a.confirmationCode}` : ""),
            )
            .join("\n");

    logger.info({ tool: "get_stays", userId: ctx.userId, tripId: args.tripId, count: items.length, outcome: "ok" }, "[Agent] tool success");
    return toolOk(text, { tripId: args.tripId, stays: items });
  } catch (err) {
    if (err instanceof TripAccessDenied) return toolErr(err.message);
    logger.error({ tool: "get_stays", userId: ctx.userId, tripId: args.tripId, err }, "[Agent] tool error");
    return toolErr("An internal error occurred while loading accommodations.");
  }
}

// ─── get_activities ───────────────────────────────────────────────────────────

const GetActivitiesInput = z.object({
  tripId: z.number().int().positive().describe("The trip ID"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD, e.g. 2026-09-26")
    .optional()
    .describe("Filter to a specific date (YYYY-MM-DD)"),
});

// NOTE: `parameters` is hand-written JSON Schema — keep in sync with
// GetActivitiesInput above.

async function getActivities(ctx: ToolContext, args: z.infer<typeof GetActivitiesInput>): Promise<AgentToolResult> {
  logger.info({ tool: "get_activities", userId: ctx.userId, tripId: args.tripId, date: args.date }, "[Agent] tool call");
  try {
    await assertTripAccess(ctx.userId, ctx.role, args.tripId);

    const rows = await db.select().from(activitiesTable).where(eq(activitiesTable.tripId, args.tripId));
    const filtered = args.date ? rows.filter((a) => a.date === args.date) : rows;
    filtered.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      return (a.time ?? "00:00").localeCompare(b.time ?? "00:00");
    });

    const items = filtered.map((a) => ({
      id: a.id,
      title: a.title,
      date: a.date,
      time: a.time ?? null,
      location: a.location ?? null,
      description: a.description ?? null,
    }));

    const text =
      items.length === 0
        ? `No activities${args.date ? ` on ${args.date}` : ""} for trip ${args.tripId}.`
        : `${items.length} activit${items.length === 1 ? "y" : "ies"}:\n` +
          items
            .map(
              (a) =>
                `• ${a.date}${a.time ? " " + a.time : ""} — ${a.title}` +
                (a.location ? ` @ ${a.location}` : "") +
                (a.description ? ` — ${a.description.slice(0, 140)}` : ""),
            )
            .join("\n");

    logger.info({ tool: "get_activities", userId: ctx.userId, tripId: args.tripId, count: items.length, outcome: "ok" }, "[Agent] tool success");
    return toolOk(text, { tripId: args.tripId, date: args.date ?? null, activities: items });
  } catch (err) {
    if (err instanceof TripAccessDenied) return toolErr(err.message);
    logger.error({ tool: "get_activities", userId: ctx.userId, tripId: args.tripId, err }, "[Agent] tool error");
    return toolErr("An internal error occurred while loading activities.");
  }
}

// ─── check_schedule_conflict ──────────────────────────────────────────────────

const CheckScheduleConflictInput = z.object({
  tripId: z.number().int().positive().describe("The trip ID"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD, e.g. 2026-09-26")
    .describe("The proposed date (YYYY-MM-DD)"),
  startTime: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .describe('Proposed start time, 24h "HH:MM" (e.g. "19:30")'),
  endTime: z
    .string()
    .regex(/^\d{1,2}:\d{2}$/)
    .describe('Proposed end time, 24h "HH:MM" (e.g. "21:00")'),
  title: z.string().max(200).optional().describe("Short label for the proposed item"),
});

// NOTE: `parameters` is hand-written JSON Schema — keep in sync with
// CheckScheduleConflictInput above.

async function checkScheduleConflict(
  ctx: ToolContext,
  args: z.infer<typeof CheckScheduleConflictInput>,
): Promise<AgentToolResult> {
  logger.info(
    { tool: "check_schedule_conflict", userId: ctx.userId, tripId: args.tripId, date: args.date, startTime: args.startTime, endTime: args.endTime },
    "[Agent] tool call",
  );
  try {
    await assertTripAccess(ctx.userId, ctx.role, args.tripId);

    const proposedStart = parseMinutes(args.startTime);
    const proposedEnd = parseMinutes(args.endTime);
    if (proposedStart === null || proposedEnd === null || proposedEnd <= proposedStart) {
      return toolErr("Invalid proposed window: startTime must be before endTime (24h HH:MM).");
    }

    const events = (await buildTimelineEvents(args.tripId)).filter((e) => e.date === args.date);
    const overlapping: string[] = [];

    for (const e of events) {
      let s: number | null = null;
      let eEnd: number | null = null;
      let note = "";

      if (e.type === "itinerary") {
        // TimelineEvent never carries a time for itinerary days, so a plain
        // itinerary-day block is an all-day flag unless the day has no other
        // items — here we treat the day-level block as all-day overlap.
        s = 0;
        eEnd = 24 * 60;
        note = " (itinerary day — all-day plan)";
      } else if (e.type === "reservation") {
        s = parseMinutes(e.time);
        // reservations have endTime in the DB but TimelineEvent doesn't carry it;
        // fall back to a 90-minute assumed block.
        if (s !== null) {
          eEnd = s + 90;
          note = " (assumed 90min duration)";
        }
      } else if (e.type === "activity") {
        s = parseMinutes(e.time);
        if (s !== null) {
          eEnd = s + 60;
          note = " (assumed 1h duration)";
        }
      } else if (e.type === "flight") {
        // Flights are points in time here: block 90 min around departure so a
        // proposed window containing the departure flags as a conflict.
        s = parseMinutes(e.time);
        if (s !== null) {
          s = s - 60;
          eEnd = s + 150;
          note = " (60min before – 90min after departure)";
        }
      } else if (e.type === "accommodation") {
        // Check-in/check-out days are all-day travel logistics.
        s = 0;
        eEnd = 24 * 60;
        note = " (all-day travel logistics)";
      } else if (e.type === "car_rental") {
        s = parseMinutes(e.time);
        if (s !== null) {
          s = s - 30;
          eEnd = s + 90;
          note = " (30min before – 60min after pickup)";
        }
      }

      if (s === null || eEnd === null) {
        overlapping.push(`• ${formatEvent(e)} — ⚠ no time on this item, treating as ALL-DAY overlap`);
      } else if (overlaps(proposedStart, proposedEnd, s, eEnd)) {
        overlapping.push(`• ${formatEvent(e)}${note}`);
      }
    }

    const label = args.title ? `"${args.title}" on` : "The proposed window on";
    const text =
      overlapping.length === 0
        ? `No conflicts: ${label} ${args.date} ${args.startTime}–${args.endTime} is clear.`
        : `⚠ ${overlapping.length} overlapping item(s) with ${label} ${args.date} ${args.startTime}–${args.endTime}:\n` +
          overlapping.join("\n");

    logger.info(
      { tool: "check_schedule_conflict", userId: ctx.userId, tripId: args.tripId, conflictCount: overlapping.length, outcome: "ok" },
      "[Agent] tool success",
    );
    return toolOk(text, { tripId: args.tripId, date: args.date, startTime: args.startTime, endTime: args.endTime, conflicts: overlapping });
  } catch (err) {
    if (err instanceof TripAccessDenied) return toolErr(err.message);
    logger.error({ tool: "check_schedule_conflict", userId: ctx.userId, tripId: args.tripId, err }, "[Agent] tool error");
    return toolErr("An internal error occurred while checking for conflicts.");
  }
}

// ─── Tool registration table ──────────────────────────────────────────────────

export interface ToolDefinition {
  /** Function name exposed to the model via the chat completions `tools` array. */
  name: string;
  /** What the model sees — drives when it reaches for the tool. */
  description: string;
  /**
   * Hand-written JSON Schema for the tool's arguments (OpenAI function-calling
   * format). Keep in sync with `input` manually — see note above.
   */
  parameters: Record<string, unknown>;
  /** Zod schema used to validate args at execution time. */
  input: z.ZodTypeAny;
  run: (ctx: ToolContext, args: never) => Promise<AgentToolResult>;
}

const positiveIntTripIdParam = {
  type: "object",
  properties: {
    tripId: { type: "integer", minimum: 1, description: "The trip ID" },
  },
  required: ["tripId"],
  additionalProperties: false,
} as const;

const optionalDateParam = {
  date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Filter to a specific date as YYYY-MM-DD (e.g. 2026-09-26)" },
} as const;

/**
 * All trip read tools available to the agent loop. The route serializes
 * {name, description, parameters} into the model API `tools` array and
 * dispatches by name at execution time.
 */
export const AGENT_TOOLS: ToolDefinition[] = [
  {
    name: "get_trip_summary",
    description:
      "Get the basics of a trip: title, destination, dates, status, and counts " +
      "of participants, flights, stays, activities, reservations, car rentals, and itinerary days. " +
      "Start here when you need an overview of what the trip looks like.",
    parameters: {
      type: "object",
      properties: {
        tripId: { type: "integer", minimum: 1, description: "The trip ID" },
      },
      required: ["tripId"],
      additionalProperties: false,
    },
    input: GetTripSummaryInput,
    run: getTripSummary as ToolDefinition["run"],
  },
  {
    name: "get_itinerary",
    description:
      "Get the merged, chronologically sorted timeline for a trip: itinerary days, " +
      "flights, stays (check-in/out), activities, car rentals, and reservations — " +
      "optionally filtered to one date. Use this for any question about what is " +
      "planned, when things happen, or in what order. Includes confirmation codes.",
    parameters: {
      type: "object",
      properties: {
        tripId: positiveIntTripIdParam.properties.tripId,
        ...{ date: optionalDateParam.date },
      },
      required: ["tripId"],
      additionalProperties: false,
    },
    input: GetItineraryInput,
    run: getItinerary as ToolDefinition["run"],
  },
  {
    name: "get_reservations",
    description:
      "List reservations (restaurant, attraction, tour, transport, event, spa, other) " +
      "for a trip, optionally filtered by type. Use this for restaurant bookings, " +
      "tours, tickets, and any question about reserved times or confirmation codes.",
    parameters: {
      type: "object",
      properties: {
        tripId: positiveIntTripIdParam.properties.tripId,
        type: {
          type: "string",
          enum: [...RESERVATION_TYPES],
          description: "Filter by reservation type",
        },
      },
      required: ["tripId"],
      additionalProperties: false,
    },
    input: GetReservationsInput,
    run: getReservations as ToolDefinition["run"],
  },
  {
    name: "get_flights",
    description:
      "List flights for a trip: airline, flight number, airports, departure and " +
      "arrival times, and confirmation codes. Use for any question about flights.",
    parameters: {
      type: "object",
      properties: {
        tripId: positiveIntTripIdParam.properties.tripId,
      },
      required: ["tripId"],
      additionalProperties: false,
    },
    input: GetFlightsInput,
    run: getFlights as ToolDefinition["run"],
  },
  {
    name: "get_stays",
    description:
      "List accommodations for a trip: name, address, check-in/check-out dates, " +
      "and confirmation codes. Use for any question about hotels or stays.",
    parameters: {
      type: "object",
      properties: {
        tripId: positiveIntTripIdParam.properties.tripId,
      },
      required: ["tripId"],
      additionalProperties: false,
    },
    input: GetStaysInput,
    run: getStays as ToolDefinition["run"],
  },
  {
    name: "get_activities",
    description:
      "List activities for a trip, optionally filtered to one date. Use for " +
      "questions about tours, excursions, or planned things to do.",
    parameters: {
      type: "object",
      properties: {
        tripId: positiveIntTripIdParam.properties.tripId,
        ...{ date: optionalDateParam.date },
      },
      required: ["tripId"],
      additionalProperties: false,
    },
    input: GetActivitiesInput,
    run: getActivities as ToolDefinition["run"],
  },
  {
    name: "check_schedule_conflict",
    description:
      "Check whether a proposed time window overlaps with anything already " +
      "planned on that date (itinerary days, reservations, flights, activities, " +
      "stays, car rentals). Pass date as YYYY-MM-DD and times as 24h HH:MM. " +
      "Items without times are treated as all-day overlaps and flagged as such. " +
      "Use before suggesting a new plan or confirming something fits the schedule.",
    parameters: {
      type: "object",
      properties: {
        tripId: positiveIntTripIdParam.properties.tripId,
        date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "The proposed date as YYYY-MM-DD (e.g. 2026-09-26)" },
        startTime: { type: "string", pattern: "^\\d{1,2}:\\d{2}$", description: 'Proposed start time, 24h "HH:MM"' },
        endTime: { type: "string", pattern: "^\\d{1,2}:\\d{2}$", description: 'Proposed end time, 24h "HH:MM"' },
        title: { type: "string", description: "Short label for the proposed item" },
      },
      required: ["tripId", "date", "startTime", "endTime"],
      additionalProperties: false,
    },
    input: CheckScheduleConflictInput,
    run: checkScheduleConflict as ToolDefinition["run"],
  },
];

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return AGENT_TOOLS.find((t) => t.name === name);
}
