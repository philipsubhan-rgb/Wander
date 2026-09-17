import { pgTable, serial, text, integer, pgEnum, boolean, numeric } from "drizzle-orm/pg-core";
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
  departureDatetime: text("departure_datetime").notNull(), // airport-local wall-clock "YYYY-MM-DDTHH:mm"
  arrivalDatetime: text("arrival_datetime").notNull(),     // airport-local wall-clock "YYYY-MM-DDTHH:mm"
  departureTimezone: text("departure_timezone"), // IANA zone of the departure airport, e.g. "America/New_York"
  arrivalTimezone: text("arrival_timezone"),     // IANA zone of the arrival airport
  confirmationCode: text("confirmation_code"),
  notes: text("notes"),
  direction: flightDirectionEnum("direction").notNull().default("outbound"),
  // Structured fare / pricing fields
  totalPrice: numeric("total_price", { precision: 12, scale: 2 }), // total for all passengers
  currency: text("currency").notNull().default("USD"),
  fareBrand: text("fare_brand"),       // e.g. "Main Cabin", "Economy"
  refundable: boolean("refundable"),
  changeable: boolean("changeable"),
  checkedBags: text("checked_bags"),   // e.g. "2 checked bags included"
  passengerCount: integer("passenger_count"),
});

export const insertFlightSchema = createInsertSchema(flightsTable).omit({ id: true });
export type InsertFlight = z.infer<typeof insertFlightSchema>;
export type Flight = typeof flightsTable.$inferSelect;
