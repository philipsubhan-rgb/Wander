/**
 * Outreach Service — the DB-backed half of party assembly & outreach
 * (architecture-north-star §3.4/§3.5; pure logic in outreachLogic.ts).
 *
 * Owns: invite token issuance/validation, the organizer-confirmed invite
 * send (Story 4.1 — nothing is ever sent before that confirmation),
 * failure handling (Story 4.1: a failed send marks the entry
 * needs_attention and alerts the organizer immediately), the
 * account-wall-free setup seam (Story 4.3), chase reminder/escalation
 * execution (Story 4.2 — decisions live in decideChaseAction), and the
 * organizer roster projection (Story 3.2).
 *
 * The traveler-profile vault is the NEXT build. The submission endpoint
 * therefore rejects with ProfileSetupUnavailable rather than collecting
 * private fields into any interim store — there is no shadow profile
 * table, by design.
 */

import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  travelerInviteTokensTable,
  tripParticipantsTable,
  tripRosterEntriesTable,
  tripsTable,
  usersTable,
  type Trip,
  type TripRosterEntry,
} from "@workspace/db";
import { sendEmail } from "./email.js";
import { logger } from "./logger.js";
import {
  OUTREACH_CONFIG,
  buildInviteEmail,
  buildOrganizerAlertEmail,
  buildReminderEmail,
  buildSetupUrl,
  chaseStateAfterEscalation,
  chaseStateAfterInvite,
  chaseStateAfterReminder,
  decideChaseAction,
  fieldLabels,
  generateInviteToken,
  hashInviteToken,
  inviteTokenExpiry,
  isInviteTokenUsable,
  parseChaseState,
  projectRosterEntryForOrganizer,
  type ChaseState,
  type OrganizerRosterEntryView,
} from "./outreachLogic.js";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OutreachAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutreachAccessDenied";
  }
}

export class OutreachNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OutreachNotFound";
  }
}

export type InviteTokenFailure = "invalid" | "expired" | "used";

export class InviteTokenError extends Error {
  readonly reason: InviteTokenFailure;
  constructor(reason: InviteTokenFailure, message: string) {
    super(message);
    this.name = "InviteTokenError";
    this.reason = reason;
  }
}

/**
 * Thrown by the profile-submission seam until the traveler-profile vault
 * lands. The token is NOT consumed and nothing is stored — the traveler
 * keeps a working link for when setup opens.
 */
export class ProfileSetupUnavailable extends Error {
  constructor() {
    super(
      "Profile setup is not available yet — your link stays valid, and Wander will be able to accept your details soon.",
    );
    this.name = "ProfileSetupUnavailable";
  }
}

// ---------------------------------------------------------------------------
// Shared lookups & access
// ---------------------------------------------------------------------------

type UserRow = typeof usersTable.$inferSelect;

export interface OrganizerInfo {
  userId: number;
  name: string;
  email: string;
}

/**
 * Trusted base URL for setup links — mirrors the password-reset flow in
 * routes/auth.ts: APP_BASE_URL (or the Replit dev domain), never a
 * request header. Returns null when no safe base exists.
 */
export function resolveAppBaseUrl(): string | null {
  return (
    process.env.APP_BASE_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null)
  );
}

async function loadTrip(tripId: number): Promise<Trip> {
  const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, tripId));
  if (!trip) throw new OutreachNotFound(`Trip ${tripId} not found.`);
  return trip;
}

async function loadEntry(entryId: number): Promise<TripRosterEntry> {
  const [entry] = await db
    .select()
    .from(tripRosterEntriesTable)
    .where(eq(tripRosterEntriesTable.id, entryId));
  if (!entry) throw new OutreachNotFound(`Roster entry ${entryId} not found.`);
  return entry;
}

/** Any participant (or super_admin) may read roster status. */
export async function assertTripParticipantAccess(
  userId: number,
  role: string,
  tripId: number,
): Promise<void> {
  if (role === "super_admin") return;
  const [participant] = await db
    .select()
    .from(tripParticipantsTable)
    .where(
      and(eq(tripParticipantsTable.tripId, tripId), eq(tripParticipantsTable.userId, userId)),
    );
  if (!participant) {
    throw new OutreachAccessDenied(`Not a participant of trip ${tripId}.`);
  }
}

/** Organizer = trip admin participant (or super_admin). Controls are admin-only. */
export async function assertTripOrganizer(
  userId: number,
  role: string,
  tripId: number,
): Promise<void> {
  if (role === "super_admin") return;
  const [participant] = await db
    .select()
    .from(tripParticipantsTable)
    .where(
      and(
        eq(tripParticipantsTable.tripId, tripId),
        eq(tripParticipantsTable.userId, userId),
        eq(tripParticipantsTable.isTripAdmin, true),
      ),
    );
  if (!participant) {
    throw new OutreachAccessDenied(`Not an organizer of trip ${tripId}.`);
  }
}

/** The trip's organizer (first admin participant) — alert addressing. */
export async function loadTripOrganizer(tripId: number): Promise<OrganizerInfo | null> {
  const [participant] = await db
    .select()
    .from(tripParticipantsTable)
    .where(
      and(
        eq(tripParticipantsTable.tripId, tripId),
        eq(tripParticipantsTable.isTripAdmin, true),
      ),
    );
  if (!participant) return null;
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, participant.userId));
  if (!user) return null;
  return { userId: user.id, name: user.name, email: user.email };
}

async function updateEntry(
  entryId: number,
  set: Partial<{
    status: string;
    missingFields: string[];
    chaseState: Record<string, unknown>;
  }>,
): Promise<void> {
  await db
    .update(tripRosterEntriesTable)
    .set({ ...set, updatedAt: new Date() })
    .where(eq(tripRosterEntriesTable.id, entryId));
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * Issue a fresh token for an entry. Prior unused tokens are deleted —
 * that deletion IS the invalidation of the old link (§3.4: re-issuable,
 * old token invalidated). Returns the raw token; only its hash is stored.
 */
export async function issueInviteToken(
  rosterEntryId: number,
  now: Date = new Date(),
): Promise<{ rawToken: string; expiresAt: Date }> {
  const rawToken = generateInviteToken();
  const expiresAt = inviteTokenExpiry(now);
  await db
    .delete(travelerInviteTokensTable)
    .where(
      and(
        eq(travelerInviteTokensTable.rosterEntryId, rosterEntryId),
        isNull(travelerInviteTokensTable.usedAt),
      ),
    );
  await db.insert(travelerInviteTokensTable).values({
    rosterEntryId,
    tokenHash: hashInviteToken(rawToken),
    expiresAt,
  });
  return { rawToken, expiresAt };
}

interface ValidToken {
  tokenId: number;
  entry: TripRosterEntry;
}

/** Validate a raw token without consuming it. Throws InviteTokenError. */
export async function validateInviteToken(
  rawToken: string,
  now: Date = new Date(),
): Promise<ValidToken> {
  const [row] = await db
    .select()
    .from(travelerInviteTokensTable)
    .where(eq(travelerInviteTokensTable.tokenHash, hashInviteToken(rawToken)));
  if (!row) {
    throw new InviteTokenError("invalid", "This setup link is invalid. Ask the organizer to send you a fresh one.");
  }
  if (row.usedAt !== null) {
    throw new InviteTokenError("used", "This setup link has already been used. Ask the organizer to send you a fresh one.");
  }
  if (!isInviteTokenUsable(row, now)) {
    throw new InviteTokenError("expired", "This setup link has expired. Ask the organizer to send you a fresh one.");
  }
  const entry = await loadEntry(row.rosterEntryId);
  return { tokenId: row.id, entry };
}

async function consumeInviteToken(tokenId: number, now: Date): Promise<void> {
  await db
    .update(travelerInviteTokensTable)
    .set({ usedAt: now })
    .where(eq(travelerInviteTokensTable.id, tokenId));
}

// ---------------------------------------------------------------------------
// Invite delivery (shared by send-invites, resend, and failure recovery)
// ---------------------------------------------------------------------------

export type InviteOutcome =
  | { entryId: number; outcome: "sent" }
  | { entryId: number; outcome: "no_email" }
  | { entryId: number; outcome: "failed"; reason: string };

/**
 * Deliver one invitation: issue a token, email the setup link, and record
 * the result on the roster entry. A failed send flips the entry to
 * needs_attention and alerts the organizer immediately (Story 4.1).
 * Never throws for a send failure — the outcome says what happened.
 */
export async function deliverInvite(
  entry: TripRosterEntry,
  trip: Trip,
  organizer: OrganizerInfo,
  now: Date = new Date(),
): Promise<InviteOutcome> {
  if (!entry.invitedEmail) return { entryId: entry.id, outcome: "no_email" };

  const chase = parseChaseState(entry.chaseState);
  // Until the vault computes real missing fields, everything this trip
  // requires starts out missing.
  const missingFields = entry.missingFields ?? [...(entry.requiredFieldsProfile ?? [])];

  const baseUrl = resolveAppBaseUrl();
  if (!baseUrl) {
    await markInviteFailed(entry, chase, "setup_link_unavailable", trip, organizer, now);
    return { entryId: entry.id, outcome: "failed", reason: "setup_link_unavailable" };
  }

  const { rawToken } = await issueInviteToken(entry.id, now);
  const email = buildInviteEmail({
    travelerName: entry.invitedName,
    organizerName: organizer.name,
    tripTitle: trip.title,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    requiredFieldLabels: fieldLabels(entry.requiredFieldsProfile ?? []),
    setupUrl: buildSetupUrl(baseUrl, rawToken),
  });

  const result = await sendEmail({ to: entry.invitedEmail, ...email });
  if (!result.sent) {
    await markInviteFailed(entry, chase, "email_send_failed", trip, organizer, now);
    return { entryId: entry.id, outcome: "failed", reason: "email_send_failed" };
  }

  const nextChase = chaseStateAfterInvite(chase, now);
  await updateEntry(entry.id, {
    // A resend to someone mid-setup must not regress them to "invited".
    status: entry.status === "setting_up" ? "setting_up" : "invited",
    missingFields,
    chaseState: nextChase as unknown as Record<string, unknown>,
  });
  logger.info({ entryId: entry.id, tripId: trip.id }, "[Outreach] invitation sent");
  return { entryId: entry.id, outcome: "sent" };
}

async function markInviteFailed(
  entry: TripRosterEntry,
  chase: ChaseState,
  reason: string,
  trip: Trip,
  organizer: OrganizerInfo,
  now: Date,
): Promise<void> {
  const nextChase: ChaseState = {
    ...chase,
    lastFailure: { at: now.toISOString(), reason },
  };
  await updateEntry(entry.id, {
    status: "needs_attention",
    chaseState: nextChase as unknown as Record<string, unknown>,
  });
  logger.warn({ entryId: entry.id, tripId: trip.id, reason }, "[Outreach] invitation failed");
  // Immediate organizer alert (Story 4.1) — status + reason class only.
  if (entry.invitedEmail) {
    const alert = buildOrganizerAlertEmail({
      kind: "send_failed",
      organizerName: organizer.name,
      tripTitle: trip.title,
      travelerName: entry.invitedName,
      travelerEmail: entry.invitedEmail,
      reason,
    });
    await sendEmail({ to: organizer.email, ...alert });
  }
}

// ---------------------------------------------------------------------------
// Organizer actions
// ---------------------------------------------------------------------------

export interface SendInvitesSummary {
  sent: number[];
  needsEmail: number[];
  failed: Array<{ entryId: number; reason: string }>;
  skipped: Array<{ entryId: number; reason: string }>;
}

/**
 * THE send gate (Story 4.1): invitations go out only when the organizer
 * explicitly confirms the roster by invoking this. Roster creation,
 * reads, and every other code path send nothing.
 */
export async function sendRosterInvites(
  tripId: number,
  userId: number,
  role: string,
  now: Date = new Date(),
): Promise<SendInvitesSummary> {
  await assertTripOrganizer(userId, role, tripId);
  const trip = await loadTrip(tripId);
  const organizer = await loadTripOrganizer(tripId);
  if (!organizer) throw new OutreachNotFound(`Trip ${tripId} has no organizer.`);

  const entries = await db
    .select()
    .from(tripRosterEntriesTable)
    .where(eq(tripRosterEntriesTable.tripId, tripId));

  const summary: SendInvitesSummary = { sent: [], needsEmail: [], failed: [], skipped: [] };
  const sentNames: string[] = [];

  for (const entry of entries) {
    if (entry.status === "ready" || entry.status === "declined") {
      summary.skipped.push({ entryId: entry.id, reason: `status_${entry.status}` });
      continue;
    }
    const outcome = await deliverInvite(entry, trip, organizer, now);
    if (outcome.outcome === "sent") {
      summary.sent.push(entry.id);
      sentNames.push(entry.invitedName);
    } else if (outcome.outcome === "no_email") {
      summary.needsEmail.push(entry.id);
    } else {
      summary.failed.push({ entryId: entry.id, reason: outcome.reason });
    }
  }

  // Story 4.1: the organizer hears when everything was delivered.
  const emailable = summary.sent.length + summary.failed.length;
  if (summary.sent.length > 0 && summary.failed.length === 0 && emailable > 0) {
    const alert = buildOrganizerAlertEmail({
      kind: "all_delivered",
      organizerName: organizer.name,
      tripTitle: trip.title,
      travelerNames: sentNames,
    });
    await sendEmail({ to: organizer.email, ...alert });
  }

  return summary;
}

export async function resendInvite(
  entryId: number,
  userId: number,
  role: string,
  now: Date = new Date(),
): Promise<InviteOutcome> {
  const entry = await loadEntry(entryId);
  await assertTripOrganizer(userId, role, entry.tripId);
  if (entry.status === "ready" || entry.status === "declined") {
    return { entryId, outcome: "failed", reason: `status_${entry.status}` };
  }
  const trip = await loadTrip(entry.tripId);
  const organizer = await loadTripOrganizer(entry.tripId);
  if (!organizer) throw new OutreachNotFound(`Trip ${entry.tripId} has no organizer.`);
  return deliverInvite(entry, trip, organizer, now);
}

/**
 * Manual share link for an entry (the path for travelers without an
 * email). Issuing it invalidates any previously emailed link — the
 * organizer is handing over the current one.
 */
export async function getShareLink(
  entryId: number,
  userId: number,
  role: string,
  now: Date = new Date(),
): Promise<{ url: string; expiresAt: Date }> {
  const entry = await loadEntry(entryId);
  await assertTripOrganizer(userId, role, entry.tripId);
  const baseUrl = resolveAppBaseUrl();
  if (!baseUrl) {
    throw new Error("APP_BASE_URL is not set — cannot construct a setup link.");
  }
  const { rawToken, expiresAt } = await issueInviteToken(entry.id, now);
  return { url: buildSetupUrl(baseUrl, rawToken), expiresAt };
}

/** Organizer roster view — the §3.3 status projection, nothing else. */
export async function getRosterStatus(
  tripId: number,
  userId: number,
  role: string,
): Promise<OrganizerRosterEntryView[]> {
  await assertTripParticipantAccess(userId, role, tripId);
  const entries = await db
    .select()
    .from(tripRosterEntriesTable)
    .where(eq(tripRosterEntriesTable.tripId, tripId));
  return entries.map(projectRosterEntryForOrganizer);
}

export async function setChasePaused(
  entryId: number,
  userId: number,
  role: string,
  paused: boolean,
): Promise<OrganizerRosterEntryView> {
  const entry = await loadEntry(entryId);
  await assertTripOrganizer(userId, role, entry.tripId);
  const chase = parseChaseState(entry.chaseState);
  const next: ChaseState = { ...chase, paused };
  await updateEntry(entryId, {
    chaseState: next as unknown as Record<string, unknown>,
  });
  return projectRosterEntryForOrganizer({
    ...entry,
    chaseState: next as unknown as Record<string, unknown>,
  });
}

// ---------------------------------------------------------------------------
// Traveler-facing setup seam (unauthenticated, token-bearing)
// ---------------------------------------------------------------------------

export interface TravelerSetupContext {
  travelerName: string;
  organizerName: string;
  trip: { title: string; destination: string; startDate: string; endDate: string };
  status: string;
  /** Field names this trip requires, with general-terms labels. */
  requiredFields: Array<{ name: string; label: string }>;
  missingFields: Array<{ name: string; label: string }>;
  /** The Story 4.3 disclosure, stated before any field is shown. */
  privacyNotice: string;
  /** False until the profile vault lands; the page renders accordingly. */
  profileSetupAvailable: boolean;
}

/**
 * Token landing: validates the link and moves the entry to setting_up.
 * Does NOT consume the token — consumption happens at submission.
 */
export async function beginTravelerSetup(
  rawToken: string,
  now: Date = new Date(),
): Promise<TravelerSetupContext> {
  const { entry } = await validateInviteToken(rawToken, now);
  const trip = await loadTrip(entry.tripId);
  const organizer = await loadTripOrganizer(entry.tripId);

  if (entry.status === "invited" || entry.status === "needs_attention") {
    // Arriving via the link resolves a delivery-side needs_attention.
    await updateEntry(entry.id, { status: "setting_up" });
  }

  const required = entry.requiredFieldsProfile ?? [];
  const missing = entry.missingFields ?? [...required];
  const organizerName = organizer?.name ?? "Your organizer";
  return {
    travelerName: entry.invitedName,
    organizerName,
    trip: {
      title: trip.title,
      destination: trip.destination,
      startDate: trip.startDate,
      endDate: trip.endDate,
    },
    status: entry.status === "invited" || entry.status === "needs_attention"
      ? "setting_up"
      : entry.status,
    requiredFields: required.map((name) => ({ name, label: fieldLabels([name])[0] })),
    missingFields: missing.map((name) => ({ name, label: fieldLabels([name])[0] })),
    privacyNotice:
      `Your details are private. You enter them yourself, directly to Wander. ` +
      `${organizerName} can only see whether your details are complete — never the details themselves. ` +
      `Nobody else on the trip can see them either.`,
    profileSetupAvailable: false,
  };
}

/**
 * The submission seam. Until the traveler-profile vault exists this
 * rejects with ProfileSetupUnavailable: the token stays unconsumed and
 * NOTHING the traveler sent is stored anywhere. When the vault lands,
 * this becomes the consuming write into it (token → used_at, entry →
 * ready, missingFields recomputed by the vault service).
 */
export async function submitTravelerProfile(
  rawToken: string,
  now: Date = new Date(),
): Promise<never> {
  await validateInviteToken(rawToken, now);
  throw new ProfileSetupUnavailable();
}

/** Decline from the setup flow (Story 4.3): consumes the token, stops chasing. */
export async function declineInvite(
  rawToken: string,
  now: Date = new Date(),
): Promise<{ status: "declined" }> {
  const { tokenId, entry } = await validateInviteToken(rawToken, now);
  const chase = parseChaseState(entry.chaseState);
  await consumeInviteToken(tokenId, now);
  await updateEntry(entry.id, {
    status: "declined",
    chaseState: { ...chase, nextDueAt: null } as unknown as Record<string, unknown>,
  });
  logger.info({ entryId: entry.id, tripId: entry.tripId }, "[Outreach] traveler declined");
  return { status: "declined" };
}

// ---------------------------------------------------------------------------
// Chase execution (used by outreachScheduler; decisions are pure)
// ---------------------------------------------------------------------------

/** All entries in a chaseable status. The tick applies decideChaseAction. */
export async function loadChaseCandidates(): Promise<TripRosterEntry[]> {
  return db
    .select()
    .from(tripRosterEntriesTable)
    .where(inArray(tripRosterEntriesTable.status, ["invited", "setting_up"]));
}

/**
 * Send one chase reminder: a fresh setup link (invalidating older ones),
 * general-terms missing labels, then advance the chase state by a full
 * interval. A failed send flips the entry to needs_attention and alerts
 * the organizer, exactly like a failed invite.
 */
export async function applyChaseReminder(
  entry: TripRosterEntry,
  trip: Trip,
  organizer: OrganizerInfo,
  now: Date = new Date(),
): Promise<"sent" | "failed" | "no_email"> {
  if (!entry.invitedEmail) return "no_email";
  const chase = parseChaseState(entry.chaseState);

  const baseUrl = resolveAppBaseUrl();
  if (!baseUrl) {
    await markInviteFailed(entry, chase, "setup_link_unavailable", trip, organizer, now);
    return "failed";
  }

  const { rawToken } = await issueInviteToken(entry.id, now);
  const email = buildReminderEmail({
    travelerName: entry.invitedName,
    organizerName: organizer.name,
    tripTitle: trip.title,
    missingLabels: fieldLabels(entry.missingFields ?? []),
    setupUrl: buildSetupUrl(baseUrl, rawToken),
  });
  const result = await sendEmail({ to: entry.invitedEmail, ...email });
  if (!result.sent) {
    await markInviteFailed(entry, chase, "email_send_failed", trip, organizer, now);
    return "failed";
  }

  await updateEntry(entry.id, {
    chaseState: chaseStateAfterReminder(chase, now) as unknown as Record<string, unknown>,
  });
  logger.info(
    { entryId: entry.id, tripId: trip.id, remindersSent: chase.remindersSent + 1 },
    "[Outreach] chase reminder sent",
  );
  return "sent";
}

/** Record an escalation on one entry (state only; alerting is the caller's job, batched per trip). */
export async function applyChaseEscalation(
  entry: TripRosterEntry,
  now: Date = new Date(),
): Promise<void> {
  const chase = parseChaseState(entry.chaseState);
  await updateEntry(entry.id, {
    chaseState: chaseStateAfterEscalation(chase, now) as unknown as Record<string, unknown>,
  });
}

/** One batched escalation alert per trip per tick — counts and labels, never contents. */
export async function sendEscalationAlert(
  trip: Trip,
  organizer: OrganizerInfo,
  reason: "reminders_exhausted" | "deadline_approaching",
  pending: TripRosterEntry[],
): Promise<void> {
  const alert = buildOrganizerAlertEmail({
    kind: "escalation",
    organizerName: organizer.name,
    tripTitle: trip.title,
    startDate: trip.startDate,
    reason,
    pending: pending.map((e) => ({
      name: e.invitedName,
      missingLabels: fieldLabels(e.missingFields ?? []),
    })),
  });
  await sendEmail({ to: organizer.email, ...alert });
  logger.info(
    { tripId: trip.id, pendingCount: pending.length, reason },
    "[Outreach] escalation alert sent to organizer",
  );
}

export { decideChaseAction, OUTREACH_CONFIG };
