import { Router, type IRouter } from "express";
import { eq, and, or, ne } from "drizzle-orm";
import { db, tripNotesTable, travelDocumentsTable, usersTable, tripParticipantsTable } from "@workspace/db";
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

function serializeNote(note: typeof tripNotesTable.$inferSelect & { authorName?: string | null; isMine?: boolean }) {
  return {
    ...note,
    title: note.title ?? null,
    isShared: note.isShared,
    authorName: note.authorName ?? null,
    isMine: note.isMine ?? true,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString(),
  };
}

function serializeDoc(doc: typeof travelDocumentsTable.$inferSelect & { authorName?: string | null; isMine?: boolean }) {
  return {
    ...doc,
    expiryDate: doc.expiryDate ?? null,
    notes: doc.notes ?? null,
    isShared: doc.isShared,
    authorName: doc.authorName ?? null,
    isMine: doc.isMine ?? true,
  };
}

// Trip Notes — own notes + shared notes from other participants
router.get("/trips/:tripId/notes", requireAuth, async (req, res): Promise<void> => {
  const params = ListTripNotesParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }

  const { tripId } = params.data;
  const myUserId = req.session!.userId!;

  // My own notes (all of them)
  const myNotes = await db.select().from(tripNotesTable).where(
    and(eq(tripNotesTable.tripId, tripId), eq(tripNotesTable.userId, myUserId))
  ).orderBy(tripNotesTable.createdAt);

  // Shared notes from other participants (with author name)
  const sharedRows = await db
    .select({
      note: tripNotesTable,
      authorName: usersTable.name,
    })
    .from(tripNotesTable)
    .innerJoin(usersTable, eq(usersTable.id, tripNotesTable.userId))
    .where(and(
      eq(tripNotesTable.tripId, tripId),
      eq(tripNotesTable.isShared, true),
      ne(tripNotesTable.userId, myUserId),
    ))
    .orderBy(tripNotesTable.createdAt);

  const result = [
    ...myNotes.map(n => serializeNote({ ...n, isMine: true })),
    ...sharedRows.map(r => serializeNote({ ...r.note, authorName: r.authorName, isMine: false })),
  ];

  res.json(result);
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
  res.status(201).json(serializeNote({ ...item, isMine: true }));
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
      eq(tripNotesTable.userId, req.session!.userId!)   // can only edit own notes
    )).returning();
  if (!item) { res.status(404).json({ error: "Note not found" }); return; }
  res.json(serializeNote({ ...item, isMine: true }));
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

// Travel Documents — own docs + shared docs from other participants
router.get("/trips/:tripId/documents", requireAuth, async (req, res): Promise<void> => {
  const params = ListTravelDocumentsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }

  const { tripId } = params.data;
  const myUserId = req.session!.userId!;

  const myDocs = await db.select().from(travelDocumentsTable).where(
    and(eq(travelDocumentsTable.tripId, tripId), eq(travelDocumentsTable.userId, myUserId))
  );

  const sharedRows = await db
    .select({
      doc: travelDocumentsTable,
      authorName: usersTable.name,
    })
    .from(travelDocumentsTable)
    .innerJoin(usersTable, eq(usersTable.id, travelDocumentsTable.userId))
    .where(and(
      eq(travelDocumentsTable.tripId, tripId),
      eq(travelDocumentsTable.isShared, true),
      ne(travelDocumentsTable.userId, myUserId),
    ));

  const result = [
    ...myDocs.map(d => serializeDoc({ ...d, isMine: true })),
    ...sharedRows.map(r => serializeDoc({ ...r.doc, authorName: r.authorName, isMine: false })),
  ];

  res.json(result);
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
  res.status(201).json(serializeDoc({ ...item, isMine: true }));
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
  res.json(serializeDoc({ ...item, isMine: true }));
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
