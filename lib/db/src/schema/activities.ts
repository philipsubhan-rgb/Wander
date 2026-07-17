import { pgTable, serial, text, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tripsTable } from "./trips";

export const activityTypeEnum = pgEnum("activity_type", ["sightseeing", "dining", "adventure", "culture", "relaxation", "transport", "other"]);

export const activitiesTable = pgTable("activities", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  description: text("description"),
  date: text("date").notNull(),
  time: text("time"),
  location: text("location"),
  type: activityTypeEnum("type").notNull().default("other"),
  notes: text("notes"),
});

export const insertActivitySchema = createInsertSchema(activitiesTable).omit({ id: true });
export type InsertActivity = z.infer<typeof insertActivitySchema>;
export type Activity = typeof activitiesTable.$inferSelect;
