import { pgTable, serial, text, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tripsTable } from "./trips";
import { usersTable } from "./users";

export const tripNotesTable = pgTable("trip_notes", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  title: text("title"),
  content: text("content").notNull(),
  isShared: boolean("is_shared").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const travelDocumentsTable = pgTable("travel_documents", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  number: text("number").notNull(),
  expiryDate: text("expiry_date"),
  notes: text("notes"),
  isShared: boolean("is_shared").notNull().default(false),
});

export const insertTripNoteSchema = createInsertSchema(tripNotesTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertTripNote = z.infer<typeof insertTripNoteSchema>;
export type TripNote = typeof tripNotesTable.$inferSelect;

export const insertTravelDocumentSchema = createInsertSchema(travelDocumentsTable).omit({ id: true });
export type InsertTravelDocument = z.infer<typeof insertTravelDocumentSchema>;
export type TravelDocument = typeof travelDocumentsTable.$inferSelect;
