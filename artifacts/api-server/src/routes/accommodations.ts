import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, accommodationsTable } from "@workspace/db";
import {
  ListAccommodationsParams,
  CreateAccommodationParams,
  CreateAccommodationBody,
  UpdateAccommodationParams,
  UpdateAccommodationBody,
  DeleteAccommodationParams,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/trips/:tripId/accommodations", requireAuth, async (req, res): Promise<void> => {
  const params = ListAccommodationsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const items = await db.select().from(accommodationsTable).where(eq(accommodationsTable.tripId, params.data.tripId)).orderBy(accommodationsTable.checkIn);
  res.json(items.map(a => ({ ...a, confirmationCode: a.confirmationCode ?? null, phone: a.phone ?? null, notes: a.notes ?? null })));
});

router.post("/trips/:tripId/accommodations", requireAdmin, async (req, res): Promise<void> => {
  const params = CreateAccommodationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreateAccommodationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.insert(accommodationsTable).values({ ...parsed.data, tripId: params.data.tripId }).returning();
  res.status(201).json({ ...item, confirmationCode: item.confirmationCode ?? null, phone: item.phone ?? null, notes: item.notes ?? null });
});

router.patch("/trips/:tripId/accommodations/:accommodationId", requireAdmin, async (req, res): Promise<void> => {
  const params = UpdateAccommodationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdateAccommodationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.update(accommodationsTable).set(parsed.data).where(and(eq(accommodationsTable.id, params.data.accommodationId), eq(accommodationsTable.tripId, params.data.tripId))).returning();
  if (!item) { res.status(404).json({ error: "Accommodation not found" }); return; }
  res.json({ ...item, confirmationCode: item.confirmationCode ?? null, phone: item.phone ?? null, notes: item.notes ?? null });
});

router.delete("/trips/:tripId/accommodations/:accommodationId", requireAdmin, async (req, res): Promise<void> => {
  const params = DeleteAccommodationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const [item] = await db.delete(accommodationsTable).where(and(eq(accommodationsTable.id, params.data.accommodationId), eq(accommodationsTable.tripId, params.data.tripId))).returning();
  if (!item) { res.status(404).json({ error: "Accommodation not found" }); return; }
  res.json({ success: true });
});

export default router;
