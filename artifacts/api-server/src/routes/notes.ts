import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, tripNotesTable, travelDocumentsTable } from "@workspace/db";
import {
  ListTripNotesParams,
  CreateTripNoteParams,
  CreateTripNoteBody,
  UpdateTripNoteParams,
  UpdateTripNoteBody,
  DeleteTripNoteParams,
  ListTravelDocumentsParams,
  CreateTravelDocumentParams,
  CreateTravelDocumentBody,
  UpdateTravelDocumentParams,
  UpdateTravelDocumentBody,
  DeleteTravelDocumentParams,
} from "@workspace/api-zod";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Trip Notes (private to user)
router.get("/trips/:tripId/notes", requireAuth, async (req, res): Promise<void> => {
  const params = ListTripNotesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const items = await db.select().from(tripNotesTable).where(and(
    eq(tripNotesTable.tripId, params.data.tripId),
    eq(tripNotesTable.userId, req.session!.userId!)
  )).orderBy(tripNotesTable.createdAt);
  res.json(items.map(n => ({
    ...n,
    title: n.title ?? null,
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
  })));
});

router.post("/trips/:tripId/notes", requireAuth, async (req, res): Promise<void> => {
  const params = CreateTripNoteParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreateTripNoteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.insert(tripNotesTable).values({
    ...parsed.data,
    tripId: params.data.tripId,
    userId: req.session!.userId!,
  }).returning();
  res.status(201).json({
    ...item,
    title: item.title ?? null,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  });
});

router.patch("/trips/:tripId/notes/:noteId", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateTripNoteParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdateTripNoteBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.update(tripNotesTable)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(and(
      eq(tripNotesTable.id, params.data.noteId),
      eq(tripNotesTable.tripId, params.data.tripId),
      eq(tripNotesTable.userId, req.session!.userId!)
    )).returning();
  if (!item) { res.status(404).json({ error: "Note not found" }); return; }
  res.json({ ...item, title: item.title ?? null, createdAt: item.createdAt.toISOString(), updatedAt: item.updatedAt.toISOString() });
});

router.delete("/trips/:tripId/notes/:noteId", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteTripNoteParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const [item] = await db.delete(tripNotesTable).where(and(
    eq(tripNotesTable.id, params.data.noteId),
    eq(tripNotesTable.tripId, params.data.tripId),
    eq(tripNotesTable.userId, req.session!.userId!)
  )).returning();
  if (!item) { res.status(404).json({ error: "Note not found" }); return; }
  res.json({ success: true });
});

// Travel Documents (private to user)
router.get("/trips/:tripId/documents", requireAuth, async (req, res): Promise<void> => {
  const params = ListTravelDocumentsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const items = await db.select().from(travelDocumentsTable).where(and(
    eq(travelDocumentsTable.tripId, params.data.tripId),
    eq(travelDocumentsTable.userId, req.session!.userId!)
  ));
  res.json(items.map(d => ({ ...d, expiryDate: d.expiryDate ?? null, notes: d.notes ?? null })));
});

router.post("/trips/:tripId/documents", requireAuth, async (req, res): Promise<void> => {
  const params = CreateTravelDocumentParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreateTravelDocumentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.insert(travelDocumentsTable).values({
    ...parsed.data,
    tripId: params.data.tripId,
    userId: req.session!.userId!,
  }).returning();
  res.status(201).json({ ...item, expiryDate: item.expiryDate ?? null, notes: item.notes ?? null });
});

router.patch("/trips/:tripId/documents/:documentId", requireAuth, async (req, res): Promise<void> => {
  const params = UpdateTravelDocumentParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdateTravelDocumentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.update(travelDocumentsTable).set(parsed.data).where(and(
    eq(travelDocumentsTable.id, params.data.documentId),
    eq(travelDocumentsTable.tripId, params.data.tripId),
    eq(travelDocumentsTable.userId, req.session!.userId!)
  )).returning();
  if (!item) { res.status(404).json({ error: "Document not found" }); return; }
  res.json({ ...item, expiryDate: item.expiryDate ?? null, notes: item.notes ?? null });
});

router.delete("/trips/:tripId/documents/:documentId", requireAuth, async (req, res): Promise<void> => {
  const params = DeleteTravelDocumentParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const [item] = await db.delete(travelDocumentsTable).where(and(
    eq(travelDocumentsTable.id, params.data.documentId),
    eq(travelDocumentsTable.tripId, params.data.tripId),
    eq(travelDocumentsTable.userId, req.session!.userId!)
  )).returning();
  if (!item) { res.status(404).json({ error: "Document not found" }); return; }
  res.json({ success: true });
});

export default router;
