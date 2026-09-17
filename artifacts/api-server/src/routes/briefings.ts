/**
 * Daily briefing routes.
 *
 *   GET  /trips/:tripId/briefing            — briefing settings (or defaults)
 *   PUT  /trips/:tripId/briefing            — upsert settings (trip admin)
 *   POST /trips/:tripId/briefing/send-now   — send immediately (trip admin)
 *   GET  /trips/:tripId/briefing/preview.pdf — render the PDF inline
 *
 * Briefing endpoints are not part of the OpenAPI spec yet, so the zod
 * schemas live here rather than in @workspace/api-zod (generated files
 * must not be edited by hand).
 */

import { Router, type IRouter } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import {
  db,
  tripBriefingsTable,
  tripsTable,
  type TripBriefing,
  type Trip,
} from "@workspace/db";
import { requireTripAdmin, requireTripParticipant } from "../middlewares/auth";
import {
  attachWeather,
  isValidTimeZone,
  sendTripBriefing,
  todayInZone,
} from "../lib/briefingScheduler.js";
import { buildDaySheet } from "../lib/daySheet.js";
import { renderDaySheetPdf } from "../lib/daySheetPdf.js";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TripIdParams = z.object({
  tripId: z.coerce.number(),
});

const BriefingBody = z.object({
  enabled: z.boolean(),
  sendTimeLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  timezone: z.string().refine(isValidTimeZone, "Invalid IANA timezone"),
  extraEmails: z.array(z.string().email()).max(10).default([]),
});

const DateQueryParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// ---------------------------------------------------------------------------
// Defaults & serialization
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  enabled: false,
  sendTimeLocal: "07:00",
  timezone: "America/New_York",
  extraEmails: [] as string[],
  lastSentForDate: null as string | null,
};

function serializeBriefing(row: TripBriefing) {
  return {
    id: row.id,
    tripId: row.tripId,
    enabled: row.enabled,
    sendTimeLocal: row.sendTimeLocal,
    timezone: row.timezone,
    extraEmails: row.extraEmails,
    cachedLat: row.cachedLat,
    cachedLon: row.cachedLon,
    lastSentForDate: row.lastSentForDate,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Transient defaults used when no briefing row exists yet. `id` is left
 * unset on purpose — sendTripBriefing skips persistence steps when the row
 * has no id, so nothing is created in the database.
 */
function defaultBriefing(tripId: number): TripBriefing {
  return {
    id: undefined as unknown as number,
    tripId,
    cachedLat: null,
    cachedLon: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...DEFAULT_SETTINGS,
  };
}

async function loadTripOr404(tripId: number): Promise<Trip | null> {
  const [trip] = await db
    .select()
    .from(tripsTable)
    .where(eq(tripsTable.id, tripId));
  return trip ?? null;
}

/**
 * The date a manual preview / test-send renders when no ?date= is given:
 * today while the trip is running, otherwise the trip's first day so the
 * preview is never a blank page outside the travel window.
 */
function defaultBriefingDate(trip: Trip, briefing: TripBriefing): string {
  const today = todayInZone(briefing.timezone || "America/New_York");
  const start = trip.startDate.substring(0, 10);
  const end = trip.endDate.substring(0, 10);
  if (today >= start && today <= end) return today;
  return start;
}

/** Parse ?date=; 400 on invalid, otherwise the value or the fallback. */
function resolveDateParam(
  req: { query: { date?: unknown } },
  fallback: () => string,
  res: { status: (code: number) => { json: (body: unknown) => void } }
): string | null {
  const raw = req.query.date;
  if (raw === undefined) return fallback();
  const parsed = DateQueryParam.safeParse(raw);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid date — expected YYYY-MM-DD" });
    return null;
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Any participant can read the briefing settings; a missing row returns defaults.
router.get(
  "/trips/:tripId/briefing",
  requireTripParticipant("tripId"),
  async (req, res): Promise<void> => {
    const params = TripIdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid tripId" });
      return;
    }

    const [row] = await db
      .select()
      .from(tripBriefingsTable)
      .where(eq(tripBriefingsTable.tripId, params.data.tripId));

    if (!row) {
      res.json({ tripId: params.data.tripId, ...DEFAULT_SETTINGS });
      return;
    }
    res.json(serializeBriefing(row));
  }
);

// Trip admins can create/update the briefing settings (upsert by tripId).
router.put(
  "/trips/:tripId/briefing",
  requireTripAdmin("tripId"),
  async (req, res): Promise<void> => {
    const params = TripIdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid tripId" });
      return;
    }
    const tripId = params.data.tripId;

    const body = BriefingBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const trip = await loadTripOr404(tripId);
    if (!trip) {
      res.status(404).json({ error: "Trip not found" });
      return;
    }

    const [existing] = await db
      .select()
      .from(tripBriefingsTable)
      .where(eq(tripBriefingsTable.tripId, tripId));

    let row: TripBriefing | undefined;
    if (existing) {
      [row] = await db
        .update(tripBriefingsTable)
        .set({ ...body.data, updatedAt: new Date() })
        .where(eq(tripBriefingsTable.id, existing.id))
        .returning();
    } else {
      [row] = await db
        .insert(tripBriefingsTable)
        .values({ tripId, ...body.data })
        .returning();
    }

    res.json(serializeBriefing(row!));
  }
);

// Trip admins can force-send the briefing for a date. Unlike the scheduler
// tick, this skips the status/date-range gating — the admin explicitly asked.
router.post(
  "/trips/:tripId/briefing/send-now",
  requireTripAdmin("tripId"),
  async (req, res): Promise<void> => {
    const params = TripIdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid tripId" });
      return;
    }
    const tripId = params.data.tripId;

    const trip = await loadTripOr404(tripId);
    if (!trip) {
      res.status(404).json({ error: "Trip not found" });
      return;
    }

    const [briefingRow] = await db
      .select()
      .from(tripBriefingsTable)
      .where(eq(tripBriefingsTable.tripId, tripId));
    const briefing = briefingRow ?? defaultBriefing(tripId);

    const dateISO = resolveDateParam(
      req,
      () => defaultBriefingDate(trip, briefing),
      res
    );
    if (dateISO === null) return;

    const result = await sendTripBriefing(briefing, trip, dateISO);
    res.json({ sent: result.sent, recipientCount: result.recipientCount });
  }
);

// Any participant can preview the PDF inline for a date.
router.get(
  "/trips/:tripId/briefing/preview.pdf",
  requireTripParticipant("tripId"),
  async (req, res): Promise<void> => {
    const params = TripIdParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: "Invalid tripId" });
      return;
    }
    const tripId = params.data.tripId;

    const trip = await loadTripOr404(tripId);
    if (!trip) {
      res.status(404).json({ error: "Trip not found" });
      return;
    }

    const [briefingRow] = await db
      .select()
      .from(tripBriefingsTable)
      .where(eq(tripBriefingsTable.tripId, tripId));
    const briefing = briefingRow ?? defaultBriefing(tripId);

    const dateISO = resolveDateParam(
      req,
      () => defaultBriefingDate(trip, briefing),
      res
    );
    if (dateISO === null) return;

    const sheet = await buildDaySheet(trip.id, dateISO);
    await attachWeather(sheet, briefing, trip, dateISO);
    const pdf = await renderDaySheetPdf(sheet);

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="wander-preview-${tripId}-${dateISO}.pdf"`
    );
    res.send(pdf);
  }
);

export default router;
