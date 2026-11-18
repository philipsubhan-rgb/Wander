/**
 * Integrations: connected email accounts (Google OAuth) + Gmail reservation
 * ingestion + the propose-first proposal inbox.
 *
 * Flow:
 *   1. GET /api/integrations/google/connect  → redirect to Google consent
 *   2. GET /api/integrations/google/callback → store encrypted refresh token
 *   3. POST /api/integrations/accounts/:id/scan → find booking confirmations
 *   4. GET /api/proposals → review; POST /api/proposals/:id/accept|reject
 *
 * Nothing is auto-imported: every proposal needs an explicit accept.
 */

import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  tripsTable,
  tripParticipantsTable,
  reservationsTable,
  connectedAccountsTable,
  reservationProposalsTable,
  type ParsedReservation,
} from "@workspace/db";
import { requireAuth, getAuthUserId, getAuthRole } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { encryptToken, decryptToken, credentialsEncryptionReady } from "../lib/credentialCrypto";
import {
  getOAuthClient,
  getAccountClient,
  getGoogleAuthUrl,
  getGoogleCalendarAuthUrl,
  getGoogleUserEmail,
  revokeGoogleToken,
  scanGmail,
  googleOAuthConfigured,
} from "../lib/gmailScan";
import { syncReservationByIdForUser } from "../lib/calendarSync";
import { parseReservation } from "../lib/reservationParser";
import {
  newOAuthState,
  verifyState,
  matchTrip,
  normalizeConfirmationCode,
  isDuplicateConfirmationCode,
  mergeScopes,
  hasCalendarScope,
  type MatchableTrip,
} from "../lib/scanLogic";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// Google OAuth connect / callback
// ---------------------------------------------------------------------------

/** Start the Google OAuth flow. */
router.get("/integrations/google/connect", requireAuth, (req: Request, res: Response) => {
  const userId = getAuthUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!googleOAuthConfigured()) {
    res.status(503).json({
      error: "Google OAuth is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing)",
    });
    return;
  }
  if (!credentialsEncryptionReady()) {
    res.status(503).json({
      error: "Token encryption is not configured on this server (CREDENTIALS_KEK missing)",
    });
    return;
  }
  const returnTo = typeof req.query.returnTo === "string" && req.query.returnTo.startsWith("/")
    ? req.query.returnTo
    : "/settings";
  const state = newOAuthState(
    userId,
    returnTo,
  );
  res.redirect(getGoogleAuthUrl(state));
});

/**
 * Start the incremental calendar write-back consent. Same account, one more
 * scope: Google merges calendar.events into the existing Gmail grant
 * (include_granted_scopes), so Gmail-only connections keep working as-is.
 */
router.get("/integrations/google/connect-calendar", requireAuth, (req: Request, res: Response) => {
  const userId = getAuthUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  if (!googleOAuthConfigured()) {
    res.status(503).json({
      error: "Google OAuth is not configured on this server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing)",
    });
    return;
  }
  if (!credentialsEncryptionReady()) {
    res.status(503).json({
      error: "Token encryption is not configured on this server (CREDENTIALS_KEK missing)",
    });
    return;
  }
  const returnTo = typeof req.query.returnTo === "string" && req.query.returnTo.startsWith("/")
    ? req.query.returnTo
    : "/settings";
  const state = newOAuthState(userId, returnTo, "calendar");
  res.redirect(getGoogleCalendarAuthUrl(state));
});

/** Google redirects back here after consent. */
router.get("/integrations/google/callback", async (req: Request, res: Response) => {
  const appBase = (process.env.APP_BASE_URL ?? "").replace(/\/$/, "");
  const fail = (message: string) => {
    logger.warn({ message }, "[Integrations] Google OAuth callback failed");
    res.redirect(`${appBase}/settings?google=error`);
  };

  const state = verifyState(typeof req.query.state === "string" ? req.query.state : "");
  if (!state) {
    fail("Invalid or expired OAuth state");
    return;
  }
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) {
    fail("Missing authorization code");
    return;
  }

  try {
    const client = getOAuthClient();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);
    const email = await getGoogleUserEmail(client);

    const [existing] = await db
      .select()
      .from(connectedAccountsTable)
      .where(
        and(
          eq(connectedAccountsTable.userId, state.userId),
          eq(connectedAccountsTable.provider, "google"),
          eq(connectedAccountsTable.email, email),
        ),
      );

    // Incremental calendar consent may not return a fresh refresh token when
    // one was already issued — that's fine if we already hold one.
    if (!tokens.refresh_token && !existing) {
      fail("Google did not return a refresh token");
      return;
    }

    // Merge newly granted scopes into what the account already has — a plain
    // Gmail reconnect must never clobber a calendar grant (and vice versa).
    const granted = tokens.scope
      ?? (state.purpose === "calendar"
        ? "openid userinfo.email gmail.readonly calendar.events"
        : "gmail.readonly");
    const mergedScopes = mergeScopes(existing?.scopes, granted);
    const enableCalendar =
      state.purpose === "calendar" && hasCalendarScope(mergedScopes);

    if (tokens.refresh_token) {
      const encrypted = encryptToken(tokens.refresh_token);
      await db
        .insert(connectedAccountsTable)
        .values({
          userId: state.userId,
          provider: "google",
          email,
          encryptedRefreshToken: encrypted,
          scopes: mergedScopes,
          calendarWritebackEnabled: enableCalendar,
        })
        .onConflictDoNothing({
          target: [connectedAccountsTable.userId, connectedAccountsTable.provider, connectedAccountsTable.email],
        });
      // Refresh the stored token on reconnect (upsert above ignores conflicts).
      await db
        .update(connectedAccountsTable)
        .set({
          encryptedRefreshToken: encrypted,
          scopes: mergedScopes,
          ...(enableCalendar ? { calendarWritebackEnabled: true } : {}),
        })
        .where(
          and(
            eq(connectedAccountsTable.userId, state.userId),
            eq(connectedAccountsTable.provider, "google"),
            eq(connectedAccountsTable.email, email),
          ),
        );
    } else if (existing) {
      await db
        .update(connectedAccountsTable)
        .set({
          scopes: mergedScopes,
          ...(enableCalendar ? { calendarWritebackEnabled: true } : {}),
        })
        .where(eq(connectedAccountsTable.id, existing.id));
    }

    logger.info(
      { userId: state.userId, email, purpose: state.purpose ?? "gmail" },
      "[Integrations] Google account connected",
    );
    res.redirect(
      `${appBase}${state.returnTo}?google=${state.purpose === "calendar" ? "calendar-connected" : "connected"}`,
    );
  } catch (err) {
    fail(err instanceof Error ? err.message : "OAuth exchange failed");
  }
});

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

router.get("/integrations/accounts", requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const rows = await db
    .select({
      id: connectedAccountsTable.id,
      provider: connectedAccountsTable.provider,
      email: connectedAccountsTable.email,
      scopes: connectedAccountsTable.scopes,
      lastScanAt: connectedAccountsTable.lastScanAt,
      calendarWritebackEnabled: connectedAccountsTable.calendarWritebackEnabled,
      calendarId: connectedAccountsTable.calendarId,
      createdAt: connectedAccountsTable.createdAt,
    })
    .from(connectedAccountsTable)
    .where(eq(connectedAccountsTable.userId, userId))
    .orderBy(desc(connectedAccountsTable.createdAt));
  const accounts = rows.map(({ scopes, ...rest }) => ({
    ...rest,
    calendarGranted: hasCalendarScope(scopes),
  }));
  res.json({ accounts, googleConfigured: googleOAuthConfigured() });
});

/** Toggle calendar write-back for one account. */
router.patch("/integrations/accounts/:id", requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const accountId = Number(req.params.id);
  const [account] = await db
    .select()
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.id, accountId), eq(connectedAccountsTable.userId, userId)));
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  const enabled = req.body?.calendarWritebackEnabled;
  if (typeof enabled !== "boolean") {
    res.status(400).json({ error: "calendarWritebackEnabled (boolean) is required" });
    return;
  }
  if (enabled && !hasCalendarScope(account.scopes)) {
    res.status(400).json({
      error: "Calendar access hasn't been granted for this account yet — grant it first, then turn write-back on",
    });
    return;
  }
  await db
    .update(connectedAccountsTable)
    .set({ calendarWritebackEnabled: enabled })
    .where(eq(connectedAccountsTable.id, accountId));
  logger.info({ userId, accountId, enabled }, "[Integrations] calendar write-back toggled");
  res.json({ ok: true, calendarWritebackEnabled: enabled });
});

router.delete("/integrations/accounts/:id", requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const accountId = Number(req.params.id);
  const [account] = await db
    .select()
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.id, accountId), eq(connectedAccountsTable.userId, userId)));
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }
  try {
    await revokeGoogleToken(decryptToken(account.encryptedRefreshToken));
  } catch { /* best-effort */ }
  await db.delete(connectedAccountsTable).where(eq(connectedAccountsTable.id, accountId));
  logger.info({ userId, accountId }, "[Integrations] account disconnected");
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Scan: find booking confirmations, parse them, store proposals.
// ---------------------------------------------------------------------------

async function loadUserTrips(userId: number): Promise<MatchableTrip[]> {
  const rows = await db
    .select({
      id: tripsTable.id,
      startDate: tripsTable.startDate,
      endDate: tripsTable.endDate,
    })
    .from(tripsTable)
    .innerJoin(tripParticipantsTable, eq(tripParticipantsTable.tripId, tripsTable.id))
    .where(eq(tripParticipantsTable.userId, userId));
  return rows;
}

/** Load confirmation codes already proposed for this account (dedup across scans). */
async function loadSeenConfirmationCodes(userId: number, accountId: number): Promise<Set<string>> {
  const rows = await db
    .select({ code: sql<string | null>`${reservationProposalsTable.parsed}->>'confirmationCode'` })
    .from(reservationProposalsTable)
    .where(
      and(
        eq(reservationProposalsTable.userId, userId),
        eq(reservationProposalsTable.accountId, accountId),
      ),
    );
  return new Set(
    rows
      .map((r) => r.code)
      .filter((c): c is string => Boolean(c))
      .map(normalizeConfirmationCode),
  );
}

router.post("/integrations/accounts/:id/scan", requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const accountId = Number(req.params.id);
  const [account] = await db
    .select()
    .from(connectedAccountsTable)
    .where(and(eq(connectedAccountsTable.id, accountId), eq(connectedAccountsTable.userId, userId)));
  if (!account) {
    res.status(404).json({ error: "Account not found" });
    return;
  }

  try {
    const client = await getAccountClient(decryptToken(account.encryptedRefreshToken));
    const { emails, historyId } = await scanGmail(client, account.lastHistoryId);
    const trips = await loadUserTrips(userId);
    const seenCodes = await loadSeenConfirmationCodes(userId, account.id);

    let proposed = 0;
    let duplicatesSkipped = 0;
    for (const email of emails) {
      const parsed = parseReservation(email);
      if (!parsed) continue;
      // Skip itinerary notifications / forwards that reference a booking we
      // already proposed (e.g. TripIt duplicating a GetYourGuide email).
      if (isDuplicateConfirmationCode(seenCodes, parsed.confirmationCode)) {
        duplicatesSkipped++;
        continue;
      }
      const tripId = matchTrip(trips, parsed.date);
      const inserted = await db
        .insert(reservationProposalsTable)
        .values({
          userId,
          accountId: account.id,
          tripId,
          messageId: email.messageId,
          subject: email.subject?.slice(0, 300),
          sender: email.from?.slice(0, 300),
          receivedAt: email.receivedAt ? new Date(email.receivedAt) : null,
          parsed: parsed as unknown as Record<string, unknown>,
          status: "pending",
        })
        .onConflictDoNothing({
          target: [reservationProposalsTable.accountId, reservationProposalsTable.messageId],
        })
        .returning({ id: reservationProposalsTable.id });
      if (inserted.length > 0) {
        proposed++;
        if (parsed.confirmationCode) seenCodes.add(normalizeConfirmationCode(parsed.confirmationCode));
      } else {
        // Same Gmail message scanned before (messageId dedup).
        duplicatesSkipped++;
      }
    }

    await db
      .update(connectedAccountsTable)
      .set({ lastHistoryId: historyId ?? account.lastHistoryId, lastScanAt: new Date() })
      .where(eq(connectedAccountsTable.id, account.id));

    logger.info(
      { userId, accountId, scanned: emails.length, proposed, duplicatesSkipped },
      "[Integrations] Gmail scan complete",
    );
    res.json({ scanned: emails.length, proposed, duplicatesSkipped });
  } catch (err) {
    logger.error({ userId, accountId, err }, "[Integrations] Gmail scan failed");
    const message = err instanceof Error ? err.message : "Scan failed";
    const status = /invalid_grant|revoked/i.test(message) ? 401 : 500;
    res.status(status).json({
      error: status === 401
        ? "Google access was revoked — please disconnect and reconnect the account"
        : message,
    });
  }
});

// ---------------------------------------------------------------------------
// Proposals: review inbox (propose-first — nothing auto-imports)
// ---------------------------------------------------------------------------

router.get("/proposals", requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const status = typeof req.query.status === "string" ? req.query.status : "pending";
  const tripId = Number(req.query.tripId);
  const conditions = [
    eq(reservationProposalsTable.userId, userId),
    eq(reservationProposalsTable.status, status),
  ];
  if (Number.isInteger(tripId) && tripId > 0) {
    conditions.push(eq(reservationProposalsTable.tripId, tripId));
  }
  const proposals = await db
    .select()
    .from(reservationProposalsTable)
    .where(and(...conditions))
    .orderBy(desc(reservationProposalsTable.createdAt))
    .limit(100);
  res.json({ proposals });
});

async function assertTripAccess(userId: number, role: string, tripId: number): Promise<void> {
  if (role === "super_admin") return;
  const [row] = await db
    .select({ tripId: tripParticipantsTable.tripId })
    .from(tripParticipantsTable)
    .where(and(eq(tripParticipantsTable.userId, userId), eq(tripParticipantsTable.tripId, tripId)));
  if (!row) throw new Error("Trip access required");
}

/** Accept a proposal → creates the reservation on the trip. */
router.post("/proposals/:id/accept", requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req, res);
  const role = getAuthRole(req, res) ?? "";
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const proposalId = Number(req.params.id);
  const [proposal] = await db
    .select()
    .from(reservationProposalsTable)
    .where(and(eq(reservationProposalsTable.id, proposalId), eq(reservationProposalsTable.userId, userId)));
  if (!proposal || proposal.status !== "pending") {
    res.status(404).json({ error: "Proposal not found or already handled" });
    return;
  }

  const tripId = Number(req.body?.tripId) || proposal.tripId;
  if (!tripId) {
    res.status(400).json({ error: "This proposal didn't match a trip — pick one to accept it into" });
    return;
  }
  try {
    await assertTripAccess(userId, role, tripId);
  } catch {
    res.status(403).json({ error: "Trip access required" });
    return;
  }

  const parsed = proposal.parsed as unknown as ParsedReservation;
  const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, tripId));
  const [created] = await db
    .insert(reservationsTable)
    .values({
      tripId,
      type: parsed.type ?? "other",
      title: parsed.title?.slice(0, 200) || "Imported reservation",
      venue: parsed.venue,
      date: parsed.date ?? trip?.startDate ?? new Date().toISOString().slice(0, 10),
      time: parsed.time,
      endTime: parsed.endTime,
      confirmationCode: parsed.confirmationCode,
      numberOfPeople: parsed.numberOfPeople,
      notes: parsed.notes,
      url: parsed.url,
    })
    .returning({ id: reservationsTable.id });

  await db
    .update(reservationProposalsTable)
    .set({ status: "accepted", tripId })
    .where(eq(reservationProposalsTable.id, proposalId));

  // Calendar write-back: best-effort, never fails the accept (sync logs its
  // own errors). No-op unless the user enabled it on a connected account.
  await syncReservationByIdForUser(userId, created.id);

  logger.info({ userId, proposalId, tripId }, "[Integrations] proposal accepted");
  res.json({ ok: true, reservationId: created.id, tripId });
});

/** Reject a proposal — it never touches the trip. */
router.post("/proposals/:id/reject", requireAuth, async (req: Request, res: Response) => {
  const userId = getAuthUserId(req, res);
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const proposalId = Number(req.params.id);
  await db
    .update(reservationProposalsTable)
    .set({ status: "rejected" })
    .where(
      and(
        eq(reservationProposalsTable.id, proposalId),
        eq(reservationProposalsTable.userId, userId),
        eq(reservationProposalsTable.status, "pending"),
      ),
    );
  res.json({ ok: true });
});

export default router;
