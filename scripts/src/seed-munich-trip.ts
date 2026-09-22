/**
 * Seed the Munich Oktoberfest 2026 guys trip into the database.
 *
 * Purpose: give Marco (Stage 1) real trip data to answer questions from in
 * the dev/preview environment, whose database doesn't track prod.
 *
 * Usage (in the Replit shell, dev environment):
 *   pnpm --filter @workspace/scripts seed:munich
 *   pnpm --filter @workspace/scripts seed:munich -- --user someusername
 *
 * Idempotent: finds the Munich trip by destination, wipes its child rows
 * (reservations, flights, stays, itinerary days, car rentals) and re-inserts
 * everything below. Safe to re-run.
 *
 * Reads DATABASE_URL from the environment (already set in the Replit dev env).
 */
import { eq, ilike } from "drizzle-orm";
import {
  db,
  pool,
  tripsTable,
  tripParticipantsTable,
  reservationsTable,
  flightsTable,
  accommodationsTable,
  itineraryDaysTable,
  carRentalsTable,
  usersTable,
} from "@workspace/db";

const userArg = process.argv.indexOf("--user");
const preferredUsername = userArg >= 0 ? process.argv[userArg + 1] : undefined;

async function resolveUserId(): Promise<number> {
  const users = await db.select().from(usersTable);
  if (users.length === 0) throw new Error("No users in database — cannot link trip.");
  if (preferredUsername) {
    const match = users.find(
      (u) => u.username.toLowerCase() === preferredUsername.toLowerCase(),
    );
    if (!match) {
      throw new Error(
        `User "${preferredUsername}" not found. Available: ${users.map((u) => u.username).join(", ")}`,
      );
    }
    return match.id;
  }
  const admin = users.find((u) => u.role === "super_admin") ?? users[0];
  console.log(`Linking trip to user "${admin.username}" (pass --user <username> to override).`);
  return admin.id;
}

async function main() {
  const userId = await resolveUserId();

  // Find or create the Munich trip.
  const existing = await db
    .select()
    .from(tripsTable)
    .where(ilike(tripsTable.destination, "%munich%"))
    .limit(1);

  let tripId: number;
  if (existing.length > 0) {
    tripId = existing[0].id;
    console.log(`Found existing Munich trip (id=${tripId}) — refreshing its data.`);
    await db.update(tripsTable).set({
      title: "Munich Oktoberfest 2026",
      destination: "Munich, Germany",
      startDate: "2026-09-23",
      endDate: "2026-09-28",
      status: "confirmed",
      description: "Guys' trip to Munich for Oktoberfest — 4 travelers.",
    }).where(eq(tripsTable.id, tripId));
    // Wipe child rows for a clean re-seed.
    await db.delete(reservationsTable).where(eq(reservationsTable.tripId, tripId));
    await db.delete(flightsTable).where(eq(flightsTable.tripId, tripId));
    await db.delete(accommodationsTable).where(eq(accommodationsTable.tripId, tripId));
    await db.delete(itineraryDaysTable).where(eq(itineraryDaysTable.tripId, tripId));
    await db.delete(carRentalsTable).where(eq(carRentalsTable.tripId, tripId));
  } else {
    const [trip] = await db.insert(tripsTable).values({
      title: "Munich Oktoberfest 2026",
      destination: "Munich, Germany",
      startDate: "2026-09-23",
      endDate: "2026-09-28",
      status: "confirmed",
      description: "Guys' trip to Munich for Oktoberfest — 4 travelers.",
    }).returning({ id: tripsTable.id });
    tripId = trip.id;
    console.log(`Created Munich trip (id=${tripId}).`);
  }

  await db.insert(tripParticipantsTable).values({
    tripId, userId, isTripAdmin: true,
  }).onConflictDoNothing();

  // Flights — United PNR JQZZ2H
  await db.insert(flightsTable).values([
    {
      tripId, flightNumber: "UA30", airline: "United",
      departureAirport: "EWR", arrivalAirport: "MUC",
      departureDatetime: "2026-09-23 17:00", departureTimezone: "America/New_York",
      arrivalDatetime: "2026-09-24 07:10", arrivalTimezone: "Europe/Berlin",
      confirmationCode: "JQZZ2H", direction: "outbound", passengerCount: 4,
      notes: "United PNR JQZZ2H covers UA30+UA31.",
    },
    {
      tripId, flightNumber: "UA31", airline: "United",
      departureAirport: "MUC", arrivalAirport: "EWR",
      departureDatetime: "2026-09-28 09:50", departureTimezone: "Europe/Berlin",
      arrivalDatetime: "2026-09-28 13:00", arrivalTimezone: "America/New_York",
      confirmationCode: "JQZZ2H", direction: "return", passengerCount: 4,
      notes: "United PNR JQZZ2H covers UA30+UA31.",
    },
  ]);

  // Hotel
  await db.insert(accommodationsTable).values({
    tripId, name: "The Westin Grand Munich", type: "hotel",
    address: "Munich, Germany",
    checkIn: "2026-09-24", checkOut: "2026-09-28",
    notes: "Guys' trip base for Sep 24–27.",
  });

  // Rental car — Sixt 9739037749
  await db.insert(carRentalsTable).values({
    tripId, company: "Sixt", carType: "suv",
    pickupLocation: "Munich Airport, Terminalstr. Mitte/MWZ",
    pickupDatetime: "2026-09-24 08:00",
    dropoffLocation: "Munich Airport, Terminalstr. Mitte/MWZ",
    dropoffDatetime: "2026-09-28 08:00",
    confirmationCode: "9739037749", driverName: "Philip Subhan",
    notes: "BMW X5 xDrive. Austrian digital vignette needed only if Salzburg alternate is chosen.",
  });

  // Reservations
  await db.insert(reservationsTable).values([
    {
      tripId, type: "restaurant", title: "Schneider Bräuhaus", venue: "Schneider Bräuhaus",
      address: "Tal 7, München", date: "2026-09-24", time: "19:30",
      confirmationCode: "125113", numberOfPeople: 5,
      notes: "Party changed from 4 to 5 in the OpenTable app on Sep 21.",
      sortOrder: 1,
    },
    {
      tripId, type: "attraction", title: "BMW Welt", venue: "BMW Welt",
      date: "2026-09-24", time: "15:00",
      notes: "Group BMW contact handles access.", sortOrder: 2,
    },
    {
      tripId, type: "attraction", title: "Dachau Memorial", venue: "Dachau Concentration Camp Memorial",
      date: "2026-09-25", time: "09:00",
      notes: "Morning visit before Oktoberfest.", sortOrder: 3,
    },
    {
      tripId, type: "restaurant", title: "Augustiner-Keller", venue: "Augustiner-Keller",
      date: "2026-09-25", time: "13:45", numberOfPeople: 4,
      notes: "Walk-in lunch; leave by 14:55 for the Festzelt guide meet.",
      sortOrder: 4,
    },
    {
      tripId, type: "event", title: "Hofbräu Festzelt — Oktoberfest", venue: "Hofbräu Festzelt, Oktoberfest",
      date: "2026-09-25", time: "15:20", numberOfPeople: 4,
      notes: "Via Oktoberfest Experiences. Meet guides 3:20 PM SHARP at August-Kühn-Strasse 11 courtyard (by the bike racks, Flower sign) — do NOT go to the tent directly. Late arrival = canceled, no refund. Agency +1-404-846-8466, Munich staff +1-404-229-7111.",
      sortOrder: 5,
    },
    {
      tripId, type: "attraction", title: "Neuschwanstein Castle timed entry", venue: "Neuschwanstein Castle",
      date: "2026-09-26", time: "12:00", numberOfPeople: 4,
      confirmationCode: "GYGZGZRLXQ5V",
      notes: "GetYourGuide, $267.92 auto-charged Sep 23. Free cancellation until noon Sep 25.",
      sortOrder: 6,
    },
    {
      tripId, type: "restaurant", title: "Zum Hechten", venue: "Zum Hechten",
      address: "Ritterstr. 6, Füssen", date: "2026-09-26", time: "14:45",
      numberOfPeople: 4, notes: "Confirmed by phone on Sep 21.", sortOrder: 7,
    },
    {
      tripId, type: "restaurant", title: "Grill im Künstlerhaus", venue: "Grill im Künstlerhaus",
      date: "2026-09-26", time: "20:30",
      confirmationCode: "2109847960", numberOfPeople: 4, sortOrder: 8,
    },
    {
      tripId, type: "restaurant", title: "Acquarello", venue: "Acquarello",
      date: "2026-09-27", time: "19:30",
      confirmationCode: "1711", numberOfPeople: 4,
      notes: "Farewell dinner.", sortOrder: 9,
    },
  ]);

  // Itinerary days
  await db.insert(itineraryDaysTable).values([
    {
      tripId, date: "2026-09-24", title: "Arrival + Munich old town",
      description: "Land 7:10 AM, pick up Sixt X5 at 8:00 AM.",
      notes: "Marienplatz/Frauenkirche, Viktualienmarkt lunch, BMW Welt 3:00 PM, Schneider Bräuhaus dinner 7:30 PM.",
    },
    {
      tripId, date: "2026-09-25", title: "Dachau + Oktoberfest",
      description: "Dachau in the morning, Festzelt in the afternoon.",
      notes: "Dachau ~9:00 AM. Westin 12:30–1:15 PM to change into Trachten. Augustiner-Keller walk-in 1:45 PM, leave by 2:55 PM. Hofbräu Festzelt guide meet 3:20 PM SHARP at August-Kühn-Strasse 11.",
    },
    {
      tripId, date: "2026-09-26", title: "Neuschwanstein + Deutsche Alpenstraße",
      description: "Castle day with alpine-road return.",
      notes: "Leave Munich ~10:00 AM. Neuschwanstein 12:00 PM handover. Zum Hechten Füssen 2:45 PM. Deutsche Alpenstraße joyride back, Munich ~7:00–7:30 PM. Grill im Künstlerhaus 8:30 PM.",
    },
    {
      tripId, date: "2026-09-27", title: "Tegernsee + Kloster Andechs",
      description: "Lake morning, monastery afternoon, farewell dinner.",
      notes: "Tegernsee morning, lakeside lunch, Kloster Andechs ~2:00 PM, alpine-road return. Acquarello farewell dinner 7:30 PM.",
    },
  ]);

  console.log(`Seeded Munich trip (id=${tripId}): 2 flights, 1 hotel, 1 car rental, 9 reservations, 4 itinerary days.`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
