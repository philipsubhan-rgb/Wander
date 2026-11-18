/**
 * Context/Profile Service — context layer (architecture-north-star §4).
 *
 * Owns the context store: traveler_context (home base/airports),
 * traveler_rules (hard FILTER / preference RANK — the mechanisms live
 * in rulesEngine.ts), traveler_companions, and saved_groups. Same
 * discipline as the vault next door: this module is the only reader of
 * these tables; routes and tools call the service.
 *
 * Learned values are PROPOSALS, never defaults (Story 6.1): a learned
 * home base/airports write lands unconfirmed, never overwrites a
 * confirmed value, and takes effect only when the traveler confirms.
 * The digest this module serves (§4.3) therefore separates what is
 * known (confirmed) from what is merely proposed.
 *
 * Companions store only what the organizer provided (Story 6.3) plus a
 * link to that traveler's user record when their email matches one —
 * the link is an id; their private data is never read or copied (§3.3).
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  savedGroupsTable,
  travelerCompanionsTable,
  travelerContextTable,
  travelerRulesTable,
  tripParticipantsTable,
  tripsTable,
  usersTable,
  type RuleClass,
  type RuleScope,
  type RuleType,
  type SavedGroup,
  type TravelerCompanion,
  type TravelerContext,
  type TravelerRule,
} from "@workspace/db";
import {
  RuleValidationError,
  validateRuleParams,
  type RuleInput,
} from "./rulesEngine.js";
import { logger } from "./logger.js";
import { hasFreeBusyAccount } from "./calendarFreeBusy.js";

export class ContextValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextValidationError";
  }
}

export type ContextSource = "explicit" | "learned";

// ─── Home base & airports (Story 6.1) ────────────────────────────────────────

export interface HomeBaseInput {
  text: string;
  lat?: number | null;
  lon?: number | null;
  source: ContextSource;
}

async function loadContextRow(userId: number): Promise<TravelerContext | null> {
  const [row] = await db
    .select()
    .from(travelerContextTable)
    .where(eq(travelerContextTable.userId, userId));
  return row ?? null;
}

async function upsertContextRow(
  userId: number,
  set: Partial<{
    homeBase: string | null;
    homeBaseLat: number | null;
    homeBaseLon: number | null;
    homeBaseSource: string | null;
    homeBaseConfirmed: boolean;
    homeAirports: string[];
    homeAirportsSource: string | null;
    homeAirportsConfirmed: boolean;
  }>,
): Promise<TravelerContext> {
  const existing = await loadContextRow(userId);
  if (existing) {
    const [updated] = await db
      .update(travelerContextTable)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(travelerContextTable.userId, userId))
      .returning();
    return updated ?? { ...existing, ...set };
  }
  const [created] = await db
    .insert(travelerContextTable)
    .values({ userId, ...set })
    .returning();
  return created;
}

/**
 * Set the home base. Explicit writes are born confirmed. A LEARNED
 * write is a proposal: it lands unconfirmed, and it never overwrites a
 * value the traveler has already confirmed.
 */
export async function setHomeBase(
  userId: number,
  input: HomeBaseInput,
): Promise<TravelerContext> {
  const text = input.text.trim();
  if (!text) throw new ContextValidationError("Home base must not be empty.");
  const existing = await loadContextRow(userId);
  if (input.source === "learned" && existing?.homeBase && existing.homeBaseConfirmed) {
    return existing; // a proposal never displaces a confirmed default
  }
  const row = await upsertContextRow(userId, {
    homeBase: text,
    homeBaseLat: input.lat ?? null,
    homeBaseLon: input.lon ?? null,
    homeBaseSource: input.source,
    homeBaseConfirmed: input.source === "explicit",
  });
  logger.info({ userId, source: input.source }, "[Context] home base set");
  return row;
}

/**
 * Set the ordered home airports (most-preferred first). Same
 * learned-is-a-proposal semantics as the home base.
 */
export async function setHomeAirports(
  userId: number,
  airports: string[],
  source: ContextSource,
): Promise<TravelerContext> {
  const codes = [...new Set(airports.map((a) => a.trim().toUpperCase()).filter(Boolean))];
  if (codes.length === 0 || codes.some((c) => !/^[A-Z]{3}$/.test(c))) {
    throw new ContextValidationError("Home airports must be IATA codes (e.g. EWR, PHL).");
  }
  const existing = await loadContextRow(userId);
  if (
    source === "learned" &&
    existing &&
    existing.homeAirports.length > 0 &&
    existing.homeAirportsConfirmed
  ) {
    return existing;
  }
  const row = await upsertContextRow(userId, {
    homeAirports: codes,
    homeAirportsSource: source,
    homeAirportsConfirmed: source === "explicit",
  });
  logger.info({ userId, source, count: codes.length }, "[Context] home airports set");
  return row;
}

/** Confirm pending learned proposals (home base and/or airports). */
export async function confirmLearnedHome(userId: number): Promise<TravelerContext | null> {
  const existing = await loadContextRow(userId);
  if (!existing) return null;
  const set: Partial<{ homeBaseConfirmed: boolean; homeAirportsConfirmed: boolean }> = {};
  if (existing.homeBase && !existing.homeBaseConfirmed) set.homeBaseConfirmed = true;
  if (existing.homeAirports.length > 0 && !existing.homeAirportsConfirmed) {
    set.homeAirportsConfirmed = true;
  }
  if (Object.keys(set).length === 0) return existing;
  const row = await upsertContextRow(userId, set);
  logger.info({ userId }, "[Context] learned home values confirmed");
  return row;
}

// ─── Rules (Story 6.4) ───────────────────────────────────────────────────────

export interface AddRuleInput {
  ruleClass: RuleClass;
  ruleType: RuleType;
  params: Record<string, unknown>;
  scope?: RuleScope;
  source?: ContextSource;
}

const RULE_CLASSES: readonly string[] = ["hard", "preference"];
const RULE_SCOPES: readonly string[] = ["all", "work", "personal"];
const RULE_SOURCES: readonly string[] = ["explicit", "learned"];

export async function addRule(userId: number, input: AddRuleInput): Promise<TravelerRule> {
  if (!RULE_CLASSES.includes(input.ruleClass)) {
    throw new ContextValidationError(`Unknown rule class "${String(input.ruleClass)}".`);
  }
  const scope = input.scope ?? "all";
  if (!RULE_SCOPES.includes(scope)) {
    throw new ContextValidationError(`Unknown rule scope "${String(scope)}".`);
  }
  const source = input.source ?? "explicit";
  if (!RULE_SOURCES.includes(source)) {
    throw new ContextValidationError(`Unknown rule source "${String(source)}".`);
  }
  // Params are validated/normalized by the engine — the same rules the
  // predicates enforce are the rules a write must satisfy.
  const params = validateRuleParams(input.ruleType, input.params);
  const [row] = await db
    .insert(travelerRulesTable)
    .values({
      userId,
      ruleClass: input.ruleClass,
      ruleType: input.ruleType,
      params,
      scope,
      source,
      active: true,
    })
    .returning();
  logger.info(
    { userId, ruleId: row.id, ruleClass: input.ruleClass, ruleType: input.ruleType, scope },
    "[Context] rule added",
  );
  return row;
}

export async function listRules(
  userId: number,
  opts: { activeOnly?: boolean } = {},
): Promise<TravelerRule[]> {
  const rows = await db
    .select()
    .from(travelerRulesTable)
    .where(eq(travelerRulesTable.userId, userId))
    .orderBy(travelerRulesTable.id);
  return opts.activeOnly === false ? rows : rows.filter((r) => r.active);
}

/** Deactivate one of the traveler's OWN rules. Returns false if not theirs. */
export async function deactivateRule(userId: number, ruleId: number): Promise<boolean> {
  const [row] = await db
    .select()
    .from(travelerRulesTable)
    .where(and(eq(travelerRulesTable.id, ruleId), eq(travelerRulesTable.userId, userId)));
  if (!row) return false;
  await db
    .update(travelerRulesTable)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(travelerRulesTable.id, ruleId));
  logger.info({ userId, ruleId }, "[Context] rule deactivated");
  return true;
}

export function ruleRowToInput(row: TravelerRule): RuleInput {
  return {
    id: row.id,
    ruleClass: row.ruleClass as RuleClass,
    ruleType: row.ruleType as RuleType,
    params: (row.params ?? {}) as Record<string, unknown>,
    scope: row.scope as RuleScope,
    source: row.source === "learned" ? "learned" : "explicit",
    active: row.active,
  };
}

// ─── Companions & saved groups (Story 6.3) ───────────────────────────────────

export async function addCompanion(
  userId: number,
  input: { name: string; email?: string },
): Promise<TravelerCompanion> {
  const name = input.name.trim();
  if (!name) throw new ContextValidationError("A companion needs a name.");
  const email = input.email?.trim() ? input.email.trim().toLowerCase() : null;
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ContextValidationError(`"${email}" doesn't look like a valid email address.`);
  }
  // Link — by id only — when the email belongs to a Wander user. Their
  // data is never read or copied; the link just says "same person".
  let linkedUserId: number | null = null;
  if (email !== null) {
    const [user] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.email, email));
    linkedUserId = user?.id ?? null;
  }
  const [row] = await db
    .insert(travelerCompanionsTable)
    .values({ userId, name, email, linkedUserId })
    .returning();
  logger.info({ userId, companionId: row.id, linked: linkedUserId !== null }, "[Context] companion added");
  return row;
}

export async function listCompanions(userId: number): Promise<TravelerCompanion[]> {
  return db
    .select()
    .from(travelerCompanionsTable)
    .where(eq(travelerCompanionsTable.userId, userId))
    .orderBy(travelerCompanionsTable.id);
}

export interface SavedGroupView {
  id: number;
  name: string;
  members: Array<{ companionId: number; name: string; email: string | null }>;
}

function groupView(group: SavedGroup, companionsById: Map<number, TravelerCompanion>): SavedGroupView {
  return {
    id: group.id,
    name: group.name,
    members: (group.memberCompanionIds ?? [])
      .map((id) => companionsById.get(id))
      .filter((c): c is TravelerCompanion => c !== undefined)
      .map((c) => ({ companionId: c.id, name: c.name, email: c.email })),
  };
}

export async function createSavedGroup(
  userId: number,
  input: { name: string; companionIds: number[] },
): Promise<SavedGroupView> {
  const name = input.name.trim();
  if (!name) throw new ContextValidationError("A saved group needs a name.");
  const ids = [...new Set(input.companionIds)];
  if (ids.length === 0) {
    throw new ContextValidationError("A saved group needs at least one companion.");
  }
  const companions = await db
    .select()
    .from(travelerCompanionsTable)
    .where(
      and(
        eq(travelerCompanionsTable.userId, userId),
        inArray(travelerCompanionsTable.id, ids),
      ),
    );
  if (companions.length !== ids.length) {
    throw new ContextValidationError("Every group member must be one of your companions.");
  }
  const [row] = await db
    .insert(savedGroupsTable)
    .values({ userId, name, memberCompanionIds: ids })
    .returning();
  logger.info({ userId, groupId: row.id, members: ids.length }, "[Context] saved group created");
  return groupView(row, new Map(companions.map((c) => [c.id, c])));
}

export async function listSavedGroups(userId: number): Promise<SavedGroupView[]> {
  const [groups, companions] = await Promise.all([
    db.select().from(savedGroupsTable).where(eq(savedGroupsTable.userId, userId)).orderBy(savedGroupsTable.id),
    listCompanions(userId),
  ]);
  const byId = new Map(companions.map((c) => [c.id, c]));
  return groups.map((g) => groupView(g, byId));
}

/** One of the organizer's own groups, members resolved. Null if not theirs. */
export async function getSavedGroupWithMembers(
  userId: number,
  groupId: number,
): Promise<SavedGroupView | null> {
  const [group] = await db
    .select()
    .from(savedGroupsTable)
    .where(and(eq(savedGroupsTable.id, groupId), eq(savedGroupsTable.userId, userId)));
  if (!group) return null;
  const companions = await listCompanions(userId);
  return groupView(group, new Map(companions.map((c) => [c.id, c])));
}

// ─── Destination suggestions (Story 1.2 narrowing, §4.1) ─────────────────────

export interface DestinationSuggestion {
  text: string;
  reason: string;
}

/**
 * Rank past destinations for the DESTINATION step's narrowing
 * suggestions: most-visited first, most recent visit breaks ties.
 * Pure — the service feeds it the traveler's trip rows.
 */
export function rankDestinationSuggestions(
  trips: Array<{ destination: string; startDate: string }>,
): DestinationSuggestion[] {
  const byDestination = new Map<string, { count: number; latest: string }>();
  for (const t of trips) {
    const key = t.destination.trim();
    if (!key) continue;
    const cur = byDestination.get(key) ?? { count: 0, latest: t.startDate };
    cur.count += 1;
    if (t.startDate > cur.latest) cur.latest = t.startDate;
    byDestination.set(key, cur);
  }
  return [...byDestination.entries()]
    .sort((a, b) => b[1].count - a[1].count || (a[1].latest < b[1].latest ? 1 : -1))
    .slice(0, 3)
    .map(([text, s]) => ({
      text,
      reason:
        s.count > 1
          ? `you've been ${s.count} times — most recently ${s.latest.slice(0, 4)}`
          : `from your ${s.latest.slice(0, 4)} trip`,
    }));
}

async function loadDestinationSuggestions(userId: number): Promise<DestinationSuggestion[]> {
  const rows = await db
    .select({ destination: tripsTable.destination, startDate: tripsTable.startDate })
    .from(tripsTable)
    .innerJoin(tripParticipantsTable, eq(tripParticipantsTable.tripId, tripsTable.id))
    .where(eq(tripParticipantsTable.userId, userId))
    .orderBy(desc(tripsTable.startDate));
  return rankDestinationSuggestions(rows);
}

// ─── The digest (§4.3 — what the planner snapshot renders) ───────────────────

export interface ContextDigest {
  /** Confirmed home base — the only one Marco may treat as default. */
  homeBase: { text: string; lat: number | null; lon: number | null } | null;
  /** Confirmed ordered home airports. */
  homeAirports: string[];
  /** Unconfirmed learned proposals — stated as proposals, never assumed. */
  proposedHomeBase: string | null;
  proposedHomeAirports: string[];
  hardRules: RuleInput[];
  preferences: RuleInput[];
  companions: Array<{ id: number; name: string; email: string | null }>;
  groups: SavedGroupView[];
  destinationSuggestions: DestinationSuggestion[];
  /**
   * §4.1: the traveler has a calendar connected that free/busy can be
   * read from. A FACT only — busy data itself never enters the digest
   * (free/busy is read live at date-suggestion time, never stored).
   */
  calendarConnected: boolean;
}

/**
 * Everything the planner snapshot needs about the traveler, in one
 * batched load. Contains no vault data and no other traveler's data —
 * companions/groups are the organizer's own provided records (§4.3).
 */
export async function loadContextDigest(userId: number): Promise<ContextDigest> {
  const [contextRow, ruleRows, companions, groups, suggestions, calendarConnected] =
    await Promise.all([
      loadContextRow(userId),
      listRules(userId),
      listCompanions(userId),
      listSavedGroups(userId),
      loadDestinationSuggestions(userId),
      hasFreeBusyAccount(userId),
    ]);

  const rules = ruleRows.map(ruleRowToInput);
  const homeBaseConfirmed =
    contextRow?.homeBase && contextRow.homeBaseConfirmed
      ? {
          text: contextRow.homeBase,
          lat: contextRow.homeBaseLat,
          lon: contextRow.homeBaseLon,
        }
      : null;
  const airportsConfirmed =
    contextRow && contextRow.homeAirports.length > 0 && contextRow.homeAirportsConfirmed
      ? [...contextRow.homeAirports]
      : [];

  return {
    homeBase: homeBaseConfirmed,
    homeAirports: airportsConfirmed,
    proposedHomeBase:
      contextRow?.homeBase && !contextRow.homeBaseConfirmed ? contextRow.homeBase : null,
    proposedHomeAirports:
      contextRow && contextRow.homeAirports.length > 0 && !contextRow.homeAirportsConfirmed
        ? [...contextRow.homeAirports]
        : [],
    hardRules: rules.filter((r) => r.ruleClass === "hard"),
    preferences: rules.filter((r) => r.ruleClass === "preference"),
    companions: companions.map((c) => ({ id: c.id, name: c.name, email: c.email })),
    groups,
    destinationSuggestions: suggestions,
    calendarConnected,
  };
}

export { RuleValidationError };
