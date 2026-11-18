/**
 * Context/Profile Service tests — the traveler-profile vault
 * (architecture-north-star §3.1/§3.3, Stories 5.1/5.2/5.3).
 *
 * Recording @workspace/db mock (same pattern as outreach.test.ts), real
 * encryption (test KEK). The privacy invariants under test:
 *  - plaintext never reaches a stored row or an access-log row;
 *  - every decrypt writes an access-log row naming the fields;
 *  - derived checks return booleans / field NAMES only;
 *  - change propagation recomputes roster truth from real profile state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const store = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name });
  const ops: Array<{ op: string; table: string; values?: unknown; set?: unknown }> = [];
  const selectQueues: Record<string, unknown[][]> = {};
  const insertReturns: Record<string, unknown[]> = {};
  const updateReturns: Record<string, unknown[]> = {};

  function makeChain(kind: string, tableName?: string): Record<string, unknown> {
    const ctx = { table: tableName };
    const resolve = (): Promise<unknown> => {
      if (kind === "select") return Promise.resolve(selectQueues[ctx.table ?? ""]?.shift() ?? []);
      if (kind === "insert") return Promise.resolve(insertReturns[ctx.table ?? ""] ?? []);
      if (kind === "update") return Promise.resolve(updateReturns[ctx.table ?? ""] ?? []);
      return Promise.resolve([]);
    };
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolve().then(res, rej),
      catch: (rej: (e: unknown) => unknown) => resolve().catch(rej),
      finally: (fin: () => void) => resolve().finally(fin),
    };
    chain.from = (t: { __table: string }) => {
      ctx.table = t.__table;
      return chain;
    };
    for (const m of ["where", "orderBy", "limit", "returning"]) {
      chain[m] = () => chain;
    }
    chain.values = (v: unknown) => {
      ops.push({ op: "insert", table: ctx.table ?? "", values: v });
      return chain;
    };
    chain.set = (v: unknown) => {
      ops.push({ op: "update", table: ctx.table ?? "", set: v });
      return chain;
    };
    return chain;
  }

  const db = {
    select: vi.fn(() => makeChain("select")),
    insert: vi.fn((t: { __table: string }) => makeChain("insert", t.__table)),
    update: vi.fn((t: { __table: string }) => makeChain("update", t.__table)),
    delete: vi.fn((t: { __table: string }) => makeChain("delete", t.__table)),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { table, ops, selectQueues, insertReturns, updateReturns, db };
});

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
  desc: (...args: unknown[]) => args,
}));

vi.mock("@workspace/db", () => ({
  db: store.db,
  travelerProfilesTable: store.table("traveler_profiles"),
  profileAccessLogTable: store.table("profile_access_log"),
  tripRosterEntriesTable: store.table("trip_roster_entries"),
  tripsTable: store.table("trips"),
  usersTable: store.table("users"),
}));

import {
  ProfileValidationError,
  ProfileVersionConflict,
  computeMissingFields,
  flagProfileChangeForTrips,
  getOwnAccessLog,
  getOwnProfile,
  passportValidThrough,
  profileCompleteness,
  readProfileFields,
  upsertProfile,
} from "./travelerProfile.js";
import { decryptProfileField, encryptProfileField } from "./profileCrypto.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const PASSPORT = "XUK1234567";
const DOB = "1990-04-12";
const EC_PHONE = "+1-555-0199";
const EC = { name: "Mom", relationship: "mother", phone: EC_PHONE };

const savedKek = process.env.CREDENTIALS_KEK;

beforeEach(() => {
  process.env.CREDENTIALS_KEK = crypto.randomBytes(32).toString("hex");
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
});

afterEach(() => {
  if (savedKek === undefined) delete process.env.CREDENTIALS_KEK;
  else process.env.CREDENTIALS_KEK = savedKek;
});

function queue(table: string, rows: unknown[]): void {
  (store.selectQueues[table] ??= []).push(rows);
}

function profileRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: 77,
    legalFirstName: "Kurt",
    legalMiddleName: null,
    legalLastName: "Rao",
    dateOfBirthEnc: encryptProfileField(77, "date_of_birth", DOB),
    passportNumberEnc: encryptProfileField(77, "passport_number", PASSPORT),
    passportIssuingCountry: "US",
    passportExpiry: "2031-05-01",
    nationality: "US",
    phone: "+1-555-0100",
    emergencyContactEnc: encryptProfileField(77, "emergency_contact", JSON.stringify(EC)),
    profileVersion: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function inserts(table: string): Array<Record<string, unknown>> {
  return store.ops
    .filter((o) => o.op === "insert" && o.table === table)
    .map((o) => o.values as Record<string, unknown>);
}

function updates(table: string): Array<Record<string, unknown>> {
  return store.ops
    .filter((o) => o.op === "update" && o.table === table)
    .map((o) => o.set as Record<string, unknown>);
}

function logInserts(): Array<Record<string, unknown>> {
  return inserts("profile_access_log");
}

// ─── Writes ──────────────────────────────────────────────────────────────────

describe("upsertProfile", () => {
  it("creates the vault row with encrypted fields as ciphertext — plaintext never stored", async () => {
    queue("traveler_profiles", []);
    const result = await upsertProfile(77, {
      legalFirstName: "Kurt",
      legalLastName: "Rao",
      dateOfBirth: DOB,
      passportNumber: PASSPORT,
      passportIssuingCountry: "US",
      passportExpiry: "2031-05-01",
      emergencyContact: EC,
    }, { now: NOW });

    expect(result).toEqual({ profileVersion: 1, warnings: [] });
    const rows = inserts("traveler_profiles");
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows[0]);
    expect(stored).not.toContain(PASSPORT);
    expect(stored).not.toContain(DOB);
    expect(stored).not.toContain(EC_PHONE);
    expect(decryptProfileField(77, "passport_number", rows[0].passportNumberEnc as string)).toBe(PASSPORT);
    expect(decryptProfileField(77, "date_of_birth", rows[0].dateOfBirthEnc as string)).toBe(DOB);
    expect(
      JSON.parse(decryptProfileField(77, "emergency_contact", rows[0].emergencyContactEnc as string)),
    ).toEqual(EC);
    // Plaintext-by-design fields are stored as given (§3.1).
    expect(rows[0].passportExpiry).toBe("2031-05-01");
    expect(rows[0].legalFirstName).toBe("Kurt");
  });

  it("updates bump the version and touch only the provided fields", async () => {
    queue("traveler_profiles", [profileRow({ profileVersion: 3 })]);
    const result = await upsertProfile(77, { phone: "+1-555-2222" }, { expectedVersion: 3, now: NOW });
    expect(result.profileVersion).toBe(4);
    const sets = updates("traveler_profiles");
    expect(sets).toHaveLength(1);
    expect(sets[0].phone).toBe("+1-555-2222");
    expect(sets[0].profileVersion).toBe(4);
    expect(sets[0]).not.toHaveProperty("passportNumberEnc");
  });

  it("a stale expectedVersion conflicts — and writes nothing", async () => {
    queue("traveler_profiles", [profileRow({ profileVersion: 3 })]);
    await expect(
      upsertProfile(77, { phone: "+1-555-2222" }, { expectedVersion: 2, now: NOW }),
    ).rejects.toMatchObject({ name: "ProfileVersionConflict", currentVersion: 3 });
    expect(updates("traveler_profiles")).toHaveLength(0);
  });

  it("clearing a field stores null ciphertext", async () => {
    queue("traveler_profiles", [profileRow()]);
    await upsertProfile(77, { passportNumber: null }, { now: NOW });
    expect(updates("traveler_profiles")[0].passportNumberEnc).toBeNull();
  });

  it("validation: future DOB, malformed expiry, and phoneless emergency contact are rejected before any write", async () => {
    queue("traveler_profiles", []);
    await expect(upsertProfile(77, { dateOfBirth: "2999-01-01" }, { now: NOW }))
      .rejects.toBeInstanceOf(ProfileValidationError);
    queue("traveler_profiles", []);
    await expect(upsertProfile(77, { passportExpiry: "05/01/2031" }, { now: NOW }))
      .rejects.toBeInstanceOf(ProfileValidationError);
    queue("traveler_profiles", []);
    await expect(
      upsertProfile(77, { emergencyContact: { name: "Mom", relationship: null, phone: "" } }, { now: NOW }),
    ).rejects.toBeInstanceOf(ProfileValidationError);
    expect(inserts("traveler_profiles")).toHaveLength(0);
    expect(updates("traveler_profiles")).toHaveLength(0);
  });

  it("an expired passport is accepted but warned about immediately (Story 5.1)", async () => {
    queue("traveler_profiles", []);
    const result = await upsertProfile(77, { passportExpiry: "2020-01-01" }, { now: NOW });
    expect(result.warnings).toEqual(["passport_expired"]);
    expect(inserts("traveler_profiles")[0].passportExpiry).toBe("2020-01-01");
  });
});

// ─── Owner view + access log ─────────────────────────────────────────────────

describe("getOwnProfile", () => {
  it("returns the owner's decrypted profile and logs the view — field NAMES only in the log", async () => {
    queue("traveler_profiles", [profileRow()]);
    const view = await getOwnProfile(77);
    expect(view?.passportNumber).toBe(PASSPORT);
    expect(view?.dateOfBirth).toBe(DOB);
    expect(view?.emergencyContact).toEqual(EC);
    expect(view?.legalFirstName).toBe("Kurt");

    const logs = logInserts();
    expect(logs).toHaveLength(1);
    expect(logs[0].profileUserId).toBe(77);
    expect(logs[0].accessorKind).toBe("user");
    expect(logs[0].accessorUserId).toBe(77);
    expect(logs[0].purpose).toBe("owner_view");
    expect(logs[0].fieldsAccessed).toEqual(
      expect.arrayContaining(["date_of_birth", "passport_number", "emergency_contact"]),
    );
    const logJson = JSON.stringify(logs[0]);
    expect(logJson).not.toContain(PASSPORT);
    expect(logJson).not.toContain(DOB);
    expect(logJson).not.toContain(EC_PHONE);
  });

  it("no profile → null, and no log row", async () => {
    queue("traveler_profiles", []);
    await expect(getOwnProfile(77)).resolves.toBeNull();
    expect(logInserts()).toHaveLength(0);
  });

  it("a plaintext-only profile decrypts nothing and logs nothing", async () => {
    queue("traveler_profiles", [
      profileRow({ dateOfBirthEnc: null, passportNumberEnc: null, emergencyContactEnc: null }),
    ]);
    const view = await getOwnProfile(77);
    expect(view?.passportNumber).toBeNull();
    expect(view?.legalLastName).toBe("Rao");
    expect(logInserts()).toHaveLength(0);
  });

  it("F-1: a ciphertext transplanted from another user's row fails the owner's view — it never surfaces", async () => {
    // User 77's passport ciphertext sitting in user 88's row (DB-level
    // copy, bad restore, write-path bug). The AAD binds the owner, so
    // 88's view must fail closed rather than surface 77's number.
    // (Mirrors QA's it.fails F-1 as a passing test.)
    queue("traveler_profiles", [
      profileRow({
        userId: 88,
        passportNumberEnc: encryptProfileField(77, "passport_number", PASSPORT),
      }),
    ]);
    await expect(getOwnProfile(88)).rejects.toThrow();
    expect(logInserts()).toHaveLength(0);
  });
});

// ─── Authorized-use decrypt path ─────────────────────────────────────────────

describe("readProfileFields", () => {
  it("decrypts exactly the requested field for a booking and logs it with the booking id", async () => {
    queue("traveler_profiles", [profileRow()]);
    const values = await readProfileFields(
      77, ["passport_number"], { kind: "agent" }, "booking_execution", 900,
    );
    expect(values.passport_number).toBe(PASSPORT);
    expect(values).not.toHaveProperty("date_of_birth");
    expect(values).not.toHaveProperty("emergency_contact");

    const logs = logInserts();
    expect(logs).toHaveLength(1);
    expect(logs[0].accessorKind).toBe("agent");
    expect(logs[0].accessorUserId).toBeNull();
    expect(logs[0].purpose).toBe("booking_execution");
    expect(logs[0].bookingId).toBe(900);
    expect(logs[0].fieldsAccessed).toEqual(["passport_number"]);
    expect(JSON.stringify(logs[0])).not.toContain(PASSPORT);
  });

  it("a system read of two fields logs both names and parses the emergency contact", async () => {
    queue("traveler_profiles", [profileRow()]);
    const values = await readProfileFields(
      77, ["date_of_birth", "emergency_contact"], { kind: "system" }, "agent_task",
    );
    expect(values.date_of_birth).toBe(DOB);
    expect(values.emergency_contact).toEqual(EC);
    expect(logInserts()[0].fieldsAccessed).toEqual(["date_of_birth", "emergency_contact"]);
  });

  it("F-4: reading only plaintext fields writes an access-log row naming them — a touch is a touch", async () => {
    // Mirrors QA's F-4 observation as a passing test: the read performs
    // no decrypt, but the owner's log must still show it.
    queue("traveler_profiles", [profileRow()]);
    const values = await readProfileFields(
      77, ["passport_expiry", "phone"], { kind: "agent" }, "agent_task",
    );
    expect(values.passport_expiry).toBe("2031-05-01");
    expect(values.phone).toBe("+1-555-0100");
    const logs = logInserts();
    expect(logs).toHaveLength(1);
    expect(logs[0].accessorKind).toBe("agent");
    expect(logs[0].purpose).toBe("agent_task");
    expect(logs[0].fieldsAccessed).toEqual(["passport_expiry", "phone"]);
    expect(JSON.stringify(logs[0])).not.toContain("2031-05-01");
    expect(JSON.stringify(logs[0])).not.toContain("555-0100");
  });

  it("F-4: a plaintext field holding no value is not a touch — nothing is logged for it", async () => {
    queue("traveler_profiles", [profileRow({ phone: null })]);
    const values = await readProfileFields(
      77, ["phone"], { kind: "agent" }, "booking_execution",
    );
    expect(values.phone).toBeNull();
    expect(logInserts()).toHaveLength(0);
  });

  it("no profile → empty result, no log row", async () => {
    queue("traveler_profiles", []);
    await expect(
      readProfileFields(77, ["passport_number"], { kind: "agent" }, "booking_execution"),
    ).resolves.toEqual({});
    expect(logInserts()).toHaveLength(0);
  });
});

// ─── Derived checks ──────────────────────────────────────────────────────────

describe("derived checks", () => {
  it("passportValidThrough: true when the passport is on file and valid past the date — and the check is logged without values", async () => {
    queue("traveler_profiles", [profileRow()]);
    await expect(passportValidThrough(77, "2026-09-28")).resolves.toBe(true);
    const logs = logInserts();
    expect(logs).toHaveLength(1);
    expect(logs[0].purpose).toBe("derived_check");
    // F-3: the check consults passport_number's presence AND the expiry
    // value — the log names both (mirrors QA's it.fails F-3 as passing).
    expect(logs[0].fieldsAccessed).toEqual(["passport_number", "passport_expiry"]);
    expect(JSON.stringify(logs[0])).not.toContain("2031-05-01");
    expect(JSON.stringify(logs[0])).not.toContain(PASSPORT);
  });

  it("passportValidThrough: false for an expired passport, a missing number, or no profile", async () => {
    queue("traveler_profiles", [profileRow({ passportExpiry: "2026-01-01" })]);
    await expect(passportValidThrough(77, "2026-09-28")).resolves.toBe(false);

    queue("traveler_profiles", [profileRow({ passportNumberEnc: null })]);
    await expect(passportValidThrough(77, "2026-09-28")).resolves.toBe(false);

    queue("traveler_profiles", []);
    await expect(passportValidThrough(77, "2026-09-28")).resolves.toBe(false);
    // Only the two checks against an existing profile were logged.
    expect(logInserts()).toHaveLength(2);
  });

  it("profileCompleteness: complete when every required field (incl. aliases) is present", async () => {
    queue("traveler_profiles", [profileRow()]);
    const result = await profileCompleteness(77, ["passport_number", "legal_name", "passport_details"]);
    expect(result).toEqual({ status: "complete", missingFieldNames: [] });
  });

  it("profileCompleteness: returns missing NAMES only — never a value", async () => {
    queue("traveler_profiles", [
      profileRow({ passportNumberEnc: null, legalLastName: null }),
    ]);
    const result = await profileCompleteness(77, ["passport_number", "legal_name", "date_of_birth"]);
    expect(result.status).toBe("incomplete");
    expect(result.missingFieldNames).toEqual(["passport_number", "legal_name"]);
    const json = JSON.stringify(result);
    expect(json).not.toContain(PASSPORT);
    expect(json).not.toContain(DOB);
    // The check itself is visible in the owner's log, naming consulted fields.
    expect(logInserts()[0].purpose).toBe("derived_check");
    expect(logInserts()[0].fieldsAccessed).toEqual(
      expect.arrayContaining(["passport_number", "legal_first_name", "date_of_birth"]),
    );
  });

  it("profileCompleteness: no profile → no_profile with everything missing, nothing logged", async () => {
    queue("traveler_profiles", []);
    const result = await profileCompleteness(77, ["passport_number"]);
    expect(result).toEqual({ status: "no_profile", missingFieldNames: ["passport_number"] });
    expect(logInserts()).toHaveLength(0);
  });

  it("a required field the vault cannot hold stays honestly missing", async () => {
    queue("traveler_profiles", [profileRow()]);
    const result = await profileCompleteness(77, ["known_traveler_number"]);
    expect(result.status).toBe("incomplete");
    expect(result.missingFieldNames).toEqual(["known_traveler_number"]);
  });
});

// ─── computeMissingFields (pure) ─────────────────────────────────────────────

describe("computeMissingFields", () => {
  it("passport_details requires number + issuing country + expiry together", () => {
    const row = profileRow({ passportExpiry: null }) as never;
    expect(computeMissingFields(row, ["passport_details"])).toEqual(["passport_details"]);
    expect(computeMissingFields(profileRow() as never, ["passport_details"])).toEqual([]);
  });

  it("a null profile misses everything", () => {
    expect(computeMissingFields(null, ["passport_number", "legal_name"])).toEqual([
      "passport_number",
      "legal_name",
    ]);
  });
});

// ─── Change propagation (Story 5.3) ──────────────────────────────────────────

describe("flagProfileChangeForTrips", () => {
  const futureTrip = { id: 7, endDate: "2027-03-01" };
  const pastTrip = { id: 8, endDate: "2026-01-01" };

  function rosterEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 11,
      tripId: 7,
      invitedName: "Kurt",
      invitedEmail: "kurt@example.com",
      userId: 77,
      status: "ready",
      requiredFieldsProfile: ["passport_number"],
      missingFields: [],
      chaseState: { invitesSent: 1, nextDueAt: "2026-11-20T00:00:00.000Z" },
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides,
    };
  }

  it("a cleared required field demotes ready → setting_up, recomputes missing, and stamps the recheck flag", async () => {
    queue("trip_roster_entries", [rosterEntry()]);
    queue("trips", [futureTrip]);
    queue("traveler_profiles", [profileRow({ passportNumberEnc: null })]);

    const result = await flagProfileChangeForTrips(77, 5, NOW);
    expect(result.flaggedEntryIds).toEqual([11]);
    const sets = updates("trip_roster_entries");
    expect(sets).toHaveLength(1);
    expect(sets[0].status).toBe("setting_up");
    expect(sets[0].missingFields).toEqual(["passport_number"]);
    const chase = sets[0].chaseState as Record<string, unknown>;
    expect(chase.profileRecheck).toEqual({ profileVersion: 5, at: NOW.toISOString() });
    expect(chase.invitesSent).toBe(1); // prior chase state preserved
  });

  it("a now-complete profile promotes setting_up → ready and stops the chase clock", async () => {
    queue("trip_roster_entries", [
      rosterEntry({ status: "setting_up", missingFields: ["passport_number"] }),
    ]);
    queue("trips", [futureTrip]);
    queue("traveler_profiles", [profileRow()]);

    const result = await flagProfileChangeForTrips(77, 2, NOW);
    expect(result.flaggedEntryIds).toEqual([11]);
    const sets = updates("trip_roster_entries");
    expect(sets[0].status).toBe("ready");
    expect(sets[0].missingFields).toEqual([]);
    expect((sets[0].chaseState as Record<string, unknown>).nextDueAt).toBeNull();
  });

  it("entries on finished trips are not flagged", async () => {
    queue("trip_roster_entries", [rosterEntry({ tripId: 8 })]);
    queue("trips", [pastTrip]);
    queue("traveler_profiles", [profileRow({ passportNumberEnc: null })]);

    const result = await flagProfileChangeForTrips(77, 5, NOW);
    expect(result.flaggedEntryIds).toEqual([]);
    expect(updates("trip_roster_entries")).toHaveLength(0);
  });

  it("no in-flight entries → nothing flagged", async () => {
    queue("trip_roster_entries", []);
    await expect(flagProfileChangeForTrips(77, 5, NOW)).resolves.toEqual({
      flaggedEntryIds: [],
    });
  });
});

// ─── Access log reads ────────────────────────────────────────────────────────

describe("getOwnAccessLog", () => {
  it("returns the owner's log rows", async () => {
    const rows = [
      { id: 3, profileUserId: 77, purpose: "owner_view", fieldsAccessed: ["passport_number"] },
      { id: 2, profileUserId: 77, purpose: "derived_check", fieldsAccessed: ["passport_expiry"] },
    ];
    queue("profile_access_log", rows);
    await expect(getOwnAccessLog(77)).resolves.toEqual(rows);
  });
});
