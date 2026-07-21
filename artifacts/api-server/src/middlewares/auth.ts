import { type Request, type Response, type NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { db, tripParticipantsTable } from "@workspace/db";
import { verifyAuthToken } from "../routes/auth";

// ---------------------------------------------------------------------------
// Extend Express locals to carry bearer-auth context (request-scoped only,
// never written to the session store).
// ---------------------------------------------------------------------------
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      bearerAuth?: { userId: number; role: string };
    }
  }
}

/**
 * Populate res.locals.bearerAuth from a Bearer token when no session cookie
 * is present. This lets native Expo Go clients authenticate with a JWT
 * without creating or touching any session-store records.
 */
async function applyBearerToken(req: Request, res: Response): Promise<void> {
  if (req.session?.userId) return; // session already authenticated — nothing to do

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return;

  const token = authHeader.slice(7);
  const payload = verifyAuthToken(token);
  if (!payload) return;

  // Store on res.locals — request-scoped, never persisted to the session table
  res.locals.bearerAuth = { userId: payload.userId, role: payload.role };
}

/** Resolve the authenticated userId from session OR bearer token. */
export function getAuthUserId(req: Request, res: Response): number | undefined {
  return req.session?.userId ?? res.locals.bearerAuth?.userId;
}

/** Resolve the authenticated role from session OR bearer token. */
export function getAuthRole(req: Request, res: Response): string | undefined {
  return req.session?.role ?? res.locals.bearerAuth?.role;
}

// Keep private aliases so the middleware code below stays readable
const resolvedUserId = getAuthUserId;
const resolvedRole = getAuthRole;

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  applyBearerToken(req, res).then(() => {
    if (!resolvedUserId(req, res)) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    next();
  }).catch(() => {
    res.status(500).json({ error: "Internal server error" });
  });
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  applyBearerToken(req, res).then(() => {
    if (!resolvedUserId(req, res)) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (resolvedRole(req, res) !== "super_admin") {
      res.status(403).json({ error: "Super-admin access required" });
      return;
    }
    next();
  }).catch(() => {
    res.status(500).json({ error: "Internal server error" });
  });
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
    await applyBearerToken(req, res);

    const userId = resolvedUserId(req, res);
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (resolvedRole(req, res) === "super_admin") { next(); return; }

    const rawParam = req.params[tripIdParam];
    const tripId = parseInt(Array.isArray(rawParam) ? rawParam[0] : rawParam);
    if (isNaN(tripId)) { res.status(400).json({ error: "Invalid tripId" }); return; }

    try {
      const [participant] = await db
        .select()
        .from(tripParticipantsTable)
        .where(and(
          eq(tripParticipantsTable.tripId, tripId),
          eq(tripParticipantsTable.userId, userId),
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
    await applyBearerToken(req, res);

    const userId = resolvedUserId(req, res);
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    // Super admins always pass
    if (resolvedRole(req, res) === "super_admin") {
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
            eq(tripParticipantsTable.userId, userId),
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
