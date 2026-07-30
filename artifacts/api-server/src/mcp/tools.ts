/**
 * MCP read-only tool implementations.
 *
 * All tools are annotated readOnlyHint:true, destructiveHint:false, openWorldHint:false.
 * All outputs are sanitized — no password hashes, tokens, secrets, or unrelated profile data.
 * Auth is derived from the request; user IDs from tool arguments are NEVER trusted.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { eq, and, sql } from "drizzle-orm";
import {
  db,
  tripsTable,
  tripParticipantsTable,
  usersTable,
  itineraryDaysTable,
  flightsTable,
  accommodationsTable,
  activitiesTable,
  packingItemsTable,
  carRentalsTable,
  tripExpensesTable,
  expenseSplitsTable,
} from "@workspace/db";
import { minimizeDebts } from "../routes/expenses";
import { logger } from "../lib/logger";
import type { McpAuthUser } from "./auth";

// ─── Read-only annotation shared by all tools ─────────────────────────────────
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
} as const;

// ─── Shared trip access guard ─────────────────────────────────────────────────

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
    throw new McpToolError("TRIP_ACCESS_DENIED", `You are not a participant of trip ${tripId}.`);
  }
}

// ─── Typed MCP tool error ─────────────────────────────────────────────────────

class McpToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

/** Build a safe MCP error result (no sensitive data). */
function toolError(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: `[${code}] ${message}` }],
  };
}

/**
 * Build a successful MCP result with both structuredContent (for machine parsing)
 * and a concise text summary (for human/model reading).
 *
 * `structuredContent` is cast to satisfy CallToolResult since the SDK's TypeScript
 * types only include it when an outputSchema is provided, but the MCP protocol
 * itself supports it unconditionally.
 */
function toolOk(structuredContent: Record<string, unknown>, text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    structuredContent,
  } as unknown as CallToolResult;
}

// ─── Register all tools onto an McpServer ────────────────────────────────────

export function registerTools(server: McpServer, auth: McpAuthUser): void {
  const { userId, role } = auth;

  // ── list_my_trips ────────────────────────────────────────────────────────────
  server.tool(
    "list_my_trips",
    "List the trips the authenticated user is authorized to view.",
    {
      status: z
        .enum(["planning", "confirmed", "active", "completed"])
        .optional()
        .describe("Filter by trip status"),
      includePast: z
        .boolean()
        .optional()
        .default(false)
        .describe("Include trips whose end date is in the past"),
    },
    READ_ONLY_ANNOTATIONS,
    async (args) => {
      logger.info({ tool: "list_my_trips", userId, status: args.status }, "[MCP] tool call");
      try {
        let rawTrips: Array<typeof tripsTable.$inferSelect & { isTripAdmin: boolean }>;

        if (role === "super_admin") {
          const rows = await db.select().from(tripsTable).orderBy(tripsTable.startDate);
          rawTrips = rows.map(t => ({ ...t, isTripAdmin: true }));
        } else {
          const rows = await db
            .select({ trip: tripsTable, participant: tripParticipantsTable })
            .from(tripsTable)
            .innerJoin(
              tripParticipantsTable,
              and(
                eq(tripParticipantsTable.tripId, tripsTable.id),
                eq(tripParticipantsTable.userId, userId),
              ),
            )
            .orderBy(tripsTable.startDate);
          rawTrips = rows.map(r => ({ ...r.trip, isTripAdmin: r.participant.isTripAdmin }));
        }

        // Batch participant count query
        const tripIds = rawTrips.map(t => t.id);
        const countMap = new Map<number, number>();
        if (tripIds.length > 0) {
          const counts = await db
            .select({
              tripId: tripParticipantsTable.tripId,
              count: sql<number>`count(*)`,
            })
            .from(tripParticipantsTable)
            .where(
              sql`${tripParticipantsTable.tripId} = ANY(ARRAY[${sql.join(tripIds.map(id => sql`${id}`), sql`, `)}]::int[])`,
            )
            .groupBy(tripParticipantsTable.tripId);
          for (const c of counts) countMap.set(c.tripId, Number(c.count));
        }

        // Apply filters
        const today = new Date().toISOString().slice(0, 10);
        const filtered = rawTrips
          .filter(t => !args.status || t.status === args.status)
          .filter(t => args.includePast || t.endDate >= today);

        const trips = filtered.map(t => ({
          tripId: t.id,
          name: t.title,
          destination: t.destination,
          startDate: t.startDate,
          endDate: t.endDate,
          status: t.status,
          participantCount: countMap.get(t.id) ?? 0,
          isTripAdmin: t.isTripAdmin,
        }));

        const summary =
          trips.length === 0
            ? "No trips found matching the criteria."
            : trips
                .map(t => `• [${t.tripId}] ${t.name} — ${t.destination} (${t.startDate} – ${t.endDate}, ${t.status})`)
                .join("\n");

        logger.info({ tool: "list_my_trips", userId, count: trips.length, outcome: "ok" }, "[MCP] tool success");
        return toolOk({ trips }, `Found ${trips.length} trip(s):\n${summary}`);
      } catch (err) {
        if (err instanceof McpToolError) return toolError(err.code, err.message);
        logger.error({ tool: "list_my_trips", userId, err }, "[MCP] tool error");
        return toolError("SERVER_ERROR", "An internal error occurred.");
      }
    },
  );

  // ── get_trip_overview ────────────────────────────────────────────────────────
  server.tool(
    "get_trip_overview",
    "Get basic information and item counts for a specific trip.",
    {
      tripId: z.number().int().positive().describe("The trip ID"),
    },
    READ_ONLY_ANNOTATIONS,
    async (args) => {
      logger.info({ tool: "get_trip_overview", userId, tripId: args.tripId }, "[MCP] tool call");
      try {
        await assertTripAccess(userId, role, args.tripId);

        const [trip] = await db
          .select()
          .from(tripsTable)
          .where(eq(tripsTable.id, args.tripId));
        if (!trip) return toolError("TRIP_NOT_FOUND", `Trip ${args.tripId} not found.`);

        const [flights, accom, activities, parts, packing, packingChecked, expenses] =
          await Promise.all([
            db.select({ count: sql<number>`count(*)` }).from(flightsTable).where(eq(flightsTable.tripId, args.tripId)),
            db.select({ count: sql<number>`count(*)` }).from(accommodationsTable).where(eq(accommodationsTable.tripId, args.tripId)),
            db.select({ count: sql<number>`count(*)` }).from(activitiesTable).where(eq(activitiesTable.tripId, args.tripId)),
            db.select({ count: sql<number>`count(*)` }).from(tripParticipantsTable).where(eq(tripParticipantsTable.tripId, args.tripId)),
            db.select({ count: sql<number>`count(*)` }).from(packingItemsTable).where(eq(packingItemsTable.tripId, args.tripId)),
            db
              .select({ count: sql<number>`count(*)` })
              .from(packingItemsTable)
              .where(and(eq(packingItemsTable.tripId, args.tripId), eq(packingItemsTable.checked, true))),
            db.select({ count: sql<number>`count(*)` }).from(tripExpensesTable).where(eq(tripExpensesTable.tripId, args.tripId)),
          ]);

        const start = new Date(trip.startDate);
        const end = new Date(trip.endDate);
        const daysCount = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1);

        const counts = {
          participants: Number(parts[0]?.count ?? 0),
          flights: Number(flights[0]?.count ?? 0),
          accommodations: Number(accom[0]?.count ?? 0),
          activities: Number(activities[0]?.count ?? 0),
          expenses: Number(expenses[0]?.count ?? 0),
          packingItems: Number(packing[0]?.count ?? 0),
          packingChecked: Number(packingChecked[0]?.count ?? 0),
        };

        const sc = {
          tripId: trip.id,
          name: trip.title,
          destination: trip.destination,
          startDate: trip.startDate,
          endDate: trip.endDate,
          daysCount,
          status: trip.status,
          description: trip.description ?? null,
          counts,
        };

        const text = [
          `Trip: ${trip.title}`,
          `Destination: ${trip.destination}`,
          `Dates: ${trip.startDate} – ${trip.endDate} (${daysCount} days)`,
          `Status: ${trip.status}`,
          trip.description ? `Description: ${trip.description}` : null,
          `Participants: ${counts.participants}`,
          `Flights: ${counts.flights} | Accommodations: ${counts.accommodations} | Activities: ${counts.activities}`,
          `Expenses: ${counts.expenses}`,
          `Packing: ${counts.packingChecked}/${counts.packingItems} items checked`,
        ]
          .filter(Boolean)
          .join("\n");

        logger.info({ tool: "get_trip_overview", userId, tripId: args.tripId, outcome: "ok" }, "[MCP] tool success");
        return toolOk(sc, text);
      } catch (err) {
        if (err instanceof McpToolError) return toolError(err.code, err.message);
        logger.error({ tool: "get_trip_overview", userId, tripId: args.tripId, err }, "[MCP] tool error");
        return toolError("SERVER_ERROR", "An internal error occurred.");
      }
    },
  );

  // ── get_trip_itinerary ───────────────────────────────────────────────────────
  server.tool(
    "get_trip_itinerary",
    "Get itinerary and timeline events for a trip, optionally filtered by date.",
    {
      tripId: z.number().int().positive().describe("The trip ID"),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional()
        .describe("Filter to a specific date (YYYY-MM-DD)"),
    },
    READ_ONLY_ANNOTATIONS,
    async (args) => {
      logger.info({ tool: "get_trip_itinerary", userId, tripId: args.tripId, date: args.date }, "[MCP] tool call");
      try {
        await assertTripAccess(userId, role, args.tripId);

        const [itinerary, flights, accommodations, activities, carRentals] = await Promise.all([
          db.select().from(itineraryDaysTable).where(eq(itineraryDaysTable.tripId, args.tripId)).orderBy(itineraryDaysTable.date),
          db.select().from(flightsTable).where(eq(flightsTable.tripId, args.tripId)),
          db.select().from(accommodationsTable).where(eq(accommodationsTable.tripId, args.tripId)),
          db.select().from(activitiesTable).where(eq(activitiesTable.tripId, args.tripId)),
          db.select().from(carRentalsTable).where(eq(carRentalsTable.tripId, args.tripId)),
        ]);

        type TimelineEvent = {
          id: number;
          type: string;
          date: string;
          title: string;
          description: string | null;
          location: string | null;
          time: string | null;
          startTime?: string | null;
          endTime?: string | null;
          notes: string | null;
        };

        const events: TimelineEvent[] = [
          ...itinerary.map(d => ({
            id: d.id,
            type: "itinerary",
            date: d.date,
            title: d.title,
            description: d.description ?? null,
            location: null,
            time: d.startTime ?? null,
            startTime: d.startTime ?? null,
            endTime: d.endTime ?? null,
            notes: d.notes ?? null,
          })),
          ...flights.map(f => ({
            id: f.id,
            type: "flight",
            date: f.departureDatetime.substring(0, 10),
            // Sanitized: confirmation codes intentionally excluded from itinerary output
            title: `${f.airline} ${f.flightNumber}: ${f.departureAirport} → ${f.arrivalAirport}`,
            description: null,
            location: f.departureAirport,
            time: f.departureDatetime.length > 10 ? f.departureDatetime.substring(11, 16) : null,
            notes: f.notes ?? null,
          })),
          ...accommodations.map(a => ({
            id: a.id,
            type: "accommodation",
            date: a.checkIn,
            title: `Check-in: ${a.name}`,
            description: null,
            location: a.address,
            time: null,
            notes: a.notes ?? null,
          })),
          ...activities.map(a => ({
            id: a.id,
            type: "activity",
            date: a.date,
            title: a.title,
            description: a.description ?? null,
            location: a.location ?? null,
            time: a.time ?? null,
            notes: null,
          })),
          ...carRentals.map(r => ({
            id: r.id,
            type: "car_rental",
            date: r.pickupDatetime.substring(0, 10),
            title: `${r.company} car rental pick-up`,
            description: null,
            location: r.pickupLocation,
            time: r.pickupDatetime.length > 10 ? r.pickupDatetime.substring(11, 16) : null,
            notes: r.notes ?? null,
          })),
        ];

        events.sort((a, b) => {
          if (a.date !== b.date) return a.date.localeCompare(b.date);
          return (a.time ?? "00:00").localeCompare(b.time ?? "00:00");
        });

        const filtered = args.date ? events.filter(e => e.date === args.date) : events;

        const text =
          filtered.length === 0
            ? "No itinerary events found."
            : filtered
                .map(e => `${e.date}${e.time ? " " + e.time : ""} [${e.type}] ${e.title}${e.location ? " @ " + e.location : ""}`)
                .join("\n");

        logger.info({ tool: "get_trip_itinerary", userId, tripId: args.tripId, eventCount: filtered.length, outcome: "ok" }, "[MCP] tool success");
        return toolOk(
          { tripId: args.tripId, date: args.date ?? null, events: filtered },
          `${filtered.length} event(s):\n${text}`,
        );
      } catch (err) {
        if (err instanceof McpToolError) return toolError(err.code, err.message);
        logger.error({ tool: "get_trip_itinerary", userId, tripId: args.tripId, err }, "[MCP] tool error");
        return toolError("SERVER_ERROR", "An internal error occurred.");
      }
    },
  );

  // ── get_trip_participants ────────────────────────────────────────────────────
  server.tool(
    "get_trip_participants",
    "List participants of a trip. Returns only information appropriate for other trip members.",
    {
      tripId: z.number().int().positive().describe("The trip ID"),
    },
    READ_ONLY_ANNOTATIONS,
    async (args) => {
      logger.info({ tool: "get_trip_participants", userId, tripId: args.tripId }, "[MCP] tool call");
      try {
        await assertTripAccess(userId, role, args.tripId);

        const participants = await db
          .select({ user: usersTable, participant: tripParticipantsTable })
          .from(usersTable)
          .innerJoin(
            tripParticipantsTable,
            and(
              eq(tripParticipantsTable.userId, usersTable.id),
              eq(tripParticipantsTable.tripId, args.tripId),
            ),
          );

        // Sanitized: return only id, name, role, and trip-admin status.
        // NO passwordHash, email, username, tokens, session data, or unrelated profile fields.
        const sanitized = participants.map(p => ({
          participantId: p.user.id,
          displayName: p.user.name,
          role: p.user.role,
          isTripAdmin: p.participant.isTripAdmin,
        }));

        const text =
          sanitized.length === 0
            ? "No participants found."
            : sanitized
                .map(p => `• ${p.displayName} (${p.role})${p.isTripAdmin ? " [trip admin]" : ""}`)
                .join("\n");

        logger.info({ tool: "get_trip_participants", userId, tripId: args.tripId, count: sanitized.length, outcome: "ok" }, "[MCP] tool success");
        return toolOk(
          { tripId: args.tripId, participants: sanitized },
          `${sanitized.length} participant(s):\n${text}`,
        );
      } catch (err) {
        if (err instanceof McpToolError) return toolError(err.code, err.message);
        logger.error({ tool: "get_trip_participants", userId, tripId: args.tripId, err }, "[MCP] tool error");
        return toolError("SERVER_ERROR", "An internal error occurred.");
      }
    },
  );

  // ── get_trip_expense_summary ─────────────────────────────────────────────────
  server.tool(
    "get_trip_expense_summary",
    "Get expense totals, per-participant balances, and settlement recommendations for a trip. Read-only.",
    {
      tripId: z.number().int().positive().describe("The trip ID"),
    },
    READ_ONLY_ANNOTATIONS,
    async (args) => {
      logger.info({ tool: "get_trip_expense_summary", userId, tripId: args.tripId }, "[MCP] tool call");
      try {
        await assertTripAccess(userId, role, args.tripId);

        // Mirrors the balance logic in src/routes/expenses.ts (GET /trips/:tripId/expenses/balance)
        const participants = await db
          .select({ userId: tripParticipantsTable.userId, name: usersTable.name })
          .from(tripParticipantsTable)
          .innerJoin(usersTable, eq(usersTable.id, tripParticipantsTable.userId))
          .where(eq(tripParticipantsTable.tripId, args.tripId));

        if (participants.length === 0) {
          return toolOk(
            { tripId: args.tripId, totalSpent: 0, currency: "USD", balances: [], settlements: [] },
            "No participants — no expenses.",
          );
        }

        const balances: Record<number, { userId: number; name: string; totalPaid: number; totalOwed: number; net: number }> = {};
        for (const p of participants) {
          balances[p.userId] = { userId: p.userId, name: p.name, totalPaid: 0, totalOwed: 0, net: 0 };
        }

        const expenses = await db
          .select()
          .from(tripExpensesTable)
          .where(eq(tripExpensesTable.tripId, args.tripId));

        // Include departed payers (left the trip but still in the ledger)
        const currentIds = new Set(participants.map(p => p.userId));
        const departedPayerIds = new Set<number>();
        for (const e of expenses) {
          if (!currentIds.has(e.paidByUserId)) departedPayerIds.add(e.paidByUserId);
        }
        if (departedPayerIds.size > 0) {
          const departed = await db
            .select({ id: usersTable.id, name: usersTable.name })
            .from(usersTable)
            .where(sql`${usersTable.id} = ANY(ARRAY[${sql.join([...departedPayerIds].map(id => sql`${id}`), sql`, `)}]::int[])`);
          for (const u of departed) {
            balances[u.id] = { userId: u.id, name: u.name, totalPaid: 0, totalOwed: 0, net: 0 };
          }
        }

        for (const e of expenses) {
          if (balances[e.paidByUserId]) balances[e.paidByUserId].totalPaid += parseFloat(e.amount);
        }

        const expenseIds = expenses.map(e => e.id);
        let allSplits: Array<typeof expenseSplitsTable.$inferSelect> = [];
        if (expenseIds.length > 0) {
          allSplits = await db
            .select()
            .from(expenseSplitsTable)
            .where(sql`${expenseSplitsTable.expenseId} = ANY(ARRAY[${sql.join(expenseIds.map(id => sql`${id}`), sql`, `)}]::int[])`);
        }

        const expensePayer = new Map<number, number>(expenses.map(e => [e.id, e.paidByUserId]));
        const owedToUser = new Map<number, number>();
        for (const id of Object.keys(balances)) owedToUser.set(Number(id), 0);

        for (const split of allSplits) {
          const payerOfExpense = expensePayer.get(split.expenseId);
          if (payerOfExpense === undefined) continue;
          if (!split.isPaid && split.userId !== payerOfExpense) {
            if (balances[split.userId]) balances[split.userId].totalOwed += parseFloat(split.shareAmount);
            if (balances[payerOfExpense] !== undefined) {
              owedToUser.set(payerOfExpense, (owedToUser.get(payerOfExpense) ?? 0) + parseFloat(split.shareAmount));
            }
          }
        }

        let totalSpent = 0;
        for (const b of Object.values(balances)) {
          const owedToMe = owedToUser.get(b.userId) ?? 0;
          b.net = Math.round((owedToMe - b.totalOwed) * 100) / 100;
          b.totalPaid = Math.round(b.totalPaid * 100) / 100;
          b.totalOwed = Math.round(b.totalOwed * 100) / 100;
          totalSpent += b.totalPaid;
        }

        const sortedBalances = Object.values(balances).sort((a, b) => a.name.localeCompare(b.name));
        const settlements = minimizeDebts(
          Object.fromEntries(sortedBalances.map(b => [b.userId, { name: b.name, net: b.net }])),
        );
        const currency = expenses[0]?.currency ?? "USD";
        const roundedTotal = Math.round(totalSpent * 100) / 100;

        const balanceText = sortedBalances
          .map(b => `  ${b.name}: paid ${b.totalPaid} ${currency}, owes ${b.totalOwed} ${currency}, net ${b.net >= 0 ? "+" : ""}${b.net}`)
          .join("\n");
        const settleText =
          settlements.length === 0
            ? "  All settled."
            : settlements.map(s => `  ${s.fromName} → ${s.toName}: ${s.amount} ${currency}`).join("\n");

        logger.info({ tool: "get_trip_expense_summary", userId, tripId: args.tripId, outcome: "ok" }, "[MCP] tool success");
        return toolOk(
          { tripId: args.tripId, totalSpent: roundedTotal, currency, balances: sortedBalances, settlements },
          `Total spent: ${roundedTotal} ${currency}\n\nBalances:\n${balanceText}\n\nSettlements:\n${settleText}`,
        );
      } catch (err) {
        if (err instanceof McpToolError) return toolError(err.code, err.message);
        logger.error({ tool: "get_trip_expense_summary", userId, tripId: args.tripId, err }, "[MCP] tool error");
        return toolError("SERVER_ERROR", "An internal error occurred.");
      }
    },
  );
}
