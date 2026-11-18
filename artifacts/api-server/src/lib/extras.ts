/**
 * Extras Service — the extras pass, persisted (architecture-north-star
 * §7; GOAL.md "Extras thinking"; TC-8).
 *
 * The pure engine (extrasLogic.ts) decides WHAT to suggest from a
 * trip's character; this service resolves the trip's facts, runs the
 * pass, and remembers the outcome in `extras_suggestions`:
 *
 * - IDEMPOTENT + DISMISSAL MEMORY come from the (trip_id, item_key)
 *   unique index: a pass inserts only item keys the trip has never
 *   seen. Re-running a pass — at materialization, on flight/stay add,
 *   or on demand — can never duplicate a suggestion or resurrect a
 *   dismissed one.
 * - The pass NEVER books anything. Accepting a suggestion records the
 *   traveler's intent; arranging it rides the January Booking Gate /
 *   Concierge (§5/§6.5).
 * - Trigger hooks (intake materialization, flight add, stay add) call
 *   runExtrasPassBestEffort: a pass failure is logged, never allowed
 *   to fail the operation that triggered it (the calendar-sync
 *   precedent).
 */

import { and, eq } from "drizzle-orm";
import {
  db,
  accommodationsTable,
  carRentalsTable,
  extrasSuggestionsTable,
  flightsTable,
  intakeSessionsTable,
  travelerRulesTable,
  tripParticipantsTable,
  tripsTable,
  type ExtrasSuggestion,
  type ExtrasTrigger,
} from "@workspace/db";
import { logger } from "./logger";
import {
  assertPricingHonesty,
  buildBudgetReport,
  generateSuggestions,
  matchPacks,
  tripDaysBetween,
  type ExtrasBudgetReport,
  type TripFacts,
} from "./extrasLogic";
import type { StyleSlot, TierName } from "./intakeLogic";

export class ExtrasAccessDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtrasAccessDenied";
  }
}

export class ExtrasNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtrasNotFound";
  }
}

/** Same idiom as agentTools.assertTripAccess: super_admin bypasses,
 * everyone else must be a trip participant. */
async function assertTripAccess(userId: number, role: string, tripId: number): Promise<void> {
  if (role === "super_admin") return;
  const [participant] = await db
    .select()
    .from(tripParticipantsTable)
    .where(and(eq(tripParticipantsTable.tripId, tripId), eq(tripParticipantsTable.userId, userId)));
  if (!participant) {
    throw new ExtrasAccessDenied(`You are not a participant of trip ${tripId}.`);
  }
}

// ─── Fact resolution ─────────────────────────────────────────────────────────

interface IntakeStyle {
  style: StyleSlot | null;
  destinationText: string | null;
  organizerUserId: number | null;
}

/** The intake session that materialized this trip, if any, carries the
 * STYLE slot (trip character + tier + Family Budget cap) and the
 * destination as the traveler phrased it. Trips created outside intake
 * simply have no style — character then rests on the trip's own text. */
async function loadIntakeStyle(tripId: number): Promise<IntakeStyle> {
  const [session] = await db
    .select()
    .from(intakeSessionsTable)
    .where(eq(intakeSessionsTable.draftTripId, tripId));
  if (!session) return { style: null, destinationText: null, organizerUserId: null };
  const slots = (session.slots ?? {}) as Record<string, { value?: unknown } | undefined>;
  const style = (slots.style?.value as StyleSlot | undefined) ?? null;
  const destination = (slots.destination?.value as { text?: string } | undefined)?.text ?? null;
  return { style, destinationText: destination, organizerUserId: session.userId };
}

/** Budget cap fallback: the organizer's active budget_cap rule (§4.1)
 * when the intake style slot didn't capture one. */
async function loadRuleBudgetCap(
  userId: number,
): Promise<{ amountMinor: number; currency: string } | null> {
  const rules = await db
    .select()
    .from(travelerRulesTable)
    .where(and(eq(travelerRulesTable.userId, userId), eq(travelerRulesTable.active, true)));
  for (const rule of rules) {
    if (rule.ruleType !== "budget_cap") continue;
    const params = (rule.params ?? {}) as { capMinor?: unknown; currency?: unknown };
    if (typeof params.capMinor === "number" && typeof params.currency === "string") {
      return { amountMinor: params.capMinor, currency: params.currency };
    }
  }
  return null;
}

export async function resolveTripFacts(tripId: number): Promise<TripFacts | null> {
  const [trip] = await db.select().from(tripsTable).where(eq(tripsTable.id, tripId));
  if (!trip) return null;

  const [intake, participants, stays, flights, rentals] = await Promise.all([
    loadIntakeStyle(tripId),
    db.select().from(tripParticipantsTable).where(eq(tripParticipantsTable.tripId, tripId)),
    db.select().from(accommodationsTable).where(eq(accommodationsTable.tripId, tripId)),
    db.select().from(flightsTable).where(eq(flightsTable.tripId, tripId)),
    db.select().from(carRentalsTable).where(eq(carRentalsTable.tripId, tripId)),
  ]);

  const admin = participants.find((p) => p.isTripAdmin) ?? participants[0];
  const organizerUserId = intake.organizerUserId ?? admin?.userId ?? null;

  const style = intake.style;
  let budgetCap: TripFacts["budgetCap"] = null;
  if (style?.budgetCapMinor !== undefined) {
    budgetCap = { amountMinor: style.budgetCapMinor, currency: style.budgetCurrency ?? "USD" };
  } else if (organizerUserId !== null) {
    budgetCap = await loadRuleBudgetCap(organizerUserId);
  }

  const flightAirports: string[] = [];
  for (const f of flights) {
    // Airport fields are free text in the legacy schema ("Munich (MUC)"
    // or "MUC"); pull a trailing/standalone IATA code where present.
    for (const raw of [f.departureAirport, f.arrivalAirport]) {
      const m = /\b([A-Za-z]{3})\b/.exec(raw ?? "");
      if (m) flightAirports.push(m[1].toUpperCase());
    }
  }

  return {
    tripId,
    destinationText: [trip.destination, intake.destinationText].filter(Boolean).join(" — "),
    styleText: style?.text ?? trip.title ?? null,
    tier: (style?.tier as TierName | undefined) ?? "premium",
    budgetCap,
    startDate: trip.startDate,
    endDate: trip.endDate,
    tripDays: tripDaysBetween(trip.startDate, trip.endDate),
    participantCount: Math.max(1, participants.length),
    flightCount: flights.length,
    flightAirports,
    hasStay: stays.length > 0,
    hasHomeStay: stays.some((s) => s.type === "airbnb"),
    hasCarRental: rentals.length > 0,
  };
}

// ─── The pass ────────────────────────────────────────────────────────────────

export interface ExtrasPassResult {
  tripId: number;
  trigger: ExtrasTrigger;
  /** Packs the trip's character matched ([] = no character, no pass). */
  packsMatched: string[];
  /** Suggestions this pass newly surfaced. */
  created: ExtrasSuggestion[];
  /** All current suggestions for the trip after the pass. */
  suggestions: ExtrasSuggestion[];
  tier: TierName;
  /** Present when the trip carries a budget cap (always reported at
   * Family Budget): the running extras total against the cap. */
  budgetReport: ExtrasBudgetReport | null;
}

export async function runExtrasPass(
  tripId: number,
  trigger: ExtrasTrigger,
): Promise<ExtrasPassResult | null> {
  const facts = await resolveTripFacts(tripId);
  if (!facts) return null;

  const packsMatched = matchPacks(facts);
  const generated = generateSuggestions(facts);
  assertPricingHonesty(generated);

  const existing = await db
    .select()
    .from(extrasSuggestionsTable)
    .where(eq(extrasSuggestionsTable.tripId, tripId));
  const seen = new Set(existing.map((s) => s.itemKey));

  const created: ExtrasSuggestion[] = [];
  for (const suggestion of generated) {
    if (seen.has(suggestion.itemKey)) continue; // already surfaced once — never duplicate, never resurrect
    const [row] = await db
      .insert(extrasSuggestionsTable)
      .values({
        tripId,
        pack: suggestion.pack,
        itemKey: suggestion.itemKey,
        title: suggestion.title,
        detail: suggestion.detail,
        detailData: suggestion.detailData,
        priceAmountMinor: suggestion.priceAmountMinor,
        priceCurrency: suggestion.priceCurrency,
        priceNature: suggestion.priceNature,
        state: "suggested",
        trigger,
      })
      .returning();
    if (row) created.push(row);
  }

  const suggestions = await db
    .select()
    .from(extrasSuggestionsTable)
    .where(eq(extrasSuggestionsTable.tripId, tripId));

  const budgetReport = facts.budgetCap ? buildBudgetReport(facts.budgetCap, suggestions) : null;

  if (created.length > 0) {
    logger.info(
      { tripId, trigger, packsMatched, created: created.map((c) => c.itemKey) },
      "[Extras] pass surfaced new suggestions",
    );
  }
  return { tripId, trigger, packsMatched, created, suggestions, tier: facts.tier, budgetReport };
}

/** Trigger-hook variant: log and swallow failures — an extras pass must
 * never fail the materialization / flight add / stay add that fired it. */
export async function runExtrasPassBestEffort(
  tripId: number,
  trigger: ExtrasTrigger,
): Promise<void> {
  try {
    await runExtrasPass(tripId, trigger);
  } catch (err) {
    logger.error({ err, tripId, trigger }, "[Extras] pass failed (best-effort hook)");
  }
}

// ─── Traveler-facing reads / state ───────────────────────────────────────────

export async function listExtrasSuggestions(
  tripId: number,
  userId: number,
  role: string,
): Promise<ExtrasSuggestion[]> {
  await assertTripAccess(userId, role, tripId);
  return db
    .select()
    .from(extrasSuggestionsTable)
    .where(eq(extrasSuggestionsTable.tripId, tripId));
}

export async function setExtrasSuggestionState(
  suggestionId: number,
  userId: number,
  role: string,
  state: "accepted" | "dismissed",
): Promise<ExtrasSuggestion> {
  const [row] = await db
    .select()
    .from(extrasSuggestionsTable)
    .where(eq(extrasSuggestionsTable.id, suggestionId));
  if (!row) throw new ExtrasNotFound(`No extras suggestion ${suggestionId}.`);
  await assertTripAccess(userId, role, row.tripId);
  const [updated] = await db
    .update(extrasSuggestionsTable)
    .set({ state, updatedAt: new Date() })
    .where(eq(extrasSuggestionsTable.id, suggestionId))
    .returning();
  return updated;
}
