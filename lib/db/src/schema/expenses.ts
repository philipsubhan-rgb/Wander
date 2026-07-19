import { pgTable, serial, text, integer, pgEnum, boolean, numeric, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tripsTable } from "./trips";
import { usersTable } from "./users";

export const expenseCategoryEnum = pgEnum("expense_category", [
  "travel",
  "activity",
  "restaurant",
  "car_rental",
  "accommodation",
  "other",
]);

export const tripExpensesTable = pgTable("trip_expenses", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  paidByUserId: integer("paid_by_user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("USD"),
  description: text("description").notNull(),
  category: expenseCategoryEnum("category").notNull().default("other"),
  date: text("date").notNull(), // ISO date string YYYY-MM-DD
  notes: text("notes"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const expenseSplitsTable = pgTable("expense_splits", {
  id: serial("id").primaryKey(),
  expenseId: integer("expense_id").notNull().references(() => tripExpensesTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  shareAmount: numeric("share_amount", { precision: 12, scale: 2 }).notNull(),
  isPaid: boolean("is_paid").notNull().default(false),
  paidAt: timestamp("paid_at"),
});

export const insertExpenseSchema = createInsertSchema(tripExpensesTable).omit({ id: true, createdAt: true });
export type InsertExpense = z.infer<typeof insertExpenseSchema>;
export type TripExpense = typeof tripExpensesTable.$inferSelect;
export type ExpenseSplit = typeof expenseSplitsTable.$inferSelect;
