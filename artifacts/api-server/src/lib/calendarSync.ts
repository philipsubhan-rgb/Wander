/**
 * Calendar write-back orchestration: keeps Google Calendar events in sync
 * with Wander reservations.
 *
 * Rules:
 *   - Only accounts with write-back enabled AND the calendar.events scope
 *     granted are written to (updates respect the toggle; deletes always
 *     run so a removed booking never leaves a ghost event).
 *   - Events live on a dedicated "Wander" calendar per account.
 *   - Idempotency comes from `calendar_event_links` + payload hashes
 *     (see calendarEventMapping.planEventSync): re-syncing an unchanged
 *     booking is a no-op; a changed booking updates its existing event.
 *   - Everything here is best-effort: failures are logged, never thrown —
 *     a Google outage must not fail a booking accept/edit/delete request.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  tripsTable,
  reservationsTable,
  connectedAccountsTable,
  calendarEventLinksTable,
  type ConnectedAccount,
  type Reservation,
} from "@workspace/db";
import { logger } from "./logger";
import { decryptToken } from "./credentialCrypto";
import { getAccountClient } from "./gmailScan";
import { hasCalendarScope } from "./scanLogic";
import {
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

/** Push one reservation to one account's Wander calendar (create/update/skip). */
async function syncToAccount(
  account: ConnectedAccount,
  reservation: Reservation,
  tripTitle?: string,
): Promise<void> {
  const client = await getAccountClient(decryptToken(account.encryptedRefreshToken));
  const calendar = await resolveCalendar(client, account);

  const payload: GoogleCalendarEventPayload | null = mapReservationToCalendarEvent(
    reservation,
    { timeZone: calendar.timeZone, tripTitle },
  );
  if (!payload) {
    logger.warn(
      { reservationId: reservation.id },
      "[Calendar] reservation has no usable date — skipping write-back",
    );
    return;
  }

  const [link] = await db
    .select()
    .from(calendarEventLinksTable)
    .where(
      and(
        eq(calendarEventLinksTable.accountId, account.id),
        eq(calendarEventLinksTable.reservationId, reservation.id),
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
        reservationId: reservation.id,
        googleCalendarId: calendar.id,
        googleEventId: eventId,
        lastSyncedHash: hash,
      })
      .onConflictDoNothing({
        target: [calendarEventLinksTable.accountId, calendarEventLinksTable.reservationId],
      });
    logger.info(
      { accountId: account.id, reservationId: reservation.id, eventId },
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
        { accountId: account.id, reservationId: reservation.id, eventId },
        "[Calendar] event was gone in Google — recreated",
      );
      return;
    }
    throw err;
  }
  logger.info(
    { accountId: account.id, reservationId: reservation.id },
    "[Calendar] event updated",
  );
}

/**
 * Write a reservation to every write-back-enabled Google account the user
 * has connected. Used when a booking is accepted or created.
 */
export async function syncReservationForUser(
  userId: number,
  reservation: Reservation,
): Promise<void> {
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
    const tripTitle = await loadTripTitle(reservation.tripId);
    for (const account of eligible) {
      try {
        await syncToAccount(account, reservation, tripTitle);
      } catch (err) {
        logger.error(
          { userId, accountId: account.id, reservationId: reservation.id, err },
          "[Calendar] write-back failed for account",
        );
      }
    }
  } catch (err) {
    logger.error({ userId, reservationId: reservation.id, err }, "[Calendar] write-back failed");
  }
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

/**
 * Push an edited reservation to every account that already has an event for
 * it (regardless of who made the edit). Accounts whose write-back toggle is
 * now off are skipped — their event is left as-is.
 */
export async function updateLinkedCalendarEvents(reservation: Reservation): Promise<void> {
  try {
    const links = await db
      .select()
      .from(calendarEventLinksTable)
      .where(eq(calendarEventLinksTable.reservationId, reservation.id));
    if (links.length === 0) return;
    const tripTitle = await loadTripTitle(reservation.tripId);
    for (const link of links) {
      try {
        const [account] = await db
          .select()
          .from(connectedAccountsTable)
          .where(eq(connectedAccountsTable.id, link.accountId));
        if (!account || !account.calendarWritebackEnabled || !hasCalendarScope(account.scopes)) {
          continue;
        }
        await syncToAccount(account, reservation, tripTitle);
      } catch (err) {
        logger.error(
          { linkId: link.id, reservationId: reservation.id, err },
          "[Calendar] linked event update failed",
        );
      }
    }
  } catch (err) {
    logger.error({ reservationId: reservation.id, err }, "[Calendar] linked update failed");
  }
}

/**
 * Delete the Google events for a reservation. MUST be called before the
 * reservation row is deleted (the links cascade away with it). Runs for
 * every link regardless of the current toggle — a removed booking should
 * never leave a ghost event behind.
 */
export async function deleteLinkedCalendarEvents(reservationId: number): Promise<void> {
  try {
    const links = await db
      .select()
      .from(calendarEventLinksTable)
      .where(eq(calendarEventLinksTable.reservationId, reservationId));
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
          { linkId: link.id, reservationId, err },
          "[Calendar] event delete failed (link will be removed anyway)",
        );
      }
    }
    await db
      .delete(calendarEventLinksTable)
      .where(eq(calendarEventLinksTable.reservationId, reservationId));
  } catch (err) {
    logger.error({ reservationId, err }, "[Calendar] linked delete failed");
  }
}
