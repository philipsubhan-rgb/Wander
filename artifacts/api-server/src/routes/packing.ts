import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, packingItemsTable } from "@workspace/db";
import {
  ListPackingItemsParams,
  CreatePackingItemParams,
  CreatePackingItemBody,
  UpdatePackingItemParams,
  UpdatePackingItemBody,
  DeletePackingItemParams,
} from "@workspace/api-zod";
import { requireAdmin, requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

router.get("/trips/:tripId/packing", requireAuth, async (req, res): Promise<void> => {
  const params = ListPackingItemsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const items = await db.select().from(packingItemsTable).where(eq(packingItemsTable.tripId, params.data.tripId)).orderBy(packingItemsTable.category, packingItemsTable.name);
  res.json(items.map(i => ({ ...i, category: i.category ?? null })));
});

router.post("/trips/:tripId/packing", requireAdmin, async (req, res): Promise<void> => {
  const params = CreatePackingItemParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreatePackingItemBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.insert(packingItemsTable).values({ ...parsed.data, tripId: params.data.tripId }).returning();
  res.status(201).json({ ...item, category: item.category ?? null });
});

router.patch("/trips/:tripId/packing/:itemId", requireAuth, async (req, res): Promise<void> => {
  const params = UpdatePackingItemParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdatePackingItemBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.update(packingItemsTable).set(parsed.data).where(and(eq(packingItemsTable.id, params.data.itemId), eq(packingItemsTable.tripId, params.data.tripId))).returning();
  if (!item) { res.status(404).json({ error: "Packing item not found" }); return; }
  res.json({ ...item, category: item.category ?? null });
});

router.delete("/trips/:tripId/packing/:itemId", requireAdmin, async (req, res): Promise<void> => {
  const params = DeletePackingItemParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const [item] = await db.delete(packingItemsTable).where(and(eq(packingItemsTable.id, params.data.itemId), eq(packingItemsTable.tripId, params.data.tripId))).returning();
  if (!item) { res.status(404).json({ error: "Packing item not found" }); return; }
  res.json({ success: true });
});

export default router;
