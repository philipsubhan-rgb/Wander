/**
 * Car rental validation schemas for the API server routes.
 * These are maintained separately since car rentals predate the Orval codegen
 * and their OpenAPI paths are not yet in the spec.
 */
import * as zod from "zod";

export const ListCarRentalsParams = zod.object({
  tripId: zod.coerce.number(),
});

export const CreateCarRentalParams = zod.object({
  tripId: zod.coerce.number(),
});

export const CreateCarRentalBody = zod.object({
  company: zod.string().min(1),
  pickupLocation: zod.string().min(1),
  dropoffLocation: zod.string().optional(),
  pickupDatetime: zod.string().min(1),
  dropoffDatetime: zod.string().min(1),
  carType: zod
    .enum(["economy", "compact", "midsize", "fullsize", "suv", "luxury", "van", "convertible", "other"])
    .default("other"),
  confirmationCode: zod.string().optional(),
  driverName: zod.string().optional(),
  phone: zod.string().optional(),
  lat: zod.number().optional(),
  lon: zod.number().optional(),
  imageUrl: zod.string().optional(),
  notes: zod.string().optional(),
});

export const UpdateCarRentalParams = zod.object({
  tripId: zod.coerce.number(),
  carRentalId: zod.coerce.number(),
});

export const UpdateCarRentalBody = CreateCarRentalBody.partial();

export const DeleteCarRentalParams = zod.object({
  tripId: zod.coerce.number(),
  carRentalId: zod.coerce.number(),
});
