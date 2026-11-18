/**
 * Calendar write-back orchestration: keeps Google Calendar events in sync
 * with Wander itinerary items — reservations, flights, stays, and car
 * rentals (§6/§9: write-back covers every timeline item type).
 *
 * Rules:
 *   - Only accounts with write-back enabled AND the calendar.events scope
 *     granted are written to (updates respect the toggle; deletes always
 *     run so a removed booking never leaves a ghost event).
 *   - Events live on a dedicated "Wander" calendar per account.
 *   - Idempotency comes from `calendar_event_links` + payload hashes
 *     (see calendarEventMapping.planEventSync): re-syncing an unchanged
 *     item is a no-op; a changed item updates its existing event.
 *   - Everything here is best-effort: failures are logged, never thrown —
 *     a Google outage must not fail a booking accept/edit/delete request.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  tripsTable,
  reservationsTable,
  flightsTable,
  accommodationsTable,
  carRentalsTable,
  connectedAccountsTable,
  calendarEventLinksTable,
  type Accommodation,
  type CalendarEventLink,
  type CalendarItemType,
  type CarRental,
  type ConnectedAccount,
  type Flight,
  type Reservation,
} from "@workspace/db";
import { logger } from "./logger";
import { decryptToken } from "./credentialCrypto";
import { getAccountClient } from "./gmailScan";
import { hasCalendarScope } from "./scanLogic";
import {
  mapAccommodationToCalendarEvent,
  mapCarRentalToCalendarEvent,
  mapFlightToCalendarEvent,
  mapReservationToCalendarEvent,
  planEventSync,
  hashCalendarEventPayload,
  type GoogleCalendarEventPayload,
} from "./calendarEventMapping";
import {
  ensureWanderCalendar,
  findWanderCalendar,
  insertCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  GoogleCalendarError,
  type WanderCalendar,
} from "./googleCalendar";
import type { OAuth2Client } from "google-auth-library";

// ─── Item refs ───────────────────────────────────────────────────────────────

/** One itinerary item, tagged with its kind — the unit of write-back. */
export type CalendarItemRef =
  | { type: "reservation"; item: Reservation }
  | { type: "flight"; item: Flight }
  | { type: "accommodation"; item: Accommodation }
  | { type: "car_rental"; item: CarRental };

interface ItemKey {
  itemType: CalendarItemType;
  /** The link-table column carrying this kind's FK. */
  column: "reservationId" | "flightId" | "accommodationId" | "carRentalId";
  itemId: number;
  tripId: number;
}

function itemKey(ref: CalendarItemRef): ItemKey {
  switch (ref.type) {
    case "reservation":
      return { column: "reservationId", itemType: "reservation", itemId: ref.item.id, tripId: ref.item.tripId };
    case "flight":
      return { column: "flightId", itemType: "flight", itemId: ref.item.id, tripId: ref.item.tripId };
    case "accommodation":
      return { column: "accommodationId", itemType: "accommodation", itemId: ref.item.id, tripId: ref.item.tripId };
    case "car_rental":
      return { column: "carRentalId", itemType: "car_rental", itemId: ref.item.id, tripId: ref.item.tripId };
  }
}

/**
 * The link-table column carrying a kind's FK. Resolved lazily inside
 * functions (never at module load) so importing this module stays
 * side-effect-free for partial db mocks in unrelated suites.
 */
function linkColumn(itemType: CalendarItemType) {
  switch (itemType) {
    case "reservation":
      return calendarEventLinksTable.reservationId;
    case "flight":
      return calendarEventLinksTable.flightId;
    case "accommodation":
      return calendarEventLinksTable.accommodationId;
    case "car_rental":
      return calendarEventLinksTable.carRentalId;
  }
}

function mapItemToPayload(
  ref: CalendarItemRef,
  opts: { timeZone?: string; tripTitle?: string },
): GoogleCalendarEventPayload | null {
  switch (ref.type) {
    case "reservation":
      return mapReservationToCalendarEvent(ref.item, opts);
    case "flight":
      return mapFlightToCalendarEvent(ref.item, { tripTitle: opts.tripTitle });
    case "accommodation":
      return mapAccommodationToCalendarEvent(ref.item, { tripTitle: opts.tripTitle });
    case "car_rental":
      return mapCarRentalToCalendarEvent(ref.item, opts);
  }
}

// ─── Core sync ───────────────────────────────────────────────────────────────

async function loadTripTitle(tripId: number): Promise<string | undefined> {
  const [trip] = await db
    .select({ title: tripsTable.title })
    .from(tripsTable)
    .where(eq(tripsTable.id, tripId));
  return trip?.title;
}

/** Resolve (and remember) the account's Wander calendar. */
async function resolveCalendar(
  client: OAuth2Client,
  account: ConnectedAccount,
): Promise<WanderCalendar> {
  const found = await findWanderCalendar(client);
  const calendar = found ?? (await ensureWanderCalendar(client));
  if (account.calendarId !== calendar.id) {
    await db
      .update(connectedAccountsTable)
      .set({ calendarId: calendar.id })
      .where(eq(connectedAccountsTable.id, account.id));
  }
  return calendar;
}

/** Push one item to one account's Wander calendar (create/update/skip). */
async function syncItemToAccount(
  account: ConnectedAccount,
  ref: CalendarItemRef,
  tripTitle?: string,
): Promise<void> {
  const key = itemKey(ref);
  const client = await getAccountClient(decryptToken(account.encryptedRefreshToken));
  const calendar = await resolveCalendar(client, account);

  const payload: GoogleCalendarEventPayload | null = mapItemToPayload(ref, {
    timeZone: calendar.timeZone,
    tripTitle,
  });
  if (!payload) {
    logger.warn(
      { itemType: key.itemType, itemId: key.itemId },
      "[Calendar] item has no usable date — skipping write-back",
    );
    return;
  }

  const [link] = await db
    .select()
    .from(calendarEventLinksTable)
    .where(
      and(
        eq(calendarEventLinksTable.accountId, account.id),
        eq(linkColumn(key.itemType), key.itemId),
      ),
    );

  const plan = planEventSync(
    link ? { googleEventId: link.googleEventId, lastSyncedHash: link.lastSyncedHash } : null,
    payload,
  );
  if (plan.action === "skip") return;

  const hash = hashCalendarEventPayload(payload);

  if (plan.action === "create") {
    const eventId = await insertCalendarEvent(client, calendar.id, payload);
    await db
      .insert(calendarEventLinksTable)
      .values({
        userId: account.userId,
        accountId: account.id,
        itemType: key.itemType,
        reservationId: key.column === "reservationId" ? key.itemId : null,
        flightId: key.column === "flightId" ? key.itemId : null,
        accommodationId: key.column === "accommodationId" ? key.itemId : null,
        carRentalId: key.column === "carRentalId" ? key.itemId : null,
        googleCalendarId: calendar.id,
        googleEventId: eventId,
        lastSyncedHash: hash,
      })
      .onConflictDoNothing({
        target: [calendarEventLinksTable.accountId, linkColumn(key.itemType)],
      });
    logger.info(
      { accountId: account.id, itemType: key.itemType, itemId: key.itemId, eventId },
      "[Calendar] event created",
    );
    return;
  }

  // Update path — if the event was deleted inside Google, recreate it.
  try {
    await updateCalendarEvent(client, link!.googleCalendarId, plan.googleEventId, payload);
    await db
      .update(calendarEventLinksTable)
      .set({ lastSyncedHash: hash, updatedAt: new Date() })
      .where(eq(calendarEventLinksTable.id, link!.id));
  } catch (err) {
    if (err instanceof GoogleCalendarError && (err.status === 404 || err.status === 410)) {
      const eventId = await insertCalendarEvent(client, calendar.id, payload);
      await db
        .update(calendarEventLinksTable)
        .set({
          googleCalendarId: calendar.id,
          googleEventId: eventId,
          lastSyncedHash: hash,
          updatedAt: new Date(),
        })
        .where(eq(calendarEventLinksTable.id, link!.id));
      logger.info(
        { accountId: account.id, itemType: key.itemType, itemId: key.itemId, eventId },
        "[Calendar] event was gone in Google — recreated",
      );
      return;
    }
    throw err;
  }
  logger.info(
    { accountId: account.id, itemType: key.itemType, itemId: key.itemId },
    "[Calendar] event updated",
  );
}

/**
 * Write an item to every write-back-enabled Google account the user has
 * connected. Used when an item is created (manually or by the gate).
 */
export async function syncCalendarItemForUser(
  userId: number,
  ref: CalendarItemRef,
): Promise<void> {
  const key = itemKey(ref);
  try {
    const accounts = await db
      .select()
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.userId, userId),
          eq(connectedAccountsTable.calendarWritebackEnabled, true),
        ),
      );
    const eligible = accounts.filter((a) => hasCalendarScope(a.scopes));
    if (eligible.length === 0) return;
    const tripTitle = await loadTripTitle(key.tripId);
    for (const account of eligible) {
      try {
        await syncItemToAccount(account, ref, tripTitle);
      } catch (err) {
        logger.error(
          { userId, accountId: account.id, itemType: key.itemType, itemId: key.itemId, err },
          "[Calendar] write-back failed for account",
        );
      }
    }
  } catch (err) {
    logger.error(
      { userId, itemType: key.itemType, itemId: key.itemId, err },
      "[Calendar] write-back failed",
    );
  }
}

/**
 * Push an edited item to every account that already has an event for it
 * (regardless of who made the edit). Accounts whose write-back toggle is
 * now off are skipped — their event is left as-is.
 */
export async function updateLinkedCalendarEventsForItem(ref: CalendarItemRef): Promise<void> {
  const key = itemKey(ref);
  try {
    const links = await db
      .select()
      .from(calendarEventLinksTable)
      .where(eq(linkColumn(key.itemType), key.itemId));
    if (links.length === 0) return;
    const tripTitle = await loadTripTitle(key.tripId);
    for (const link of links) {
      try {
        const [account] = await db
          .select()
          .from(connectedAccountsTable)
          .where(eq(connectedAccountsTable.id, link.accountId));
        if (!account || !account.calendarWritebackEnabled || !hasCalendarScope(account.scopes)) {
          continue;
        }
        await syncItemToAccount(account, ref, tripTitle);
      } catch (err) {
        logger.error(
          { linkId: link.id, itemType: key.itemType, itemId: key.itemId, err },
          "[Calendar] linked event update failed",
        );
      }
    }
  } catch (err) {
    logger.error(
      { itemType: key.itemType, itemId: key.itemId, err },
      "[Calendar] linked update failed",
    );
  }
}

/**
 * Delete the Google events for an item. MUST be called before the item
 * row is deleted (the links cascade away with it). Runs for every link
 * regardless of the current toggle — a removed booking should never
 * leave a ghost event behind.
 */
export async function deleteLinkedCalendarEventsForItem(
  itemType: CalendarItemType,
  itemId: number,
): Promise<void> {
  try {
    const links = await db
      .select()
      .from(calendarEventLinksTable)
      .where(eq(linkColumn(itemType), itemId));
    for (const link of links) {
      try {
        const [account] = await db
          .select()
          .from(connectedAccountsTable)
          .where(eq(connectedAccountsTable.id, link.accountId));
        if (account && hasCalendarScope(account.scopes)) {
          const client = await getAccountClient(decryptToken(account.encryptedRefreshToken));
          await deleteCalendarEvent(client, link.googleCalendarId, link.googleEventId);
        }
      } catch (err) {
        logger.error(
          { linkId: link.id, itemType, itemId, err },
          "[Calendar] event delete failed (link will be removed anyway)",
        );
      }
    }
    await db
      .delete(calendarEventLinksTable)
      .where(eq(linkColumn(itemType), itemId));
  } catch (err) {
    logger.error({ itemType, itemId, err }, "[Calendar] linked delete failed");
  }
}

/**
 * Delete the Google events for link rows the CALLER has already
 * captured (and typically already unlinked inside its own
 * transaction — e.g. the booking gate removing a surplus flight row,
 * whose links cascade away with the row). No DB reads: the link rows
 * carry everything needed. Best-effort per link.
 */
export async function deleteCalendarEventsByLinks(
  links: Array<Pick<CalendarEventLink, "id" | "accountId" | "googleCalendarId" | "googleEventId">>,
): Promise<void> {
  for (const link of links) {
    try {
      const [account] = await db
        .select()
        .from(connectedAccountsTable)
        .where(eq(connectedAccountsTable.id, link.accountId));
      if (!account || !hasCalendarScope(account.scopes)) continue;
      const client = await getAccountClient(decryptToken(account.encryptedRefreshToken));
      await deleteCalendarEvent(client, link.googleCalendarId, link.googleEventId);
    } catch (err) {
      logger.error(
        { linkId: link.id, err },
        "[Calendar] event delete (by link) failed",
      );
    }
  }
}

// ─── Per-kind convenience wrappers ───────────────────────────────────────────

export async function syncReservationForUser(
  userId: number,
  reservation: Reservation,
): Promise<void> {
  return syncCalendarItemForUser(userId, { type: "reservation", item: reservation });
}

/** Convenience wrapper: load the reservation row, then sync for the user. */
export async function syncReservationByIdForUser(
  userId: number,
  reservationId: number,
): Promise<void> {
  const [reservation] = await db
    .select()
    .from(reservationsTable)
    .where(eq(reservationsTable.id, reservationId));
  if (reservation) await syncReservationForUser(userId, reservation);
}

export async function syncFlightForUser(userId: number, flight: Flight): Promise<void> {
  return syncCalendarItemForUser(userId, { type: "flight", item: flight });
}

export async function syncFlightByIdForUser(userId: number, flightId: number): Promise<void> {
  const [flight] = await db
    .select()
    .from(flightsTable)
    .where(eq(flightsTable.id, flightId));
  if (flight) await syncFlightForUser(userId, flight);
}

export async function syncAccommodationForUser(
  userId: number,
  accommodation: Accommodation,
): Promise<void> {
  return syncCalendarItemForUser(userId, { type: "accommodation", item: accommodation });
}

export async function syncAccommodationByIdForUser(
  userId: number,
  accommodationId: number,
): Promise<void> {
  const [accommodation] = await db
    .select()
    .from(accommodationsTable)
    .where(eq(accommodationsTable.id, accommodationId));
  if (accommodation) await syncAccommodationForUser(userId, accommodation);
}

export async function syncCarRentalForUser(userId: number, carRental: CarRental): Promise<void> {
  return syncCalendarItemForUser(userId, { type: "car_rental", item: carRental });
}

export async function syncCarRentalByIdForUser(
  userId: number,
  carRentalId: number,
): Promise<void> {
  const [carRental] = await db
    .select()
    .from(carRentalsTable)
    .where(eq(carRentalsTable.id, carRentalId));
  if (carRental) await syncCarRentalForUser(userId, carRental);
}

/** Reservation-shaped wrapper kept for existing callers. */
export async function updateLinkedCalendarEvents(reservation: Reservation): Promise<void> {
  return updateLinkedCalendarEventsForItem({ type: "reservation", item: reservation });
}

/** Reservation-shaped wrapper kept for existing callers. */
export async function deleteLinkedCalendarEvents(reservationId: number): Promise<void> {
  return deleteLinkedCalendarEventsForItem("reservation", reservationId);
}
