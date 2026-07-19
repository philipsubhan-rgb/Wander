import { type Request, type Response, type NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { db, tripParticipantsTable } from "@workspace/db";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.session?.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (req.session.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

/**
 * Middleware factory for trip-scoped content edits.
 * Passes through if the user is a global admin OR any participant of the trip
 * (regardless of isTripAdmin). Use this for flights, activities, etc.
 *
 * @param tripIdParam - the name of the route param that holds the tripId (default: 'tripId')
 */
export function requireTripParticipant(tripIdParam = "tripId") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session?.userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (req.session.role === "admin") { next(); return; }

    const rawParam = req.params[tripIdParam];
    const tripId = parseInt(Array.isArray(rawParam) ? rawParam[0] : rawParam);
    if (isNaN(tripId)) { res.status(400).json({ error: "Invalid tripId" }); return; }

    try {
      const [participant] = await db
        .select()
        .from(tripParticipantsTable)
        .where(and(
          eq(tripParticipantsTable.tripId, tripId),
          eq(tripParticipantsTable.userId, req.session.userId!),
        ));
      if (!participant) { res.status(403).json({ error: "Trip access required" }); return; }
      next();
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  };
}

/**
 * Middleware factory for trip-scoped admin actions.
 * Passes through if:
 *   - the user is a global admin (role = 'admin'), OR
 *   - the user is a participant of the trip with isTripAdmin = true
 *
 * @param tripIdParam - the name of the route param that holds the tripId (default: 'tripId')
 */
export function requireTripAdmin(tripIdParam = "tripId") {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.session?.userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    // Global admins always pass
    if (req.session.role === "admin") {
      next();
      return;
    }

    const rawParam2 = req.params[tripIdParam];
    const tripId = parseInt(Array.isArray(rawParam2) ? rawParam2[0] : rawParam2);
    if (isNaN(tripId)) {
      res.status(400).json({ error: "Invalid tripId" });
      return;
    }

    try {
      const [participant] = await db
        .select()
        .from(tripParticipantsTable)
        .where(
          and(
            eq(tripParticipantsTable.tripId, tripId),
            eq(tripParticipantsTable.userId, req.session.userId!),
            eq(tripParticipantsTable.isTripAdmin, true),
          )
        );

      if (!participant) {
        res.status(403).json({ error: "Trip admin access required" });
        return;
      }

      next();
    } catch {
      res.status(500).json({ error: "Internal server error" });
    }
  };
}
