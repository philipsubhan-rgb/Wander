import { pgTable, serial, text, integer, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { tripsTable } from "./trips";

export const flightDirectionEnum = pgEnum("flight_direction", ["outbound", "return", "connecting"]);

export const flightsTable = pgTable("flights", {
  id: serial("id").primaryKey(),
  tripId: integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  flightNumber: text("flight_number").notNull(),
  airline: text("airline").notNull(),
  departureAirport: text("departure_airport").notNull(),
  arrivalAirport: text("arrival_airport").notNull(),
  departureDatetime: text("departure_datetime").notNull(),
  arrivalDatetime: text("arrival_datetime").notNull(),
  confirmationCode: text("confirmation_code"),
  notes: text("notes"),
  direction: flightDirectionEnum("direction").notNull().default("outbound"),
});

export const insertFlightSchema = createInsertSchema(flightsTable).omit({ id: true });
export type InsertFlight = z.infer<typeof insertFlightSchema>;
export type Flight = typeof flightsTable.$inferSelect;
