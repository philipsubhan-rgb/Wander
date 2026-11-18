/**
 * Outreach routes — party assembly & traveler outreach
 * (architecture-north-star §3.4/§3.5, Stories 3.2/4.1/4.2/4.3).
 *
 * Organizer surface (auth required; controls are trip-admin only):
 *   GET  /trips/:tripId/roster                 — status projection (§3.3)
 *   POST /trips/:tripId/roster/send-invites    — THE confirmation gate:
 *                                                invitations are sent only
 *                                                from this explicit action
 *   POST /roster-entries/:entryId/resend-invite
 *   POST /roster-entries/:entryId/chase        — body { paused: boolean }
 *   GET  /roster-entries/:entryId/share-link   — manual link (no-email path)
 *
 * Traveler surface (unauthenticated — the token IS the credential):
 *   GET  /traveler-setup/:token                — validate + begin setup
 *   POST /traveler-setup/:token/submit         — 503 until the profile
 *                                                vault lands (see outreach.ts)
 *   POST /traveler-setup/:token/decline
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth, getAuthUserId, getAuthRole } from "../middlewares/auth.js";
import { logger } from "../lib/logger.js";
import {
  InviteTokenError,
  OutreachAccessDenied,
  OutreachNotFound,
  ProfileSetupUnavailable,
  beginTravelerSetup,
  declineInvite,
  getRosterStatus,
  getShareLink,
  resendInvite,
  sendRosterInvites,
  setChasePaused,
  submitTravelerProfile,
} from "../lib/outreach.js";

const router: IRouter = Router();

function authContext(req: Request, res: Response): { userId: number; role: string } | null {
  const userId = getAuthUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return null;
  }
  return { userId, role: getAuthRole(req, res) ?? "" };
}

function parseId(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function handleServiceError(res: Response, err: unknown, context: string): void {
  if (err instanceof OutreachAccessDenied) {
    res.status(403).json({ error: err.message });
    return;
  }
  if (err instanceof OutreachNotFound) {
    res.status(404).json({ error: err.message });
    return;
  }
  logger.error({ err }, `[Outreach] ${context} failed`);
  res.status(500).json({ error: "Internal server error" });
}

// ─── Organizer surface ───────────────────────────────────────────────────────

router.get("/trips/:tripId/roster", requireAuth, async (req: Request, res: Response) => {
  const ctx = authContext(req, res);
  if (!ctx) return;
  const tripId = parseId(req.params.tripId);
  if (tripId === null) {
    res.status(400).json({ error: "Invalid tripId" });
    return;
  }
  try {
    const roster = await getRosterStatus(tripId, ctx.userId, ctx.role);
    res.json({ roster });
  } catch (err) {
    handleServiceError(res, err, "roster status");
  }
});

router.post("/trips/:tripId/roster/send-invites", requireAuth, async (req: Request, res: Response) => {
  const ctx = authContext(req, res);
  if (!ctx) return;
  const tripId = parseId(req.params.tripId);
  if (tripId === null) {
    res.status(400).json({ error: "Invalid tripId" });
    return;
  }
  try {
    const summary = await sendRosterInvites(tripId, ctx.userId, ctx.role);
    res.json(summary);
  } catch (err) {
    handleServiceError(res, err, "send invites");
  }
});

router.post("/roster-entries/:entryId/resend-invite", requireAuth, async (req: Request, res: Response) => {
  const ctx = authContext(req, res);
  if (!ctx) return;
  const entryId = parseId(req.params.entryId);
  if (entryId === null) {
    res.status(400).json({ error: "Invalid entryId" });
    return;
  }
  try {
    const outcome = await resendInvite(entryId, ctx.userId, ctx.role);
    res.json(outcome);
  } catch (err) {
    handleServiceError(res, err, "resend invite");
  }
});

router.post("/roster-entries/:entryId/chase", requireAuth, async (req: Request, res: Response) => {
  const ctx = authContext(req, res);
  if (!ctx) return;
  const entryId = parseId(req.params.entryId);
  if (entryId === null) {
    res.status(400).json({ error: "Invalid entryId" });
    return;
  }
  const paused = (req.body as { paused?: unknown })?.paused;
  if (typeof paused !== "boolean") {
    res.status(400).json({ error: "Body must include { paused: boolean }" });
    return;
  }
  try {
    const view = await setChasePaused(entryId, ctx.userId, ctx.role, paused);
    res.json(view);
  } catch (err) {
    handleServiceError(res, err, "set chase paused");
  }
});

router.get("/roster-entries/:entryId/share-link", requireAuth, async (req: Request, res: Response) => {
  const ctx = authContext(req, res);
  if (!ctx) return;
  const entryId = parseId(req.params.entryId);
  if (entryId === null) {
    res.status(400).json({ error: "Invalid entryId" });
    return;
  }
  try {
    const link = await getShareLink(entryId, ctx.userId, ctx.role);
    res.json({ url: link.url, expiresAt: link.expiresAt });
  } catch (err) {
    handleServiceError(res, err, "share link");
  }
});

// ─── Traveler surface (token is the credential) ──────────────────────────────

function handleTokenError(res: Response, err: unknown): boolean {
  if (err instanceof InviteTokenError) {
    res
      .status(err.reason === "expired" ? 410 : 400)
      .json({ error: err.message, reason: err.reason });
    return true;
  }
  return false;
}

router.get("/traveler-setup/:token", async (req: Request, res: Response) => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  try {
    const context = await beginTravelerSetup(token);
    res.json(context);
  } catch (err) {
    if (handleTokenError(res, err)) return;
    if (err instanceof OutreachNotFound) {
      res.status(404).json({ error: err.message });
      return;
    }
    logger.error({ err }, "[Outreach] traveler setup begin failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/traveler-setup/:token/submit", async (req: Request, res: Response) => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  try {
    await submitTravelerProfile(token);
    // Unreachable today: submitTravelerProfile always throws until the
    // vault lands. Kept so the success shape is defined when it does.
    res.json({ status: "ready" });
  } catch (err) {
    if (handleTokenError(res, err)) return;
    if (err instanceof ProfileSetupUnavailable) {
      res.status(503).json({ error: err.message, profileSetupAvailable: false });
      return;
    }
    logger.error({ err }, "[Outreach] traveler setup submit failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/traveler-setup/:token/decline", async (req: Request, res: Response) => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  try {
    const result = await declineInvite(token);
    res.json(result);
  } catch (err) {
    if (handleTokenError(res, err)) return;
    logger.error({ err }, "[Outreach] traveler decline failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
