import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, itineraryDaysTable } from "@workspace/db";
import {
  ListItineraryDaysParams,
  CreateItineraryDayParams,
  CreateItineraryDayBody,
  UpdateItineraryDayParams,
  UpdateItineraryDayBody,
  DeleteItineraryDayParams,
} from "@workspace/api-zod";
import { requireTripParticipant, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/trips/:tripId/itinerary", requireAuth, async (req, res): Promise<void> => {
  const params = ListItineraryDaysParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const items = await db.select().from(itineraryDaysTable).where(eq(itineraryDaysTable.tripId, params.data.tripId)).orderBy(itineraryDaysTable.date);
  res.json(items.map(d => ({ ...d, description: d.description ?? null, notes: d.notes ?? null, startTime: d.startTime ?? null, endTime: d.endTime ?? null })));
});

router.post("/trips/:tripId/itinerary", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = CreateItineraryDayParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreateItineraryDayBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.insert(itineraryDaysTable).values({ ...parsed.data, tripId: params.data.tripId }).returning();
  res.status(201).json({ ...item, description: item.description ?? null, notes: item.notes ?? null });
});

router.patch("/trips/:tripId/itinerary/:dayId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = UpdateItineraryDayParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdateItineraryDayBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.update(itineraryDaysTable).set(parsed.data).where(and(eq(itineraryDaysTable.id, params.data.dayId), eq(itineraryDaysTable.tripId, params.data.tripId))).returning();
  if (!item) { res.status(404).json({ error: "Itinerary day not found" }); return; }
  res.json({ ...item, description: item.description ?? null, notes: item.notes ?? null });
});

router.delete("/trips/:tripId/itinerary/:dayId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = DeleteItineraryDayParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const [item] = await db.delete(itineraryDaysTable).where(and(eq(itineraryDaysTable.id, params.data.dayId), eq(itineraryDaysTable.tripId, params.data.tripId))).returning();
  if (!item) { res.status(404).json({ error: "Itinerary day not found" }); return; }
  res.json({ success: true });
});

export default router;
