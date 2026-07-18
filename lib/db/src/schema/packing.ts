import { pgTable, serial, text, integer, boolean, unique } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tripsTable } from "./trips";
import { usersTable } from "./users";

export const packingItemsTable = pgTable("packing_items", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  // null = admin-created template item visible to all travelers
  // non-null = personal item belonging to that user only
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  checked: boolean("checked").notNull().default(false), // used for personal items only
  required: boolean("required").notNull().default(false),
});

// Per-user checked state for template (shared) packing items
export const packingItemChecksTable = pgTable("packing_item_checks", {
  id: serial("id").primaryKey(),
  itemId: integer("item_id").notNull().references(() => packingItemsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  checked: boolean("checked").notNull().default(false),
}, (t) => [
  unique("packing_item_checks_item_user_unique").on(t.itemId, t.userId),
]);

export const insertPackingItemSchema = createInsertSchema(packingItemsTable).omit({ id: true });
export type InsertPackingItem = z.infer<typeof insertPackingItemSchema>;
export type PackingItem = typeof packingItemsTable.$inferSelect;

export const insertPackingItemCheckSchema = createInsertSchema(packingItemChecksTable).omit({ id: true });
export type InsertPackingItemCheck = z.infer<typeof insertPackingItemCheckSchema>;
export type PackingItemCheck = typeof packingItemChecksTable.$inferSelect;
