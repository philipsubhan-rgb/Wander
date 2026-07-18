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
import { requireTripParticipant, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/trips/:tripId/flights", requireAuth, async (req, res): Promise<void> => {
  const params = ListFlightsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const flights = await db.select().from(flightsTable).where(eq(flightsTable.tripId, params.data.tripId)).orderBy(flightsTable.departureDatetime);
  res.json(flights.map(f => ({ ...f, confirmationCode: f.confirmationCode ?? null, notes: f.notes ?? null })));
});

router.post("/trips/:tripId/flights", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = CreateFlightParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreateFlightBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [flight] = await db.insert(flightsTable).values({ ...parsed.data, tripId: params.data.tripId }).returning();
  res.status(201).json({ ...flight, confirmationCode: flight.confirmationCode ?? null, notes: flight.notes ?? null });
});

router.patch("/trips/:tripId/flights/:flightId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = UpdateFlightParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdateFlightBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [flight] = await db.update(flightsTable).set(parsed.data).where(and(eq(flightsTable.id, params.data.flightId), eq(flightsTable.tripId, params.data.tripId))).returning();
  if (!flight) { res.status(404).json({ error: "Flight not found" }); return; }
  res.json({ ...flight, confirmationCode: flight.confirmationCode ?? null, notes: flight.notes ?? null });
});

router.delete("/trips/:tripId/flights/:flightId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = DeleteFlightParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const [flight] = await db.delete(flightsTable).where(and(eq(flightsTable.id, params.data.flightId), eq(flightsTable.tripId, params.data.tripId))).returning();
  if (!flight) { res.status(404).json({ error: "Flight not found" }); return; }
  res.json({ success: true });
});

export default router;
