import { pgTable, serial, text, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tripsTable } from "./trips";

export const itineraryDaysTable = pgTable("itinerary_days", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  notes: text("notes"),
});

export const insertItineraryDaySchema = createInsertSchema(itineraryDaysTable).omit({ id: true });
export type InsertItineraryDay = z.infer<typeof insertItineraryDaySchema>;
export type ItineraryDay = typeof itineraryDaysTable.$inferSelect;
