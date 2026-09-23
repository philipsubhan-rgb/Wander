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

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
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
  getGoogleUserEmail,
  revokeGoogleToken,
  scanGmail,
  googleOAuthConfigured,
} from "../lib/gmailScan";
import { parseReservation } from "../lib/reservationParser";

const router: IRouter = Router();

// ---------------------------------------------------------------------------
// OAuth state: HMAC-signed, stateless CSRF protection for the connect flow.
// ---------------------------------------------------------------------------

function stateSecret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error("SESSION_SECRET is required for the Google OAuth flow");
  return s;
}

interface OAuthState {
  userId: number;
  returnTo: string;
  nonce: string;
  exp: number;
}

function signState(state: OAuthState): string {
  const payload = Buffer.from(JSON.stringify(state)).toString("base64url");
  const sig = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifyState(raw: string): OAuthState | null {
  try {
    const [payload, sig] = raw.split(".");
    if (!payload || !sig) return null;
    const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const state = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
    if (state.exp < Date.now()) return null;
    return state;
  } catch {
    return null;
  }
}

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
  const state = signState({
    userId,
    returnTo,
    nonce: randomBytes(16).toString("hex"),
    exp: Date.now() + 10 * 60 * 1000,
  });
  res.redirect(getGoogleAuthUrl(state));
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
    if (!tokens.refresh_token) {
      fail("Google did not return a refresh token");
      return;
    }
    client.setCredentials(tokens);
    const email = await getGoogleUserEmail(client);
    const encrypted = encryptToken(tokens.refresh_token);

    await db
      .insert(connectedAccountsTable)
      .values({
        userId: state.userId,
        provider: "google",
        email,
        encryptedRefreshToken: encrypted,
        scopes: "gmail.readonly",
      })
      .onConflictDoNothing({
        target: [connectedAccountsTable.userId, connectedAccountsTable.provider, connectedAccountsTable.email],
      });
    // Refresh the stored token on reconnect (upsert above ignores conflicts).
    await db
      .update(connectedAccountsTable)
      .set({ encryptedRefreshToken: encrypted, scopes: "gmail.readonly" })
      .where(
        and(
          eq(connectedAccountsTable.userId, state.userId),
          eq(connectedAccountsTable.provider, "google"),
          eq(connectedAccountsTable.email, email),
        ),
      );

    logger.info({ userId: state.userId, email }, "[Integrations] Google account connected");
    res.redirect(`${appBase}${state.returnTo}?google=connected`);
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
  const accounts = await db
    .select({
      id: connectedAccountsTable.id,
      provider: connectedAccountsTable.provider,
      email: connectedAccountsTable.email,
      lastScanAt: connectedAccountsTable.lastScanAt,
      createdAt: connectedAccountsTable.createdAt,
    })
    .from(connectedAccountsTable)
    .where(eq(connectedAccountsTable.userId, userId))
    .orderBy(desc(connectedAccountsTable.createdAt));
  res.json({ accounts, googleConfigured: googleOAuthConfigured() });
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

interface UserTrip {
  id: number;
  startDate: string;
  endDate: string;
}

async function loadUserTrips(userId: number): Promise<UserTrip[]> {
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

/** Match a parsed date against the user's trips; null when ambiguous. */
function matchTrip(trips: UserTrip[], date?: string): number | null {
  if (!date) return null;
  const hits = trips.filter((t) => date >= t.startDate && date <= t.endDate);
  return hits.length === 1 ? hits[0].id : null;
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

    let proposed = 0;
    for (const email of emails) {
      const parsed = parseReservation(email);
      if (!parsed) continue;
      const tripId = matchTrip(trips, parsed.date);
      await db
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
        });
      proposed++;
    }

    await db
      .update(connectedAccountsTable)
      .set({ lastHistoryId: historyId ?? account.lastHistoryId, lastScanAt: new Date() })
      .where(eq(connectedAccountsTable.id, account.id));

    logger.info({ userId, accountId, scanned: emails.length, proposed }, "[Integrations] Gmail scan complete");
    res.json({ scanned: emails.length, proposed });
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
