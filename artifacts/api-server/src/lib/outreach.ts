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
 * Profile submission writes into the traveler-profile vault through the
 * Context/Profile service (lib/travelerProfile.ts) — the only module
 * that touches the vault. There is no shadow profile store here either:
 * this service validates the invite token, resolves/creates the
 * traveler's user record, and hands the fields to the vault service.
 */

import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
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
  ProfileValidationError,
  computeMissingFields,
  flagProfileChangeForTrips,
  loadProfileRow,
  upsertProfile,
  validateProfileInput,
  type TravelerProfileInput,
} from "./travelerProfile.js";
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
    userId: number;
    invitedEmail: string;
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
  /** True — the profile vault is live; the page may collect fields. */
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
    profileSetupAvailable: true,
  };
}

/**
 * What the account-wall-free setup page submits. All fields optional —
 * a partial submission is a real state (setting_up with the true
 * remaining missing fields), not an error. `legalName` is a convenience
 * for a single name box; explicit first/middle/last win when present.
 * `email` is used only when the roster entry itself carries none (the
 * hand-delivered share-link path).
 */
export interface TravelerProfileSubmission {
  email?: string;
  legalFirstName?: string;
  legalMiddleName?: string;
  legalLastName?: string;
  legalName?: string;
  dateOfBirth?: string;
  passportNumber?: string;
  passportIssuingCountry?: string;
  passportExpiry?: string;
  nationality?: string;
  phone?: string;
  emergencyContact?: {
    name?: string;
    relationship?: string | null;
    phone?: string;
  } | null;
}

function submissionToProfileInput(sub: TravelerProfileSubmission): TravelerProfileInput {
  const input: TravelerProfileInput = {
    legalFirstName: sub.legalFirstName,
    legalMiddleName: sub.legalMiddleName,
    legalLastName: sub.legalLastName,
    dateOfBirth: sub.dateOfBirth,
    passportNumber: sub.passportNumber,
    passportIssuingCountry: sub.passportIssuingCountry,
    passportExpiry: sub.passportExpiry,
    nationality: sub.nationality,
    phone: sub.phone,
  };
  if (sub.legalName && !sub.legalFirstName && !sub.legalLastName) {
    const tokens = sub.legalName.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 1) {
      input.legalFirstName = tokens[0];
    } else if (tokens.length >= 2) {
      input.legalFirstName = tokens[0];
      input.legalLastName = tokens[tokens.length - 1];
      if (tokens.length > 2) input.legalMiddleName = tokens.slice(1, -1).join(" ");
    }
  }
  if (sub.emergencyContact !== undefined) {
    input.emergencyContact =
      sub.emergencyContact === null
        ? null
        : {
            name: sub.emergencyContact.name ?? "",
            relationship: sub.emergencyContact.relationship ?? null,
            phone: sub.emergencyContact.phone ?? "",
          };
  }
  return input;
}

/**
 * Resolve the traveler's user record: an existing account with this
 * email is claimed (linked), otherwise one is created silently behind
 * the profile (§3.4). A created account's password hash is of a random
 * secret that is hashed and discarded — the account cannot be logged
 * into until the traveler claims it via the password-reset flow (the
 * Story 4.3 "offer afterward"). No login flow is built here.
 */
async function findOrCreateTravelerUser(
  email: string,
  displayName: string,
): Promise<UserRow> {
  const normalizedEmail = email.trim().toLowerCase();
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail));
  if (existing) return existing;

  const passwordHash = await bcrypt.hash(randomBytes(32).toString("hex"), 10);
  await db.insert(usersTable).values({
    username: `traveler-${randomBytes(6).toString("hex")}`,
    name: displayName,
    email: normalizedEmail,
    role: "traveler",
    passwordHash,
  });
  const [created] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.email, normalizedEmail));
  if (!created) throw new Error("Failed to create the traveler's user record.");
  logger.info({ userId: created.id }, "[Outreach] silent user record created for traveler profile");
  return created;
}

export interface SubmitProfileResult {
  status: string;
  /** Required field NAMES still outstanding — never values. */
  missingFields: string[];
  /** Non-fatal flags for the traveler (e.g. "passport_expired"). */
  warnings: string[];
  userId: number;
  tripId: number;
  /**
   * True when THIS submission created the traveler's trip_participants
   * row (the §3.2 claim). The caller (route) fires the expense-split
   * recalculation hook on a true — exactly as participant add does today.
   */
  participantCreated: boolean;
}

/**
 * The claim seam (§3.2): once a roster entry is linked to a user, that
 * user becomes a real participant of the trip — the roster entry remains
 * as the status record, and a `trip_participants` row now exists for
 * access, expenses, and splits. Idempotent: an existing participant row
 * (added directly, or created by an earlier claim) is left untouched and
 * reported as not-created, so a re-claim never duplicates the row and
 * never re-fires the split recalculation.
 */
export async function ensureTripParticipant(
  tripId: number,
  userId: number,
): Promise<boolean> {
  const [existing] = await db
    .select()
    .from(tripParticipantsTable)
    .where(
      and(
        eq(tripParticipantsTable.tripId, tripId),
        eq(tripParticipantsTable.userId, userId),
      ),
    );
  if (existing) return false;
  await db.insert(tripParticipantsTable).values({
    tripId,
    userId,
    isTripAdmin: false,
  });
  logger.info({ tripId, userId }, "[Outreach] claimed traveler added as trip participant");
  return true;
}

/**
 * The submission flow (Story 4.3/5.1), now backed by the vault:
 * validate token → resolve/create the traveler's user record → write
 * the fields into the vault via the Context/Profile service → link the
 * roster entry → create the trip_participants row (the §3.2 claim —
 * the route fires the split recalculation when a row was created) →
 * recompute missingFields from real profile state → advance status
 * (ready when nothing required is missing, else setting_up) → consume
 * the token. The token is consumed LAST, so a validation failure
 * leaves the traveler a working link to retry with.
 */
export async function submitTravelerProfile(
  rawToken: string,
  submission: TravelerProfileSubmission = {},
  now: Date = new Date(),
): Promise<SubmitProfileResult> {
  const { tokenId, entry } = await validateInviteToken(rawToken, now);
  if (entry.status === "declined") {
    throw new InviteTokenError(
      "used",
      "This invitation was declined. Ask the organizer to send you a fresh one if that was a mistake.",
    );
  }

  // Validate BEFORE any write: a malformed submission creates no user
  // record, no profile, and leaves the token unconsumed for a retry.
  // (upsertProfile validates again at the vault boundary.)
  validateProfileInput(submissionToProfileInput(submission), now);

  // Resolve whose profile this is. A linked entry already knows; an
  // emailed entry resolves by its invited email; a hand-delivered share
  // link relies on the email the traveler provides in the submission.
  let userId = entry.userId;
  let entryEmail = entry.invitedEmail;
  if (userId === null) {
    const email = entry.invitedEmail ?? submission.email?.trim();
    if (!email) {
      throw new ProfileValidationError([
        "an email address is required to save your details",
      ]);
    }
    const user = await findOrCreateTravelerUser(email, entry.invitedName);
    userId = user.id;
    entryEmail = email.trim().toLowerCase();
  }

  const { profileVersion, warnings } = await upsertProfile(
    userId,
    submissionToProfileInput(submission),
    { now },
  );

  // Link the entry to the profile owner (and record a traveler-supplied
  // email on share-link entries that had none).
  await updateEntry(entry.id, {
    userId,
    ...(entry.invitedEmail === null && entryEmail ? { invitedEmail: entryEmail } : {}),
  });

  // The claim (§3.2): a linked traveler is a trip participant. The
  // roster entry stays as the status record; the participant row is
  // what access checks, expenses, and splits read. Idempotent — a
  // re-submit after an earlier claim creates nothing new.
  const participantCreated = await ensureTripParticipant(entry.tripId, userId);

  // Change propagation covers this traveler's OTHER in-flight trips;
  // this entry is then recomputed directly so its post-submit state is
  // exact regardless of trip dates.
  await flagProfileChangeForTrips(userId, profileVersion, now);
  const profileRow = await loadProfileRow(userId);
  const missing = computeMissingFields(profileRow, entry.requiredFieldsProfile ?? []);
  const status = missing.length === 0 ? "ready" : "setting_up";
  const chase = parseChaseState(entry.chaseState);
  await updateEntry(entry.id, {
    missingFields: missing,
    status,
    ...(missing.length === 0
      ? { chaseState: { ...chase, nextDueAt: null } as unknown as Record<string, unknown> }
      : {}),
  });

  await consumeInviteToken(tokenId, now);
  logger.info(
    { entryId: entry.id, tripId: entry.tripId, userId, status, missingCount: missing.length },
    "[Outreach] traveler profile submitted",
  );
  return {
    status,
    missingFields: missing,
    warnings,
    userId,
    tripId: entry.tripId,
    participantCreated,
  };
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
