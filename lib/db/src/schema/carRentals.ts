import { pgTable, serial, text, integer, pgEnum, doublePrecision } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tripsTable } from "./trips";

export const carTypeEnum = pgEnum("car_type", ["economy", "compact", "midsize", "fullsize", "suv", "luxury", "van", "convertible", "other"]);

export const carRentalsTable = pgTable("car_rentals", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  company: text("company").notNull(),
  pickupLocation: text("pickup_location").notNull(),
  dropoffLocation: text("dropoff_location"),
  pickupDatetime: text("pickup_datetime").notNull(),
  dropoffDatetime: text("dropoff_datetime").notNull(),
  carType: carTypeEnum("car_type").notNull().default("other"),
  confirmationCode: text("confirmation_code"),
  driverName: text("driver_name"),
  phone: text("phone"),
  lat: doublePrecision("lat"),
  lon: doublePrecision("lon"),
  imageUrl: text("image_url"),
  notes: text("notes"),
});

export const insertCarRentalSchema = createInsertSchema(carRentalsTable).omit({ id: true });
export type InsertCarRental = z.infer<typeof insertCarRentalSchema>;
export type CarRental = typeof carRentalsTable.$inferSelect;
