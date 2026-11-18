/**
 * Intake Service — the DB-backed half of the intake state machine
 * (architecture-north-star §2; pure logic in intakeLogic.ts).
 *
 * Owns intake_sessions persistence, ownership enforcement, and
 * materialization: at REVIEW confirmation, one transaction creates the
 * draft trip, the organizer's participant row, and one roster entry per
 * named traveler (ADR-5), then re-keys the session's marco_messages to
 * the new trip (ADR-3) so the conversation continues as a normal
 * per-trip Marco conversation.
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  intakeSessionsTable,
  marcoMessagesTable,
  tripParticipantsTable,
  tripRosterEntriesTable,
  tripsTable,
  type IntakeSession,
} from "@workspace/db";
import {
  applySkip,
  applySlotWrite,
  buildMaterializationPlan,
  buildReviewSummary,
  deriveState,
  emptyIntakeData,
  markIntent,
  nextAsk,
  type IntakeData,
  type IntakeStateName,
  type NextAsk,
  type SlotWrite,
} from "./intakeLogic";
import { getSavedGroupWithMembers } from "./travelerContext";
import { logger } from "./logger";

export class IntakeAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeAccessDenied";
  }
}

export class IntakeMaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeMaterializationError";
  }
}

export interface IntakeSessionView {
  id: number;
  userId: number;
  state: IntakeStateName;
  slots: Omit<IntakeData, "intentCaptured" | "openItems">;
  openItems: string[];
  draftTripId: number | null;
  channel: string;
  questionsAsked: number;
  nextAsk: NextAsk | null;
  reviewSummary: string[];
}

// ─── Row ↔ machine data ──────────────────────────────────────────────────────

interface StoredSlots {
  intentCaptured?: boolean;
  destination?: IntakeData["destination"];
  party?: IntakeData["party"];
  dates?: IntakeData["dates"];
  style?: IntakeData["style"];
}

function rowToData(row: IntakeSession): IntakeData {
  const raw = (row.slots ?? {}) as StoredSlots;
  const data: IntakeData = {
    intentCaptured: raw.intentCaptured === true,
    openItems: Array.isArray(row.openItems) ? [...row.openItems] : [],
  };
  if (raw.destination) data.destination = raw.destination;
  if (raw.party) data.party = raw.party;
  if (raw.dates) data.dates = raw.dates;
  if (raw.style) data.style = raw.style;
  return data;
}

function dataToStoredSlots(data: IntakeData): StoredSlots {
  const out: StoredSlots = { intentCaptured: data.intentCaptured };
  if (data.destination) out.destination = data.destination;
  if (data.party) out.party = data.party;
  if (data.dates) out.dates = data.dates;
  if (data.style) out.style = data.style;
  return out;
}

function rowToView(row: IntakeSession): IntakeSessionView {
  const data = rowToData(row);
  const slots: IntakeSessionView["slots"] = {};
  if (data.destination) slots.destination = data.destination;
  if (data.party) slots.party = data.party;
  if (data.dates) slots.dates = data.dates;
  if (data.style) slots.style = data.style;
  return {
    id: row.id,
    userId: row.userId,
    state: deriveState(data, row.draftTripId),
    slots,
    openItems: [...data.openItems],
    draftTripId: row.draftTripId,
    channel: row.channel,
    questionsAsked: row.questionsAsked,
    nextAsk: nextAsk(data, row.draftTripId),
    reviewSummary: buildReviewSummary(data),
  };
}

async function persistData(row: IntakeSession, data: IntakeData): Promise<IntakeSession> {
  const [updated] = await db
    .update(intakeSessionsTable)
    .set({
      slots: dataToStoredSlots(data) as Record<string, unknown>,
      openItems: data.openItems,
      state: deriveState(data, row.draftTripId),
      updatedAt: new Date(),
    })
    .where(eq(intakeSessionsTable.id, row.id))
    .returning();
  return updated ?? { ...row, slots: dataToStoredSlots(data), openItems: data.openItems };
}

// ─── Reads & access ──────────────────────────────────────────────────────────

export async function loadIntakeSession(sessionId: number): Promise<IntakeSessionView | null> {
  const [row] = await db
    .select()
    .from(intakeSessionsTable)
    .where(eq(intakeSessionsTable.id, sessionId));
  return row ? rowToView(row) : null;
}

async function loadSessionRow(sessionId: number): Promise<IntakeSession> {
  const [row] = await db
    .select()
    .from(intakeSessionsTable)
    .where(eq(intakeSessionsTable.id, sessionId));
  if (!row) throw new IntakeAccessDenied(`Intake session ${sessionId} not found.`);
  return row;
}

/**
 * Ownership gate, mirroring assertTripAccess: the session's owner or a
 * super_admin. (The §3.3 vault exception does not apply here — a session
 * holds no vault data — but no other role gets in.)
 */
export async function assertIntakeAccess(
  userId: number,
  role: string,
  sessionId: number,
): Promise<IntakeSessionView> {
  const row = await loadSessionRow(sessionId);
  if (role !== "super_admin" && row.userId !== userId) {
    throw new IntakeAccessDenied(`Not your intake session ${sessionId}.`);
  }
  return rowToView(row);
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export async function createIntakeSession(
  userId: number,
  channel: "text" | "voice" = "text",
): Promise<IntakeSessionView> {
  const data = emptyIntakeData();
  const [row] = await db
    .insert(intakeSessionsTable)
    .values({
      userId,
      state: "OPENING",
      slots: dataToStoredSlots(data) as Record<string, unknown>,
      openItems: [],
      channel,
    })
    .returning();
  logger.info({ userId, intakeSessionId: row.id, channel }, "[Intake] session created");
  return rowToView(row);
}

/**
 * The first user turn in a session is the intent statement (Story 1.1):
 * mark it so the machine leaves OPENING. Idempotent.
 */
export async function markIntakeIntent(sessionId: number): Promise<IntakeSessionView> {
  const row = await loadSessionRow(sessionId);
  const data = rowToData(row);
  if (data.intentCaptured) return rowToView(row);
  const updated = await persistData(row, markIntent(data));
  return rowToView(updated);
}

async function applyEvent(
  sessionId: number,
  userId: number,
  role: string,
  event: (data: IntakeData) => IntakeData,
): Promise<IntakeSessionView> {
  const row = await loadSessionRow(sessionId);
  if (role !== "super_admin" && row.userId !== userId) {
    throw new IntakeAccessDenied(`Not your intake session ${sessionId}.`);
  }
  if (row.draftTripId !== null) {
    throw new IntakeMaterializationError("This intake already produced a trip; the conversation continues on the trip.");
  }
  const updated = await persistData(row, event(rowToData(row)));
  return rowToView(updated);
}

export async function applyIntakeSlotWrite(
  sessionId: number,
  userId: number,
  role: string,
  write: SlotWrite,
): Promise<IntakeSessionView> {
  return applyEvent(sessionId, userId, role, (data) => applySlotWrite(data, write));
}

export async function applyIntakeSkip(
  sessionId: number,
  userId: number,
  role: string,
  item: string,
): Promise<IntakeSessionView> {
  return applyEvent(sessionId, userId, role, (data) => applySkip(data, item));
}

export class IntakeGroupNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeGroupNotFound";
  }
}

/**
 * Context prefill for the PARTY state (Stories 6.3/6.5, §4.1): fill the
 * party slot from one of the organizer's saved groups in ONE step. The
 * slot lands with provenance `from_context` — this is the concrete
 * mechanism behind "asks less over time": the party question is never
 * asked, and the review summary marks the answer as coming from the
 * traveler's profile, correctable in one utterance. Suggesting never
 * auto-invites: outreach still requires the organizer's explicit
 * send-invites action (Story 4.1).
 */
export async function applyIntakePartyFromGroup(
  sessionId: number,
  userId: number,
  role: string,
  groupId: number,
): Promise<IntakeSessionView> {
  const row = await loadSessionRow(sessionId);
  if (role !== "super_admin" && row.userId !== userId) {
    throw new IntakeAccessDenied(`Not your intake session ${sessionId}.`);
  }
  if (row.draftTripId !== null) {
    throw new IntakeMaterializationError("This intake already produced a trip; the conversation continues on the trip.");
  }
  const group = await getSavedGroupWithMembers(row.userId, groupId);
  if (!group) {
    throw new IntakeGroupNotFound(`Saved group ${groupId} was not found among the traveler's groups.`);
  }
  if (group.members.length === 0) {
    throw new IntakeGroupNotFound(`Saved group "${group.name}" has no members to fill the party with.`);
  }
  const updated = await persistData(
    row,
    applySlotWrite(rowToData(row), {
      slot: "party",
      value: {
        solo: false,
        travelers: group.members.map((m) => ({
          name: m.name,
          ...(m.email ? { email: m.email } : {}),
        })),
      },
      provenance: "from_context",
    }),
  );
  logger.info(
    { userId: row.userId, intakeSessionId: sessionId, groupId, members: group.members.length },
    "[Intake] party filled from saved group",
  );
  return rowToView(updated);
}

/**
 * Asks-less accounting (§4.4): after a completed intake chat turn, count
 * one issued question when the machine is left in a question-asking
 * state. REVIEW and MATERIALIZED turns ask nothing.
 */
export async function recordIntakeTurnAsk(sessionId: number): Promise<void> {
  const [row] = await db
    .select()
    .from(intakeSessionsTable)
    .where(eq(intakeSessionsTable.id, sessionId));
  if (!row) return;
  const state = deriveState(rowToData(row), row.draftTripId);
  if (state === "DESTINATION" || state === "PARTY" || state === "DATES" || state === "STYLE") {
    await db
      .update(intakeSessionsTable)
      .set({ questionsAsked: row.questionsAsked + 1, updatedAt: new Date() })
      .where(eq(intakeSessionsTable.id, sessionId));
  }
}

// ─── Materialization (§2.3) ──────────────────────────────────────────────────

export interface MaterializeResult {
  tripId: number;
  view: IntakeSessionView;
}

export async function materializeIntake(
  sessionId: number,
  userId: number,
  role: string,
): Promise<MaterializeResult> {
  const row = await loadSessionRow(sessionId);
  if (role !== "super_admin" && row.userId !== userId) {
    throw new IntakeAccessDenied(`Not your intake session ${sessionId}.`);
  }
  if (row.draftTripId !== null) {
    // Idempotent: confirming twice returns the same trip, never a second one.
    return { tripId: row.draftTripId, view: rowToView(row) };
  }
  const data = rowToData(row);
  const check = buildMaterializationPlan(data);
  if (!check.ok) throw new IntakeMaterializationError(check.reason);
  const plan = check.plan;

  const tripId = await db.transaction(async (tx) => {
    const [trip] = await tx.insert(tripsTable).values(plan.trip).returning();
    await tx.insert(tripParticipantsTable).values({
      tripId: trip.id,
      userId: row.userId,
      isTripAdmin: true,
    });
    if (plan.roster.length > 0) {
      await tx.insert(tripRosterEntriesTable).values(
        plan.roster.map((r) => ({
          tripId: trip.id,
          invitedName: r.invitedName,
          invitedEmail: r.invitedEmail,
          status: "invited",
        })),
      );
    }
    // ADR-3 re-key: the intake conversation becomes the trip's conversation.
    await tx
      .update(marcoMessagesTable)
      .set({ tripId: trip.id, intakeSessionId: null })
      .where(
        and(
          eq(marcoMessagesTable.intakeSessionId, sessionId),
          eq(marcoMessagesTable.userId, row.userId),
        ),
      );
    await tx
      .update(intakeSessionsTable)
      .set({ draftTripId: trip.id, state: "MATERIALIZED", updatedAt: new Date() })
      .where(eq(intakeSessionsTable.id, sessionId));
    return trip.id;
  });

  logger.info(
    { userId: row.userId, intakeSessionId: sessionId, tripId, rosterCount: plan.roster.length },
    "[Intake] session materialized into draft trip",
  );
  const view = await loadIntakeSession(sessionId);
  return { tripId, view: view ?? rowToView({ ...row, draftTripId: tripId }) };
}
