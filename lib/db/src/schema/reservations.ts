import { pgTable, serial, text, integer, pgEnum, doublePrecision } from "drizzle-orm/pg-core";
import { tripsTable } from "./trips";

export const reservationTypeEnum = pgEnum("reservation_type", [
  "restaurant", "attraction", "tour", "transport", "event", "spa", "other",
]);

export const reservationsTable = pgTable("reservations", {
  id:               serial("id").primaryKey(),
  tripId:           integer("trip_id").notNull().references(() => tripsTable.id, { onDelete: "cascade" }),
  type:             reservationTypeEnum("type").notNull().default("other"),
  title:            text("title").notNull(),
  venue:            text("venue"),
  address:          text("address"),
  date:             text("date").notNull(),
  time:             text("time"),
  endTime:          text("end_time"),
  confirmationCode: text("confirmation_code"),
  numberOfPeople:   integer("number_of_people"),
  phone:            text("phone"),
  notes:            text("notes"),
  url:              text("url"),
  imageUrl:         text("image_url"),
  lat:              doublePrecision("lat"),
  lon:              doublePrecision("lon"),
});

export type Reservation = typeof reservationsTable.$inferSelect;
