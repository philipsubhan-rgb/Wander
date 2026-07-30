import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, reservationsTable } from "@workspace/db";
import { requireAuth, requireTripParticipant } from "../middlewares/auth";

const router: IRouter = Router();

function map(r: typeof reservationsTable.$inferSelect) {
  return {
    id:               r.id,
    tripId:           r.tripId,
    type:             r.type,
    title:            r.title,
    venue:            r.venue             ?? null,
    address:          r.address           ?? null,
    date:             r.date,
    time:             r.time              ?? null,
    endTime:          r.endTime           ?? null,
    confirmationCode: r.confirmationCode  ?? null,
    numberOfPeople:   r.numberOfPeople    ?? null,
    phone:            r.phone             ?? null,
    notes:            r.notes             ?? null,
    url:              r.url               ?? null,
    imageUrl:         r.imageUrl          ?? null,
    lat:              r.lat               ?? null,
    lon:              r.lon               ?? null,
    sortOrder:        r.sortOrder         ?? null,
  };
}

// GET /api/trips/:tripId/reservations
router.get("/trips/:tripId/reservations", requireAuth, async (req, res): Promise<void> => {
  const tripId = Number(req.params.tripId);
  if (isNaN(tripId)) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const rows = await db.select().from(reservationsTable).where(eq(reservationsTable.tripId, tripId));
  res.json(rows.map(map));
});

// POST /api/trips/:tripId/reservations
router.post("/trips/:tripId/reservations", requireTripParticipant(), async (req, res): Promise<void> => {
  const tripId = Number(req.params.tripId);
  if (isNaN(tripId)) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const {
    type, title, venue, address, date, time, endTime,
    confirmationCode, numberOfPeople, phone, notes, url, imageUrl, lat, lon,
  } = req.body;
  if (!title || !date) { res.status(400).json({ error: "title and date are required" }); return; }
  const [row] = await db.insert(reservationsTable).values({
    tripId, type: type ?? "other", title, venue, address, date, time, endTime,
    confirmationCode, numberOfPeople, phone, notes, url, imageUrl, lat, lon,
  }).returning();
  res.status(201).json(map(row));
});

// PATCH /api/trips/:tripId/reservations/:reservationId
router.patch("/trips/:tripId/reservations/:reservationId", requireTripParticipant(), async (req, res): Promise<void> => {
  const tripId        = Number(req.params.tripId);
  const reservationId = Number(req.params.reservationId);
  if (isNaN(tripId) || isNaN(reservationId)) { res.status(400).json({ error: "Invalid id" }); return; }
  const {
    type, title, venue, address, date, time, endTime,
    confirmationCode, numberOfPeople, phone, notes, url, imageUrl, lat, lon,
  } = req.body;
  const [row] = await db.update(reservationsTable)
    .set({ type, title, venue, address, date, time, endTime, confirmationCode, numberOfPeople, phone, notes, url, imageUrl, lat, lon })
    .where(eq(reservationsTable.id, reservationId))
    .returning();
  if (!row) { res.status(404).json({ error: "Not found" }); return; }
  res.json(map(row));
});

// POST /api/trips/:tripId/reservations/reorder
router.post("/trips/:tripId/reservations/reorder", requireTripParticipant(), async (req, res): Promise<void> => {
  const tripId = Number(req.params.tripId);
  if (isNaN(tripId)) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const { ids } = req.body as { ids?: unknown };
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "number")) {
    res.status(400).json({ error: "ids must be an array of numbers" }); return;
  }
  await Promise.all(
    (ids as number[]).map((id, index) =>
      db.update(reservationsTable)
        .set({ sortOrder: index })
        .where(and(eq(reservationsTable.id, id), eq(reservationsTable.tripId, tripId)))
    )
  );
  res.json({ success: true });
});

// DELETE /api/trips/:tripId/reservations/:reservationId
router.delete("/trips/:tripId/reservations/:reservationId", requireTripParticipant(), async (req, res): Promise<void> => {
  const reservationId = Number(req.params.reservationId);
  if (isNaN(reservationId)) { res.status(400).json({ error: "Invalid id" }); return; }
  await db.delete(reservationsTable).where(eq(reservationsTable.id, reservationId));
  res.json({ success: true });
});

export default router;
