import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, tripsTable, tripParticipantsTable, usersTable, flightsTable, accommodationsTable, activitiesTable, itineraryDaysTable, packingItemsTable, carRentalsTable, tripExpensesTable } from "@workspace/db";
import {
  CreateTripBody,
  UpdateTripBody,
  GetTripParams,
  UpdateTripParams,
  DeleteTripParams,
  GetTripSummaryParams,
  GetTripTimelineParams,
  ListTripParticipantsParams,
  AddTripParticipantBody,
  AddTripParticipantParams,
  RemoveTripParticipantParams,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth, requireTripAdmin } from "../middlewares/auth";
import { fetchDestinationImage } from "../lib/destination-image";
import { recalcExpenseSplitsForTrip } from "./expenses";

const router: IRouter = Router();

function serializeTrip(trip: typeof tripsTable.$inferSelect) {
  return {
    ...trip,
    createdAt: trip.createdAt.toISOString(),
    description: trip.description ?? null,
    coverImage: trip.coverImage ?? null,
    adminNotes: trip.adminNotes ?? null,
  };
}

// Helper: resolve whether the calling user is a trip admin (global admin OR per-trip admin participant)
async function resolveIsTripAdmin(userId: number, isGlobalAdmin: boolean, tripId: number): Promise<boolean> {
  if (isGlobalAdmin) return true;
  const [participant] = await db
    .select()
    .from(tripParticipantsTable)
    .where(and(
      eq(tripParticipantsTable.tripId, tripId),
      eq(tripParticipantsTable.userId, userId),
      eq(tripParticipantsTable.isTripAdmin, true),
    ));
  return !!participant;
}

// ──────────────────────────────────────────────────────────────────
// Trips CRUD
// ──────────────────────────────────────────────────────────────────

// Travelers see only their own trips; global admins see all
router.get("/trips", requireAuth, async (req, res): Promise<void> => {
  if (req.session!.role === "admin") {
    const trips = await db.select().from(tripsTable).orderBy(tripsTable.startDate);
    res.json(trips.map(serializeTrip));
  } else {
    const trips = await db
      .select({ trip: tripsTable })
      .from(tripsTable)
      .innerJoin(tripParticipantsTable, and(
        eq(tripParticipantsTable.tripId, tripsTable.id),
        eq(tripParticipantsTable.userId, req.session!.userId!)
      ))
      .orderBy(tripsTable.startDate);
    res.json(trips.map(r => serializeTrip(r.trip)));
  }
});

// Any authenticated user can create a trip; they are automatically the trip admin
router.post("/trips", requireAuth, async (req, res): Promise<void> => {
  const parsed = CreateTripBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [trip] = await db.insert(tripsTable).values(parsed.data).returning();

  // Auto-add the creator as a participant and trip admin
  await db.insert(tripParticipantsTable)
    .values({ tripId: trip.id, userId: req.session!.userId!, isTripAdmin: true })
    .onConflictDoNothing();

  // Auto-fetch a cover image if none was provided
  if (!trip.coverImage && trip.destination) {
    fetchDestinationImage(trip.destination).then(async (imgUrl) => {
      if (imgUrl) {
        await db.update(tripsTable).set({ coverImage: imgUrl }).where(eq(tripsTable.id, trip.id));
      }
    }).catch(() => { /* non-fatal */ });
  }

  res.status(201).json({ ...serializeTrip(trip), isTripAdmin: true });
});

// Returns trip + whether the calling user is a trip admin
router.get("/trips/:tripId", requireAuth, async (req, res): Promise<void> => {
  const params = GetTripParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid tripId" });
    return;
  }

  const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, params.data.tripId));
  if (!trip) {
    res.status(404).json({ error: "Trip not found" });
    return;
  }

  const isGlobalAdmin = req.session!.role === "admin";

  // Check access and resolve per-trip admin status in one query for non-global admins
  if (!isGlobalAdmin) {
    const [participant] = await db
      .select()
      .from(tripParticipantsTable)
      .where(and(
        eq(tripParticipantsTable.tripId, params.data.tripId),
        eq(tripParticipantsTable.userId, req.session!.userId!)
      ));
    if (!participant) {
      res.status(403).json({ error: "Access denied" });
      return;
    }
    res.json({ ...serializeTrip(trip), isTripAdmin: participant.isTripAdmin });
    return;
  }

  res.json({ ...serializeTrip(trip), isTripAdmin: true });
});

router.patch("/trips/:tripId", requireTripAdmin(), async (req, res): Promise<void> => {
  const params = UpdateTripParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid tripId" });
    return;
  }

  const parsed = UpdateTripBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [trip] = await db
    .update(tripsTable)
    .set(parsed.data)
    .where(eq(tripsTable.id, params.data.tripId))
    .returning();

  if (!trip) {
    res.status(404).json({ error: "Trip not found" });
    return;
  }

  if (parsed.data.destination && !parsed.data.coverImage) {
    fetchDestinationImage(parsed.data.destination).then(async (imgUrl) => {
      if (imgUrl) {
        await db.update(tripsTable).set({ coverImage: imgUrl }).where(eq(tripsTable.id, trip.id));
      }
    }).catch(() => { /* non-fatal */ });
  }

  res.json(serializeTrip(trip));
});

// Manually refresh the cover image for a trip
router.post("/trips/:tripId/refresh-cover", requireTripAdmin(), async (req, res): Promise<void> => {
  const params = GetTripParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid tripId" });
    return;
  }

  const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, params.data.tripId));
  if (!trip) {
    res.status(404).json({ error: "Trip not found" });
    return;
  }

  const imgUrl = await fetchDestinationImage(trip.destination);
  if (!imgUrl) {
    res.status(422).json({ error: "Could not find a suitable image for this destination" });
    return;
  }

  const [updated] = await db
    .update(tripsTable)
    .set({ coverImage: imgUrl })
    .where(eq(tripsTable.id, trip.id))
    .returning();

  res.json(serializeTrip(updated));
});

router.delete("/trips/:tripId", requireTripAdmin(), async (req, res): Promise<void> => {
  const params = DeleteTripParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid tripId" });
    return;
  }

  const [trip] = await db.delete(tripsTable).where(eq(tripsTable.id, params.data.tripId)).returning();
  if (!trip) {
    res.status(404).json({ error: "Trip not found" });
    return;
  }

  res.json({ success: true });
});

// ──────────────────────────────────────────────────────────────────
// Summary & Timeline
// ──────────────────────────────────────────────────────────────────

router.get("/trips/:tripId/summary", requireAuth, async (req, res): Promise<void> => {
  const params = GetTripSummaryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid tripId" });
    return;
  }
  const { tripId } = params.data;

  const [flightCount] = await db.select({ count: sql<number>`count(*)` }).from(flightsTable).where(eq(flightsTable.tripId, tripId));
  const [accomCount] = await db.select({ count: sql<number>`count(*)` }).from(accommodationsTable).where(eq(accommodationsTable.tripId, tripId));
  const [actCount] = await db.select({ count: sql<number>`count(*)` }).from(activitiesTable).where(eq(activitiesTable.tripId, tripId));
  const [partCount] = await db.select({ count: sql<number>`count(*)` }).from(tripParticipantsTable).where(eq(tripParticipantsTable.tripId, tripId));
  const [packCount] = await db.select({ count: sql<number>`count(*)` }).from(packingItemsTable).where(eq(packingItemsTable.tripId, tripId));
  const [packChecked] = await db.select({ count: sql<number>`count(*)` }).from(packingItemsTable).where(and(eq(packingItemsTable.tripId, tripId), eq(packingItemsTable.checked, true)));

  const [trip] = await db.select({ startDate: tripsTable.startDate, endDate: tripsTable.endDate }).from(tripsTable).where(eq(tripsTable.id, tripId));
  let daysCount = 0;
  if (trip) {
    const start = new Date(trip.startDate);
    const end = new Date(trip.endDate);
    daysCount = Math.max(1, Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  }

  res.json({
    tripId,
    daysCount,
    flightsCount: Number(flightCount?.count ?? 0),
    accommodationsCount: Number(accomCount?.count ?? 0),
    activitiesCount: Number(actCount?.count ?? 0),
    participantsCount: Number(partCount?.count ?? 0),
    packingItemsCount: Number(packCount?.count ?? 0),
    packingCheckedCount: Number(packChecked?.count ?? 0),
  });
});

router.get("/trips/:tripId/timeline", requireAuth, async (req, res): Promise<void> => {
  const params = GetTripTimelineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid tripId" });
    return;
  }
  const { tripId } = params.data;

  const [flights, accommodations, activities, itinerary, carRentals] = await Promise.all([
    db.select().from(flightsTable).where(eq(flightsTable.tripId, tripId)),
    db.select().from(accommodationsTable).where(eq(accommodationsTable.tripId, tripId)),
    db.select().from(activitiesTable).where(eq(activitiesTable.tripId, tripId)),
    db.select().from(itineraryDaysTable).where(eq(itineraryDaysTable.tripId, tripId)),
    db.select().from(carRentalsTable).where(eq(carRentalsTable.tripId, tripId)),
  ]);

  const events = [
    ...flights.map(f => ({
      id: f.id,
      type: "flight" as const,
      date: f.departureDatetime.substring(0, 10),
      title: `${f.airline} ${f.flightNumber}: ${f.departureAirport} → ${f.arrivalAirport}`,
      description: f.notes ?? null,
      location: f.departureAirport,
      time: f.departureDatetime.length > 10 ? f.departureDatetime.substring(11, 16) : null,
      imageUrl: null as string | null,
      carrierCode: f.flightNumber?.toUpperCase().match(/^([A-Z0-9]{2,3})\s*\d/)?.[1] ?? null,
      confirmationCode: f.confirmationCode ?? null,
    })),
    ...accommodations.map(a => ({
      id: a.id,
      type: "accommodation" as const,
      date: a.checkIn,
      title: `Check-in: ${a.name}`,
      description: a.notes ?? null,
      location: a.address,
      time: null,
      imageUrl: a.imageUrl ?? null,
      carrierCode: null as string | null,
      confirmationCode: a.confirmationCode ?? null,
    })),
    ...activities.map(a => ({
      id: a.id,
      type: "activity" as const,
      date: a.date,
      title: a.title,
      description: a.description ?? null,
      location: a.location ?? null,
      time: a.time ?? null,
      imageUrl: a.imageUrl ?? null,
      carrierCode: null as string | null,
      confirmationCode: null as string | null,
    })),
    ...carRentals.map(r => ({
      id: r.id,
      type: "car_rental" as const,
      date: r.pickupDatetime.substring(0, 10),
      title: `${r.company} pick-up`,
      description: r.notes ?? null,
      location: r.pickupLocation,
      time: r.pickupDatetime.length > 10 ? r.pickupDatetime.substring(11, 16) : null,
      imageUrl: null as string | null,
      carrierCode: null as string | null,
      confirmationCode: r.confirmationCode ?? null,
    })),
    ...itinerary.map(d => ({
      id: d.id,
      type: "itinerary" as const,
      date: d.date,
      title: d.title,
      description: d.description ?? null,
      location: null,
      time: null,
      imageUrl: null as string | null,
      carrierCode: null as string | null,
      confirmationCode: null as string | null,
    })),
  ];

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const at = a.time ?? "00:00";
    const bt = b.time ?? "00:00";
    return at.localeCompare(bt);
  });

  res.json(events);
});

// ──────────────────────────────────────────────────────────────────
// Participants
// ──────────────────────────────────────────────────────────────────

router.get("/trips/:tripId/participants", requireAuth, async (req, res): Promise<void> => {
  const params = ListTripParticipantsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid tripId" });
    return;
  }

  const participants = await db
    .select({ user: usersTable, participant: tripParticipantsTable })
    .from(usersTable)
    .innerJoin(tripParticipantsTable, and(
      eq(tripParticipantsTable.userId, usersTable.id),
      eq(tripParticipantsTable.tripId, params.data.tripId)
    ));

  res.json(participants.map(p => ({
    id: p.user.id,
    username: p.user.username,
    name: p.user.name,
    role: p.user.role,
    email: p.user.email ?? null,
    createdAt: p.user.createdAt.toISOString(),
    isTripAdmin: p.participant.isTripAdmin,
  })));
});

// Trip admins can add travelers to their trip
router.post("/trips/:tripId/participants", requireTripAdmin(), async (req, res): Promise<void> => {
  const params = AddTripParticipantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid tripId" });
    return;
  }

  const parsed = AddTripParticipantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  await db
    .insert(tripParticipantsTable)
    .values({ tripId: params.data.tripId, userId: parsed.data.userId, isTripAdmin: false })
    .onConflictDoNothing();

  const splitsRecalculated = await recalcExpenseSplitsForTrip(params.data.tripId);

  res.json({ success: true, splitsRecalculated });
});

// Trip admins can remove travelers from their trip
router.delete("/trips/:tripId/participants/:userId", requireTripAdmin(), async (req, res): Promise<void> => {
  const params = RemoveTripParticipantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid params" });
    return;
  }

  const { tripId, userId } = params.data;

  // Count how many expenses in this trip this user paid for, so the admin can be warned
  const [payerExpenseCount] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tripExpensesTable)
    .where(and(eq(tripExpensesTable.tripId, tripId), eq(tripExpensesTable.paidByUserId, userId)));
  const expensesAsPayer = Number(payerExpenseCount?.count ?? 0);

  await db
    .delete(tripParticipantsTable)
    .where(and(
      eq(tripParticipantsTable.tripId, tripId),
      eq(tripParticipantsTable.userId, userId)
    ));

  const splitsRecalculated = await recalcExpenseSplitsForTrip(tripId);

  res.json({ success: true, splitsRecalculated, expensesAsPayer });
});

export default router;
