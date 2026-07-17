import { pgTable, serial, text, integer, pgEnum, doublePrecision } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tripsTable } from "./trips";

export const accommodationTypeEnum = pgEnum("accommodation_type", ["hotel", "airbnb", "hostel", "resort", "other"]);

export const accommodationsTable = pgTable("accommodations", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  address: text("address").notNull(),
  checkIn: text("check_in").notNull(),
  checkOut: text("check_out").notNull(),
  type: accommodationTypeEnum("type").notNull().default("hotel"),
  lat: doublePrecision("lat"),
  lon: doublePrecision("lon"),
  imageUrl: text("image_url"),
  confirmationCode: text("confirmation_code"),
  phone: text("phone"),
  notes: text("notes"),
});

export const insertAccommodationSchema = createInsertSchema(accommodationsTable).omit({ id: true });
export type InsertAccommodation = z.infer<typeof insertAccommodationSchema>;
export type Accommodation = typeof accommodationsTable.$inferSelect;
