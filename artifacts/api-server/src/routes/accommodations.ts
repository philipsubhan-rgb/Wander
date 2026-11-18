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
import { requireTripParticipant } from "../middlewares/auth";

// Extras pass hook (§7): lazy-loaded like the calendar-sync hook in
// reservations.ts — the pass is best-effort (a failure never fails
// the stay add). A stay landing can unlock pack items (a home stay
// unlocks grocery pre-stocking; any stay unlocks the crib check).
let extrasPromise: Promise<typeof import("../lib/extras.js") | null> | null = null;
async function extras() {
  extrasPromise ??= import("../lib/extras.js").catch(() => null);
  return extrasPromise;
}

const router: IRouter = Router();

// Normalise nullable columns to explicit nulls for the API response shape.
function toAccommodationResponse(a: typeof accommodationsTable.$inferSelect) {
  return {
    ...a,
    lat: a.lat ?? null,
    lon: a.lon ?? null,
    imageUrl: a.imageUrl ?? null,
    confirmationCode: a.confirmationCode ?? null,
    phone: a.phone ?? null,
    notes: a.notes ?? null,
    nightlyRate: a.nightlyRate ?? null,
    totalPrice: a.totalPrice ?? null,
  };
}

router.get("/trips/:tripId/accommodations", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = ListAccommodationsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const items = await db.select().from(accommodationsTable).where(eq(accommodationsTable.tripId, params.data.tripId)).orderBy(accommodationsTable.checkIn);
  res.json(items.map(toAccommodationResponse));
});

router.post("/trips/:tripId/accommodations", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = CreateAccommodationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreateAccommodationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.insert(accommodationsTable).values({ ...parsed.data, tripId: params.data.tripId }).returning();
  const ex = await extras();
  if (ex) await ex.runExtrasPassBestEffort(params.data.tripId, "stay_added");
  res.status(201).json(toAccommodationResponse(item));
});

router.patch("/trips/:tripId/accommodations/:accommodationId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = UpdateAccommodationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdateAccommodationBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.update(accommodationsTable).set(parsed.data).where(and(eq(accommodationsTable.id, params.data.accommodationId), eq(accommodationsTable.tripId, params.data.tripId))).returning();
  if (!item) { res.status(404).json({ error: "Accommodation not found" }); return; }
  res.json(toAccommodationResponse(item));
});

router.delete("/trips/:tripId/accommodations/:accommodationId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = DeleteAccommodationParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const [item] = await db.delete(accommodationsTable).where(and(eq(accommodationsTable.id, params.data.accommodationId), eq(accommodationsTable.tripId, params.data.tripId))).returning();
  if (!item) { res.status(404).json({ error: "Accommodation not found" }); return; }
  res.json({ success: true });
});

export default router;
