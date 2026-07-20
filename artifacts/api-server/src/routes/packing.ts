import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, packingItemsTable, packingItemChecksTable } from "@workspace/db";
import {
  ListPackingItemsParams,
  CreatePackingItemParams,
  CreatePackingItemBody,
  UpdatePackingItemParams,
  UpdatePackingItemBody,
  DeletePackingItemParams,
} from "@workspace/api-zod";
import { requireAuth, getAuthUserId, getAuthRole } from "../middlewares/auth";

const router: IRouter = Router();

function serializeItem(item: any, isTemplate: boolean) {
  return {
    id: item.id,
    tripId: item.tripId,
    userId: item.userId ?? null,
    name: item.name,
    category: item.category ?? null,
    checked: item.checked ?? false,
    required: item.required ?? false,
    isTemplate,
  };
}

/**
 * GET /trips/:tripId/packing
 * Returns:
 *   - Template items (userId IS NULL) with the caller's checked state from packing_item_checks
 *   - The caller's personal items (userId = me)
 */
router.get("/trips/:tripId/packing", requireAuth, async (req, res): Promise<void> => {
  const params = ListPackingItemsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const { tripId } = params.data;
  const myUserId = getAuthUserId(req, res)!;

  // Template items — left join with packing_item_checks to get per-user checked state
  const templateRows = await db
    .select({
      id: packingItemsTable.id,
      tripId: packingItemsTable.tripId,
      userId: packingItemsTable.userId,
      name: packingItemsTable.name,
      category: packingItemsTable.category,
      required: packingItemsTable.required,
      checked: packingItemChecksTable.checked,
    })
    .from(packingItemsTable)
    .leftJoin(
      packingItemChecksTable,
      and(
        eq(packingItemChecksTable.itemId, packingItemsTable.id),
        eq(packingItemChecksTable.userId, myUserId),
      )
    )
    .where(and(eq(packingItemsTable.tripId, tripId), isNull(packingItemsTable.userId)))
    .orderBy(packingItemsTable.category, packingItemsTable.name);

  // Personal items for this user
  const personalRows = await db
    .select()
    .from(packingItemsTable)
    .where(and(eq(packingItemsTable.tripId, tripId), eq(packingItemsTable.userId, myUserId)))
    .orderBy(packingItemsTable.category, packingItemsTable.name);

  res.json([
    ...templateRows.map(r => serializeItem(r, true)),
    ...personalRows.map(r => serializeItem(r, false)),
  ]);
});

/**
 * POST /trips/:tripId/packing
 * Admin + isTemplate:true in body → creates a shared template item (userId = NULL)
 * Anyone else → creates a personal item (userId = me)
 */
router.post("/trips/:tripId/packing", requireAuth, async (req, res): Promise<void> => {
  const params = CreatePackingItemParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreatePackingItemBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const myUserId = getAuthUserId(req, res)!;
  const isAdmin = getAuthRole(req, res) === "admin";
  const isTemplate = isAdmin && req.body.isTemplate === true;

  const [item] = await db.insert(packingItemsTable).values({
    ...parsed.data,
    tripId: params.data.tripId,
    userId: isTemplate ? null : myUserId,
  }).returning();

  res.status(201).json(serializeItem(item, isTemplate));
});

/**
 * PATCH /trips/:tripId/packing/:packingItemId
 * Template items: any authenticated user can update their own checked state
 *   (name/category/required updates are admin-only for template items)
 * Personal items: owner only for all updates
 */
router.patch("/trips/:tripId/packing/:packingItemId", requireAuth, async (req, res): Promise<void> => {
  const params = UpdatePackingItemParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdatePackingItemBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const myUserId = getAuthUserId(req, res)!;
  const isAdmin = getAuthRole(req, res) === "admin";

  const [existing] = await db
    .select()
    .from(packingItemsTable)
    .where(and(eq(packingItemsTable.id, params.data.packingItemId), eq(packingItemsTable.tripId, params.data.tripId)));

  if (!existing) { res.status(404).json({ error: "Packing item not found" }); return; }

  const isTemplateItem = existing.userId === null;

  if (isTemplateItem) {
    // For template items, only the checked field is updated per-user via packing_item_checks
    // Name/category/required changes require admin
    const { checked, ...metaFields } = parsed.data;
    const hasMeta = Object.keys(metaFields).length > 0;
    if (hasMeta && !isAdmin) {
      res.status(403).json({ error: "Only admins can edit template item details" }); return;
    }

    // Update metadata on the item itself (admin only)
    if (hasMeta) {
      await db.update(packingItemsTable).set(metaFields)
        .where(eq(packingItemsTable.id, params.data.packingItemId));
    }

    // Upsert the user's checked state
    if (checked !== undefined) {
      await db.insert(packingItemChecksTable)
        .values({ itemId: params.data.packingItemId, userId: myUserId, checked })
        .onConflictDoUpdate({
          target: [packingItemChecksTable.itemId, packingItemChecksTable.userId],
          set: { checked },
        });
    }

    // Return item with the user's checked state
    const [check] = await db.select().from(packingItemChecksTable)
      .where(and(eq(packingItemChecksTable.itemId, params.data.packingItemId), eq(packingItemChecksTable.userId, myUserId)));

    const updated = { ...existing, ...metaFields };
    res.json(serializeItem({ ...updated, checked: check?.checked ?? false }, true));
    return;
  }

  // Personal item — only the owner can update
  if (existing.userId !== myUserId) {
    res.status(403).json({ error: "Not your item" }); return;
  }

  const [updated] = await db.update(packingItemsTable).set(parsed.data)
    .where(and(eq(packingItemsTable.id, params.data.packingItemId), eq(packingItemsTable.userId, myUserId)))
    .returning();

  if (!updated) { res.status(404).json({ error: "Packing item not found" }); return; }
  res.json(serializeItem(updated, false));
});

/**
 * DELETE /trips/:tripId/packing/:packingItemId
 * Template items: admin only
 * Personal items: owner only
 */
router.delete("/trips/:tripId/packing/:packingItemId", requireAuth, async (req, res): Promise<void> => {
  const params = DeletePackingItemParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }

  const myUserId = getAuthUserId(req, res)!;
  const isAdmin = getAuthRole(req, res) === "admin";

  const [existing] = await db
    .select()
    .from(packingItemsTable)
    .where(and(eq(packingItemsTable.id, params.data.packingItemId), eq(packingItemsTable.tripId, params.data.tripId)));

  if (!existing) { res.status(404).json({ error: "Packing item not found" }); return; }

  const isTemplateItem = existing.userId === null;

  if (isTemplateItem && !isAdmin) {
    res.status(403).json({ error: "Only admins can delete template items" }); return;
  }

  if (!isTemplateItem && existing.userId !== myUserId) {
    res.status(403).json({ error: "Not your item" }); return;
  }

  await db.delete(packingItemsTable).where(eq(packingItemsTable.id, params.data.packingItemId));
  res.json({ success: true });
});

export default router;
