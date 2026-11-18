/**
 * Profile routes — the OWNER surface for the traveler-profile vault
 * (architecture-north-star §3.1/§3.3, Stories 5.1/5.2/5.3).
 *
 *   GET  /profile/me             — own decrypted profile (or null)
 *   PUT  /profile/me             — update own profile; bumps the version
 *                                  and flags in-flight trips for re-check
 *   GET  /profile/me/access-log  — own access log (field names, never
 *                                  values; readable by the owner only)
 *
 * There is deliberately NO route with a userId parameter, and identity
 * comes from the session only. An organizer, a trip admin, and a
 * super_admin all get exactly the same thing here: their OWN profile.
 * The codebase's super_admin bypass does not extend to the vault (§3.3)
 * — there is nothing in this router to aim at another traveler's data.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth, getAuthUserId } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import {
  ProfileValidationError,
  ProfileVersionConflict,
  flagProfileChangeForTrips,
  getOwnAccessLog,
  getOwnProfile,
  upsertProfile,
  type TravelerProfileInput,
} from "../lib/travelerProfile.js";

const router: IRouter = Router();

function ownUserId(req: Request, res: Response): number | null {
  const userId = getAuthUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  return userId;
}

router.get("/profile/me", requireAuth, async (req: Request, res: Response) => {
  const userId = ownUserId(req, res);
  if (userId === null) return;
  try {
    const profile = await getOwnProfile(userId);
    res.json({ profile });
  } catch (err) {
    logger.error({ err }, "[Profiles] own profile read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.put("/profile/me", requireAuth, async (req: Request, res: Response) => {
  const userId = ownUserId(req, res);
  if (userId === null) return;
  const body = (req.body ?? {}) as TravelerProfileInput & { expectedVersion?: unknown };
  const expectedVersion =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
  try {
    const { profileVersion, warnings } = await upsertProfile(userId, body, {
      expectedVersion,
    });
    // Story 5.3: an update flags any in-flight trips for re-check.
    const { flaggedEntryIds } = await flagProfileChangeForTrips(userId, profileVersion);
    res.json({ profileVersion, warnings, flaggedEntryIds });
  } catch (err) {
    if (err instanceof ProfileValidationError) {
      res.status(400).json({ error: err.message, problems: err.problems });
      return;
    }
    if (err instanceof ProfileVersionConflict) {
      res.status(409).json({ error: err.message, currentVersion: err.currentVersion });
      return;
    }
    logger.error({ err }, "[Profiles] own profile update failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/profile/me/access-log", requireAuth, async (req: Request, res: Response) => {
  const userId = ownUserId(req, res);
  if (userId === null) return;
  try {
    const entries = await getOwnAccessLog(userId);
    res.json({
      accessLog: entries.map((e) => ({
        id: e.id,
        accessorKind: e.accessorKind,
        accessorUserId: e.accessorUserId,
        purpose: e.purpose,
        fieldsAccessed: e.fieldsAccessed,
        bookingId: e.bookingId,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    logger.error({ err }, "[Profiles] own access log read failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
