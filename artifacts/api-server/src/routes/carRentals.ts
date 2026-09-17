import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, carRentalsTable } from "@workspace/db";
import {
  ListCarRentalsParams,
  CreateCarRentalParams,
  CreateCarRentalBody,
  UpdateCarRentalParams,
  UpdateCarRentalBody,
  DeleteCarRentalParams,
} from "@workspace/api-zod";
import { requireTripParticipant } from "../middlewares/auth";

const router: IRouter = Router();

const mapItem = (r: typeof carRentalsTable.$inferSelect) => ({
  ...r,
  dropoffLocation: r.dropoffLocation ?? null,
  confirmationCode: r.confirmationCode ?? null,
  driverName: r.driverName ?? null,
  phone: r.phone ?? null,
  lat: r.lat ?? null,
  lon: r.lon ?? null,
  imageUrl: r.imageUrl ?? null,
  notes: r.notes ?? null,
});

router.get("/trips/:tripId/car-rentals", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = ListCarRentalsParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const items = await db.select().from(carRentalsTable)
    .where(eq(carRentalsTable.tripId, params.data.tripId))
    .orderBy(carRentalsTable.pickupDatetime);
  res.json(items.map(mapItem));
});

router.post("/trips/:tripId/car-rentals", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = CreateCarRentalParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const parsed = CreateCarRentalBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.insert(carRentalsTable).values({ ...parsed.data, tripId: params.data.tripId }).returning();
  res.status(201).json(mapItem(item));
});

router.patch("/trips/:tripId/car-rentals/:carRentalId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = UpdateCarRentalParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const parsed = UpdateCarRentalBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  const [item] = await db.update(carRentalsTable).set(parsed.data)
    .where(and(eq(carRentalsTable.id, params.data.carRentalId), eq(carRentalsTable.tripId, params.data.tripId)))
    .returning();
  if (!item) { res.status(404).json({ error: "Car rental not found" }); return; }
  res.json(mapItem(item));
});

router.delete("/trips/:tripId/car-rentals/:carRentalId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = DeleteCarRentalParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const [item] = await db.delete(carRentalsTable)
    .where(and(eq(carRentalsTable.id, params.data.carRentalId), eq(carRentalsTable.tripId, params.data.tripId)))
    .returning();
  if (!item) { res.status(404).json({ error: "Car rental not found" }); return; }
  res.json({ success: true });
});

export default router;
