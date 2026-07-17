import { pgTable, serial, text, timestamp, pgEnum, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const tripStatusEnum = pgEnum("trip_status", ["planning", "confirmed", "active", "completed"]);

export const tripsTable = pgTable("trips", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  destination: text("destination").notNull(),
  startDate: text("start_date").notNull(),
  endDate: text("end_date").notNull(),
  description: text("description"),
  coverImage: text("cover_image"),
  status: tripStatusEnum("status").notNull().default("planning"),
  adminNotes: text("admin_notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const tripParticipantsTable = pgTable("trip_participants", {
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
});

export const insertTripSchema = createInsertSchema(tripsTable).omit({ id: true, createdAt: true });
export type InsertTrip = z.infer<typeof insertTripSchema>;
export type Trip = typeof tripsTable.$inferSelect;
