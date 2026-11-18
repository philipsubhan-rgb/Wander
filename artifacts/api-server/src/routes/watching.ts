/**
 * Watching routes — the FlightAware alert intake (architecture-north-star
 * §6.1). FlightAware pushes alert deliveries here as flight events
 * happen; that push is the system's only real-time flight-status source
 * (§8: alerts, never polling).
 *
 *   POST /webhooks/flightaware — unauthenticated by session (the caller
 *   is FlightAware, not a user). AeroAPI deliveries are NOT signed, so
 *   provenance is proven with a shared secret: when
 *   FLIGHTAWARE_WEBHOOK_SECRET is configured, the delivery must carry
 *   it — as the `x-wander-alert-secret` header or the `?secret=` query
 *   parameter (FlightAware's own suggested pattern is a secret token in
 *   the target URL). When no secret is configured the endpoint still
 *   validates payload shape and matches against known watches only; an
 *   alert for an unwatched flight changes nothing.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { logger } from "../lib/logger.js";
import { handleAlertPayload } from "../lib/watching.js";
import type { AeroAlertPayload } from "../lib/flightaware.js";

const router: IRouter = Router();

function secretMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isAlertPayload(body: unknown): body is AeroAlertPayload {
  if (typeof body !== "object" || body === null) return false;
  const flight = (body as { flight?: unknown }).flight;
  if (flight !== undefined) {
    if (typeof flight !== "object" || flight === null) return false;
    const f = flight as { ident?: unknown; fa_flight_id?: unknown };
    if (typeof f.ident !== "string" && typeof f.fa_flight_id !== "string") return false;
  }
  return true;
}

router.post("/webhooks/flightaware", async (req: Request, res: Response) => {
  const expectedSecret = process.env.FLIGHTAWARE_WEBHOOK_SECRET;
  if (expectedSecret) {
    const headerSecret = req.header("x-wander-alert-secret") ?? null;
    const querySecret = typeof req.query.secret === "string" ? req.query.secret : null;
    if (!secretMatches(headerSecret, expectedSecret) && !secretMatches(querySecret, expectedSecret)) {
      res.status(401).json({ error: "Invalid webhook secret" });
      return;
    }
  }

  if (!isAlertPayload(req.body)) {
    res.status(400).json({ error: "Malformed alert payload" });
    return;
  }

  try {
    const result = await handleAlertPayload(req.body);
    // Always 200 for a well-formed delivery we could process — including
    // unmatched/duplicate outcomes — so FlightAware doesn't retry noise.
    res.json({ received: true, outcome: result.outcome });
  } catch (err) {
    logger.error({ err }, "[Watching] alert intake failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
