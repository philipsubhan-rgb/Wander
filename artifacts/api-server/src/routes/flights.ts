import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, flightsTable } from "@workspace/db";
import {
  ListFlightsParams,
  CreateFlightParams,
  CreateFlightBody,
  UpdateFlightParams,
  UpdateFlightBody,
  DeleteFlightParams,
} from "@workspace/api-zod";
import { requireTripParticipant, getAuthUserId } from "../middlewares/auth";

// Extras pass hook (§7): lazy-loaded like the calendar-sync hook in
// reservations.ts — keeps this router's import graph light, and the
// pass is best-effort (a failure never fails the flight add).
let extrasPromise: Promise<typeof import("../lib/extras.js") | null> | null = null;
async function extras() {
  extrasPromise ??= import("../lib/extras.js").catch(() => null);
  return extrasPromise;
}

const router: IRouter = Router();

// Normalise nullable columns to explicit nulls for the API response shape.
function toFlightResponse(f: typeof flightsTable.$inferSelect) {
  return {
    ...f,
    departureTimezone: f.departureTimezone ?? null,
    arrivalTimezone: f.arrivalTimezone ?? null,
    confirmationCode: f.confirmationCode ?? null,
    notes: f.notes ?? null,
    totalPrice: f.totalPrice ?? null,
    fareBrand: f.fareBrand ?? null,
    refundable: f.refundable ?? null,
    changeable: f.changeable ?? null,
    checkedBags: f.checkedBags ?? null,
    passengerCount: f.passengerCount ?? null,
  };
}

router.get("/trips/:tripId/flights", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = ListFlightsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const flights = await db.select().from(flightsTable).where(eq(flightsTable.tripId, params.data.tripId)).orderBy(flightsTable.departureDatetime);
  res.json(flights.map(toFlightResponse));
});

router.post("/trips/:tripId/flights", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = CreateFlightParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreateFlightBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [flight] = await db.insert(flightsTable).values({ ...parsed.data, tripId: params.data.tripId }).returning();
  // Calendar write-back (best-effort; never fails the request).
  const userId = getAuthUserId(req, res);
  if (userId) {
    const { syncFlightForUser } = await import("../lib/calendarSync");
    await syncFlightForUser(userId, flight);
  }
  // The golf rule (§7): extras like club shipping must surface BEFORE
  // flights finalize — a flight landing on the trip fires the pass.
  const ex = await extras();
  if (ex) await ex.runExtrasPassBestEffort(params.data.tripId, "flight_added");
  res.status(201).json(toFlightResponse(flight));
});

router.patch("/trips/:tripId/flights/:flightId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = UpdateFlightParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdateFlightBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [flight] = await db.update(flightsTable).set(parsed.data).where(and(eq(flightsTable.id, params.data.flightId), eq(flightsTable.tripId, params.data.tripId))).returning();
  if (!flight) { res.status(404).json({ error: "Flight not found" }); return; }
  // Keep linked calendar events in sync (best-effort).
  const { updateLinkedCalendarEventsForItem } = await import("../lib/calendarSync");
  await updateLinkedCalendarEventsForItem({ type: "flight", item: flight });
  res.json(toFlightResponse(flight));
});

router.delete("/trips/:tripId/flights/:flightId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = DeleteFlightParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  // Remove linked calendar events first (links cascade with the row).
  const { deleteLinkedCalendarEventsForItem } = await import("../lib/calendarSync");
  await deleteLinkedCalendarEventsForItem("flight", params.data.flightId);
  const [flight] = await db.delete(flightsTable).where(and(eq(flightsTable.id, params.data.flightId), eq(flightsTable.tripId, params.data.tripId))).returning();
  if (!flight) { res.status(404).json({ error: "Flight not found" }); return; }
  res.json({ success: true });
});

export default router;
