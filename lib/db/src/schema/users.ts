import { pgTable, serial, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userRoleEnum = pgEnum("user_role", ["admin", "traveler"]);

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  username: text("username").notNull().unique(),
  name: text("name").notNull(),
  email: text("email"),
  role: userRoleEnum("role").notNull().default("traveler"),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
