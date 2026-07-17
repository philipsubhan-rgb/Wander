import { pgTable, serial, text, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tripsTable } from "./trips";

export const packingItemsTable = pgTable("packing_items", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  checked: boolean("checked").notNull().default(false),
  required: boolean("required").notNull().default(false),
});

export const insertPackingItemSchema = createInsertSchema(packingItemsTable).omit({ id: true });
export type InsertPackingItem = z.infer<typeof insertPackingItemSchema>;
export type PackingItem = typeof packingItemsTable.$inferSelect;
