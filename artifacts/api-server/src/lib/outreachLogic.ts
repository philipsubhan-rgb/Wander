/**
 * Outreach — pure logic (architecture-north-star §3.4/§3.5, Stories
 * 4.1/4.2/4.3). Everything in this module is side-effect free and
 * unit-testable: token math, the chase decision function, the email copy
 * builders, and the organizer-facing roster projection. The DB-backed
 * service lives in outreach.ts; the cron tick in outreachScheduler.ts.
 *
 * Privacy discipline (Story 5.2): nothing in this module ever sees a
 * profile field VALUE. Missing data is referred to by field name only,
 * rendered for humans through `fieldLabel` into general terms ("your
 * passport details"). Email builders receive names, never values, and
 * the tests assert a sentinel value can never appear in outbound copy.
 */

import crypto from "node:crypto";
import type { TripRosterEntry } from "@workspace/db";

// ---------------------------------------------------------------------------
// Configuration — ONE object. The cadence numbers are placeholders pending
// Phil's Packet #1 decision; change them here and nowhere else.
// ---------------------------------------------------------------------------

export const OUTREACH_CONFIG = {
  /** Setup-link lifetime. Days, not hours — travelers don't reply in an hour. */
  tokenTtlDays: 14,
  chase: {
    /** Days after the invite before the first reminder. */
    firstReminderAfterDays: 3,
    /** Minimum days between reminders — the hard cap is one per interval. */
    reminderIntervalDays: 4,
    /** Reminders per traveler before Wander stops and escalates. */
    maxReminders: 3,
    /** Escalate to the organizer when the trip starts within this many days. */
    escalationLeadDays: 7,
  },
} as const;

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Chase state (stored in trip_roster_entries.chase_state jsonb)
// ---------------------------------------------------------------------------

export interface ChaseFailure {
  at: string; // ISO timestamp
  /** Machine reason class, e.g. "email_send_failed" — never contents. */
  reason: string;
}

export interface ChaseState {
  invitesSent: number;
  lastInviteSentAt: string | null;
  remindersSent: number;
  lastReminderSentAt: string | null;
  /** ISO timestamp of the next scheduled chase action, or null when idle. */
  nextDueAt: string | null;
  paused: boolean;
  escalatedAt: string | null;
  lastFailure: ChaseFailure | null;
}

export function emptyChaseState(): ChaseState {
  return {
    invitesSent: 0,
    lastInviteSentAt: null,
    remindersSent: 0,
    lastReminderSentAt: null,
    nextDueAt: null,
    paused: false,
    escalatedAt: null,
    lastFailure: null,
  };
}

/** Defensive read of the jsonb column — unknown shapes degrade to empty. */
export function parseChaseState(raw: unknown): ChaseState {
  if (!raw || typeof raw !== "object") return emptyChaseState();
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const failure =
    r.lastFailure && typeof r.lastFailure === "object"
      ? {
          at: str((r.lastFailure as Record<string, unknown>).at) ?? "",
          reason: str((r.lastFailure as Record<string, unknown>).reason) ?? "unknown",
        }
      : null;
  return {
    invitesSent: num(r.invitesSent),
    lastInviteSentAt: str(r.lastInviteSentAt),
    remindersSent: num(r.remindersSent),
    lastReminderSentAt: str(r.lastReminderSentAt),
    nextDueAt: str(r.nextDueAt),
    paused: r.paused === true,
    escalatedAt: str(r.escalatedAt),
    lastFailure: failure,
  };
}

/** State after an invite (or resend) is delivered: schedule the first reminder. */
export function chaseStateAfterInvite(state: ChaseState, sentAt: Date): ChaseState {
  return {
    ...state,
    invitesSent: state.invitesSent + 1,
    lastInviteSentAt: sentAt.toISOString(),
    nextDueAt: state.paused
      ? state.nextDueAt
      : new Date(sentAt.getTime() + OUTREACH_CONFIG.chase.firstReminderAfterDays * DAY_MS).toISOString(),
    lastFailure: null,
  };
}

/**
 * State after a reminder is delivered. nextDueAt always advances by a full
 * interval — that is what enforces "never more than one reminder per
 * traveler per interval": the next action cannot come due sooner.
 */
export function chaseStateAfterReminder(state: ChaseState, sentAt: Date): ChaseState {
  return {
    ...state,
    remindersSent: state.remindersSent + 1,
    lastReminderSentAt: sentAt.toISOString(),
    nextDueAt: new Date(
      sentAt.getTime() + OUTREACH_CONFIG.chase.reminderIntervalDays * DAY_MS,
    ).toISOString(),
    lastFailure: null,
  };
}

/** State after escalation: chasing stops; the organizer owns it now. */
export function chaseStateAfterEscalation(state: ChaseState, at: Date): ChaseState {
  return { ...state, escalatedAt: at.toISOString(), nextDueAt: null };
}

// ---------------------------------------------------------------------------
// Invite tokens — raw exists only in the link; the DB stores the hash.
// ---------------------------------------------------------------------------

export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashInviteToken(raw: string): string {
  return crypto.createHash("sha256").update(raw.trim()).digest("hex");
}

export function inviteTokenExpiry(now: Date): Date {
  return new Date(now.getTime() + OUTREACH_CONFIG.tokenTtlDays * DAY_MS);
}

export function isInviteTokenUsable(
  row: { usedAt: Date | null; expiresAt: Date },
  now: Date,
): boolean {
  return row.usedAt === null && row.expiresAt.getTime() > now.getTime();
}

/** Setup link for a raw token. Base URL comes from trusted env (see outreach.ts). */
export function buildSetupUrl(appBaseUrl: string, rawToken: string): string {
  return `${appBaseUrl.replace(/\/$/, "")}/traveler-setup?token=${rawToken}`;
}

// ---------------------------------------------------------------------------
// Field names → general-terms labels. Names only, never values.
// ---------------------------------------------------------------------------

const FIELD_LABELS: Record<string, string> = {
  passport: "your passport details",
  passport_number: "your passport details",
  passport_details: "your passport details",
  passport_expiry: "your passport expiry date",
  passport_expiration: "your passport expiry date",
  date_of_birth: "your date of birth",
  dob: "your date of birth",
  legal_name: "your full legal name (exactly as it appears on your passport)",
  full_name: "your full legal name (exactly as it appears on your passport)",
  name: "your full legal name (exactly as it appears on your passport)",
  phone: "your phone number",
  phone_number: "your phone number",
  emergency_contact: "an emergency contact",
  known_traveler_number: "your Known Traveler Number",
  frequent_flyer: "your frequent flyer details",
  frequent_flyer_number: "your frequent flyer details",
};

export function fieldLabel(fieldName: string): string {
  const key = fieldName.trim().toLowerCase();
  return FIELD_LABELS[key] ?? `your ${key.replace(/_/g, " ")}`;
}

export function fieldLabels(fieldNames: readonly string[]): string[] {
  return fieldNames.map(fieldLabel);
}

/** Plain-language rendering of a failure reason class for organizer copy. */
export function failureReasonLabel(reason: string): string {
  switch (reason) {
    case "email_send_failed":
      return "the email could not be sent";
    case "setup_link_unavailable":
      return "the setup link could not be created";
    default:
      return "something went wrong sending it";
  }
}

// ---------------------------------------------------------------------------
// Chase decision — pure. The scheduler executes what this returns.
// ---------------------------------------------------------------------------

export interface ChaseDecisionInput {
  status: string;
  missingFields: readonly string[] | null;
  chaseState: ChaseState;
  /** Trip start as YYYY-MM-DD, or null when unknown. */
  tripStartDate: string | null;
  now: Date;
}

export type ChaseAction =
  | { action: "remind" }
  | { action: "escalate"; reason: "reminders_exhausted" | "deadline_approaching" }
  | { action: "none"; reason: string };

export function decideChaseAction(input: ChaseDecisionInput): ChaseAction {
  const { status, missingFields, chaseState, tripStartDate, now } = input;
  const cfg = OUTREACH_CONFIG.chase;

  if (status !== "invited" && status !== "setting_up") {
    return { action: "none", reason: "status_not_chaseable" };
  }
  if (chaseState.paused) return { action: "none", reason: "paused" };
  if (chaseState.escalatedAt !== null) return { action: "none", reason: "already_escalated" };
  if (!missingFields || missingFields.length === 0) {
    return { action: "none", reason: "nothing_missing" };
  }
  // No invite has actually gone out yet — chasing is not Wander's first move.
  if (chaseState.invitesSent === 0 || chaseState.nextDueAt === null) {
    return { action: "none", reason: "not_scheduled" };
  }

  // Deadline escalation fires even between reminders: the organizer needs
  // time to intervene personally before the trip starts.
  if (tripStartDate) {
    const startMs = Date.parse(`${tripStartDate}T00:00:00Z`);
    if (!Number.isNaN(startMs)) {
      const daysUntil = Math.floor((startMs - now.getTime()) / DAY_MS);
      if (daysUntil >= 0 && daysUntil <= cfg.escalationLeadDays) {
        return { action: "escalate", reason: "deadline_approaching" };
      }
    }
  }

  if (now.getTime() < Date.parse(chaseState.nextDueAt)) {
    return { action: "none", reason: "not_due" };
  }
  if (chaseState.remindersSent >= cfg.maxReminders) {
    return { action: "escalate", reason: "reminders_exhausted" };
  }
  return { action: "remind" };
}

// ---------------------------------------------------------------------------
// Email copy builders — pure; return { subject, text, html }.
// Invariant: the privacy statement always precedes the setup link.
// ---------------------------------------------------------------------------

export interface BuiltEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** "2026-09-24" → "Sep 24, 2026". Unparseable input passes through unchanged. */
export function formatTripDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return isoDate;
  const month = MONTHS[parseInt(m[2], 10) - 1];
  if (!month) return isoDate;
  return `${month} ${parseInt(m[3], 10)}, ${m[1]}`;
}

export interface InviteEmailInput {
  travelerName: string;
  organizerName: string;
  tripTitle: string;
  destination: string;
  startDate: string;
  endDate: string;
  /** General-terms labels of what this trip will ask for. May be empty. */
  requiredFieldLabels: string[];
  setupUrl: string;
}

export function buildInviteEmail(input: InviteEmailInput): BuiltEmail {
  const {
    travelerName, organizerName, tripTitle, destination,
    startDate, endDate, requiredFieldLabels, setupUrl,
  } = input;
  const dates = `${formatTripDate(startDate)} – ${formatTripDate(endDate)}`;
  const askLine =
    requiredFieldLabels.length > 0
      ? `For this trip, Wander will ask you for: ${requiredFieldLabels.join(", ")}.`
      : "Wander will ask you for the travel details this trip needs.";

  const subject = `${organizerName} invited you to "${tripTitle}" on Wander`;

  const text = [
    `Hi ${travelerName},`,
    ``,
    `${organizerName} is planning "${tripTitle}" — ${destination}, ${dates} — and listed you as going.`,
    ``,
    askLine,
    ``,
    `Your details are private. You enter them yourself, directly to Wander. ` +
      `${organizerName} can only see whether your details are complete — never the details themselves. ` +
      `Nobody else on the trip can see them either.`,
    ``,
    `Set up your travel details here (no account or app install needed):`,
    setupUrl,
    ``,
    `This link is just for you and expires in ${OUTREACH_CONFIG.tokenTtlDays} days. ` +
      `If it expires, ${organizerName} can send you a fresh one.`,
    ``,
    `Not going? You can decline from the same link, and Wander will update the roster.`,
    ``,
    `— The Wander team`,
  ].join("\n");

  const html = `
<p>Hi ${escapeHtml(travelerName)},</p>
<p>${escapeHtml(organizerName)} is planning <strong>${escapeHtml(tripTitle)}</strong> — ${escapeHtml(destination)}, ${escapeHtml(dates)} — and listed you as going.</p>
<p>${escapeHtml(askLine)}</p>
<p><strong>Your details are private.</strong> You enter them yourself, directly to Wander. ${escapeHtml(organizerName)} can only see whether your details are complete — never the details themselves. Nobody else on the trip can see them either.</p>
<p><a href="${escapeHtml(setupUrl)}">Set up your travel details</a> — no account or app install needed. This link is just for you and expires in ${OUTREACH_CONFIG.tokenTtlDays} days; if it expires, ${escapeHtml(organizerName)} can send you a fresh one.</p>
<p>Not going? You can decline from the same link, and Wander will update the roster.</p>
<p>— The Wander team</p>
`.trim();

  return { subject, text, html };
}

export interface ReminderEmailInput {
  travelerName: string;
  organizerName: string;
  tripTitle: string;
  /** General-terms labels of what is still missing. */
  missingLabels: string[];
  setupUrl: string;
}

export function buildReminderEmail(input: ReminderEmailInput): BuiltEmail {
  const { travelerName, organizerName, tripTitle, missingLabels, setupUrl } = input;
  const missing = missingLabels.join(", ");

  const subject = `Still needed for "${tripTitle}": a few travel details`;

  const text = [
    `Hi ${travelerName},`,
    ``,
    `A quick reminder from Wander: for "${tripTitle}", we still need ${missing}.`,
    ``,
    `Your details are private — ${organizerName} can only see whether they are complete, never the details themselves.`,
    ``,
    `Add them here:`,
    setupUrl,
    ``,
    `Reminders stop the moment your details are complete.`,
    ``,
    `— The Wander team`,
  ].join("\n");

  const html = `
<p>Hi ${escapeHtml(travelerName)},</p>
<p>A quick reminder from Wander: for <strong>${escapeHtml(tripTitle)}</strong>, we still need ${escapeHtml(missing)}.</p>
<p>Your details are private — ${escapeHtml(organizerName)} can only see whether they are complete, never the details themselves.</p>
<p><a href="${escapeHtml(setupUrl)}">Add your travel details</a></p>
<p>Reminders stop the moment your details are complete.</p>
<p>— The Wander team</p>
`.trim();

  return { subject, text, html };
}

export type OrganizerAlert =
  | {
      kind: "all_delivered";
      organizerName: string;
      tripTitle: string;
      travelerNames: string[];
    }
  | {
      kind: "send_failed";
      organizerName: string;
      tripTitle: string;
      travelerName: string;
      travelerEmail: string;
      reason: string; // reason class — rendered via failureReasonLabel
    }
  | {
      kind: "escalation";
      organizerName: string;
      tripTitle: string;
      startDate: string;
      reason: "reminders_exhausted" | "deadline_approaching";
      pending: Array<{ name: string; missingLabels: string[] }>;
    };

/**
 * Organizer notifications. Status only, always: names, counts, missing
 * field labels, reason classes. There is no code path by which a field
 * value could enter one of these — the inputs don't carry any.
 */
export function buildOrganizerAlertEmail(alert: OrganizerAlert): BuiltEmail {
  switch (alert.kind) {
    case "all_delivered": {
      const subject = `All invitations sent for "${alert.tripTitle}"`;
      const names = alert.travelerNames.join(", ");
      const text = [
        `Hi ${alert.organizerName},`,
        ``,
        `Good news — Wander has sent all ${alert.travelerNames.length} invitation(s) for "${alert.tripTitle}" (${names}).`,
        ``,
        `Wander will remind anyone who hasn't completed their details, and you'll see live status on the trip roster.`,
        ``,
        `— The Wander team`,
      ].join("\n");
      const html = `
<p>Hi ${escapeHtml(alert.organizerName)},</p>
<p>Good news — Wander has sent all ${alert.travelerNames.length} invitation(s) for <strong>${escapeHtml(alert.tripTitle)}</strong> (${escapeHtml(names)}).</p>
<p>Wander will remind anyone who hasn't completed their details, and you'll see live status on the trip roster.</p>
<p>— The Wander team</p>
`.trim();
      return { subject, text, html };
    }
    case "send_failed": {
      const subject = `Invitation problem for "${alert.tripTitle}"`;
      const reason = failureReasonLabel(alert.reason);
      const text = [
        `Hi ${alert.organizerName},`,
        ``,
        `Wander couldn't invite ${alert.travelerName} (${alert.travelerEmail}) to "${alert.tripTitle}" — ${reason}.`,
        ``,
        `Their roster entry is marked "needs attention". Check the email address on the roster and resend the invitation, or share their setup link manually.`,
        ``,
        `— The Wander team`,
      ].join("\n");
      const html = `
<p>Hi ${escapeHtml(alert.organizerName)},</p>
<p>Wander couldn't invite <strong>${escapeHtml(alert.travelerName)}</strong> (${escapeHtml(alert.travelerEmail)}) to <strong>${escapeHtml(alert.tripTitle)}</strong> — ${escapeHtml(reason)}.</p>
<p>Their roster entry is marked "needs attention". Check the email address on the roster and resend the invitation, or share their setup link manually.</p>
<p>— The Wander team</p>
`.trim();
      return { subject, text, html };
    }
    case "escalation": {
      const subject = `Traveler details still missing for "${alert.tripTitle}"`;
      const why =
        alert.reason === "deadline_approaching"
          ? `The trip starts ${formatTripDate(alert.startDate)} and these travelers' details are still incomplete:`
          : `Wander has sent all its reminders and these travelers' details are still incomplete:`;
      const lines = alert.pending.map(
        (p) => `- ${p.name}: still needs ${p.missingLabels.join(", ")}`,
      );
      const text = [
        `Hi ${alert.organizerName},`,
        ``,
        why,
        ``,
        ...lines,
        ``,
        `Wander has stopped reminding them — a personal nudge from you may land better now. You can see live status on the trip roster.`,
        ``,
        `— The Wander team`,
      ].join("\n");
      const htmlLines = alert.pending
        .map(
          (p) =>
            `<li><strong>${escapeHtml(p.name)}</strong>: still needs ${escapeHtml(p.missingLabels.join(", "))}</li>`,
        )
        .join("\n");
      const html = `
<p>Hi ${escapeHtml(alert.organizerName)},</p>
<p>${escapeHtml(why)}</p>
<ul>
${htmlLines}
</ul>
<p>Wander has stopped reminding them — a personal nudge from you may land better now. You can see live status on the trip roster.</p>
<p>— The Wander team</p>
`.trim();
      return { subject, text, html };
    }
  }
}

// ---------------------------------------------------------------------------
// Organizer roster projection (Story 3.2 / §3.3) — status, never contents.
// The roster table holds no profile contents by design; this projection is
// the enforcement point for the organizer-facing shape regardless.
// ---------------------------------------------------------------------------

export interface OrganizerRosterEntryView {
  id: number;
  tripId: number;
  invitedName: string;
  invitedEmail: string | null;
  status: string;
  hasLinkedAccount: boolean;
  /** Field NAMES still outstanding — never values. */
  missingFields: string[];
  chase: {
    invitesSent: number;
    remindersSent: number;
    paused: boolean;
    nextDueAt: string | null;
    escalated: boolean;
    lastFailureReason: string | null;
  };
}

export function projectRosterEntryForOrganizer(
  entry: TripRosterEntry,
): OrganizerRosterEntryView {
  const chase = parseChaseState(entry.chaseState);
  return {
    id: entry.id,
    tripId: entry.tripId,
    invitedName: entry.invitedName,
    invitedEmail: entry.invitedEmail,
    status: entry.status,
    hasLinkedAccount: entry.userId !== null,
    missingFields: [...(entry.missingFields ?? [])],
    chase: {
      invitesSent: chase.invitesSent,
      remindersSent: chase.remindersSent,
      paused: chase.paused,
      nextDueAt: chase.nextDueAt,
      escalated: chase.escalatedAt !== null,
      lastFailureReason: chase.lastFailure?.reason ?? null,
    },
  };
}
