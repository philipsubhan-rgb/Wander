/**
 * Google Calendar REST access for write-back.
 *
 * Raw Calendar API via fetch (same approach as gmailScan — no googleapis
 * dependency). Auth comes from the connected account's OAuth2Client
 * (getAccountClient in gmailScan), which needs the calendar.events scope.
 */

import type { OAuth2Client } from "google-auth-library";
import { logger } from "./logger";
import type { GoogleCalendarEventPayload } from "./calendarEventMapping";

const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
export const WANDER_CALENDAR_NAME = "Wander";

export class GoogleCalendarError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function calendarFetch(
  client: OAuth2Client,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const { token } = await client.getAccessToken();
  const res = await fetch(`${CALENDAR_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GoogleCalendarError(
      res.status,
      `Google Calendar API ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return res.json();
}

export interface WanderCalendar {
  id: string;
  timeZone?: string;
}

interface CalendarListEntry {
  id: string;
  summary?: string;
  timeZone?: string;
  accessRole?: string;
}

/** Find the dedicated "Wander" calendar on the account, if it exists. */
export async function findWanderCalendar(
  client: OAuth2Client,
): Promise<WanderCalendar | null> {
  let pageToken: string | undefined;
  do {
    const qs = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
    const list = await calendarFetch(client, `/users/me/calendarList${qs}`);
    const entry = ((list.items ?? []) as CalendarListEntry[]).find(
      (c) =>
        c.summary === WANDER_CALENDAR_NAME &&
        (c.accessRole === "owner" || c.accessRole === "writer"),
    );
    if (entry) return { id: entry.id, timeZone: entry.timeZone };
    pageToken = list.nextPageToken;
  } while (pageToken);
  return null;
}

/** Create the dedicated "Wander" calendar. */
export async function createWanderCalendar(
  client: OAuth2Client,
): Promise<WanderCalendar> {
  const created = await calendarFetch(client, `/calendars`, {
    method: "POST",
    body: JSON.stringify({
      summary: WANDER_CALENDAR_NAME,
      description: "Bookings written back by Wander",
    }),
  });
  logger.info({ calendarId: created.id }, "[Calendar] created Wander calendar");
  return { id: created.id as string, timeZone: created.timeZone as string | undefined };
}

/** Find the Wander calendar or create it on first use. */
export async function ensureWanderCalendar(
  client: OAuth2Client,
): Promise<WanderCalendar> {
  return (await findWanderCalendar(client)) ?? (await createWanderCalendar(client));
}

/** Insert an event; returns the new Google event ID. */
export async function insertCalendarEvent(
  client: OAuth2Client,
  calendarId: string,
  payload: GoogleCalendarEventPayload,
): Promise<string> {
  const created = await calendarFetch(
    client,
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return created.id as string;
}

/** Replace an event's contents (full PUT — our payload is complete). */
export async function updateCalendarEvent(
  client: OAuth2Client,
  calendarId: string,
  eventId: string,
  payload: GoogleCalendarEventPayload,
): Promise<void> {
  await calendarFetch(
    client,
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: "PUT", body: JSON.stringify(payload) },
  );
}

/** Delete an event. Already-gone (404/410) counts as success. */
export async function deleteCalendarEvent(
  client: OAuth2Client,
  calendarId: string,
  eventId: string,
): Promise<void> {
  try {
    await calendarFetch(
      client,
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" },
    );
  } catch (err) {
    if (err instanceof GoogleCalendarError && (err.status === 404 || err.status === 410)) {
      return;
    }
    throw err;
  }
}
