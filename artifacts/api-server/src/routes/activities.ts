import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, activitiesTable } from "@workspace/db";
import {
  ListActivitiesParams,
  CreateActivityParams,
  CreateActivityBody,
  UpdateActivityParams,
  UpdateActivityBody,
  DeleteActivityParams,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/trips/:tripId/activities", requireAuth, async (req, res): Promise<void> => {
  const params = ListActivitiesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const items = await db.select().from(activitiesTable).where(eq(activitiesTable.tripId, params.data.tripId)).orderBy(activitiesTable.date, activitiesTable.time);
  res.json(items.map(a => ({ ...a, description: a.description ?? null, time: a.time ?? null, location: a.location ?? null, lat: a.lat ?? null, lon: a.lon ?? null, imageUrl: a.imageUrl ?? null, locationUrl: a.locationUrl ?? null, notes: a.notes ?? null })));
});

router.post("/trips/:tripId/activities", requireAdmin, async (req, res): Promise<void> => {
  const params = CreateActivityParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreateActivityBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.insert(activitiesTable).values({ ...parsed.data, tripId: params.data.tripId }).returning();
  res.status(201).json({ ...item, description: item.description ?? null, time: item.time ?? null, location: item.location ?? null, lat: item.lat ?? null, lon: item.lon ?? null, imageUrl: item.imageUrl ?? null, locationUrl: item.locationUrl ?? null, notes: item.notes ?? null });
});

router.patch("/trips/:tripId/activities/:activityId", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateActivityParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdateActivityBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.update(activitiesTable).set(parsed.data).where(and(eq(activitiesTable.id, params.data.activityId), eq(activitiesTable.tripId, params.data.tripId))).returning();
  if (!item) { res.status(404).json({ error: "Activity not found" }); return; }
  res.json({ ...item, description: item.description ?? null, time: item.time ?? null, location: item.location ?? null, lat: item.lat ?? null, lon: item.lon ?? null, imageUrl: item.imageUrl ?? null, locationUrl: item.locationUrl ?? null, notes: item.notes ?? null });
});

router.delete("/trips/:tripId/activities/:activityId", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteActivityParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const [item] = await db.delete(activitiesTable).where(and(eq(activitiesTable.id, params.data.activityId), eq(activitiesTable.tripId, params.data.tripId))).returning();
  if (!item) { res.status(404).json({ error: "Activity not found" }); return; }
  res.json({ success: true });
});

export default router;
