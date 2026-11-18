/**
 * Context/Profile Service — traveler profile vault (architecture-north-star
 * §3.1/§3.3, Stories 5.1/5.2/5.3).
 *
 * This module is the ONLY reader of the `traveler_profiles` vault table.
 * No route file imports the table; routes call this service. The privacy
 * model is enforced here, in the data layer:
 *
 *  - Plaintext profile values leave this module through exactly two
 *    doors: the OWNER's own view, and `readProfileFields` — the
 *    authorized-use decrypt path (booking execution, agent tasks) that
 *    requires an explicit accessor + purpose and logs every field it
 *    decrypts. There is no third door.
 *  - Cross-user reads are DERIVED ONLY: `passportValidThrough` returns a
 *    boolean, `profileCompleteness` returns field NAMES. Callers never
 *    receive inputs.
 *  - NO role bypasses this. The codebase's `super_admin` trip-access
 *    bypass (assertTripAccess) deliberately does NOT extend to the
 *    vault (§3.3): every function here keys strictly on the profile
 *    owner's userId, and owner surfaces take the caller's own id from
 *    the session — there is no parameter by which an organizer, trip
 *    admin, or super_admin can name someone else's profile.
 *
 * Every decrypt writes a `profile_access_log` row in the same
 * transaction (field NAMES only — never values). Derived checks log too,
 * naming the fields whose presence/plaintext was consulted.
 */

import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db,
  profileAccessLogTable,
  travelerProfilesTable,
  tripRosterEntriesTable,
  tripsTable,
  type ProfileAccessLogEntry,
  type TravelerProfile,
} from "@workspace/db";
import { decryptProfileField, encryptProfileField } from "./profileCrypto.js";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Field model
// ---------------------------------------------------------------------------

/** Canonical profile field names — used for AAD, access logs, completeness. */
export const PROFILE_FIELD_NAMES = [
  "legal_first_name",
  "legal_middle_name",
  "legal_last_name",
  "date_of_birth",
  "passport_number",
  "passport_issuing_country",
  "passport_expiry",
  "nationality",
  "phone",
  "emergency_contact",
] as const;
export type ProfileFieldName = (typeof PROFILE_FIELD_NAMES)[number];

/** Fields stored only as ciphertext (§3.1). Everything else is plaintext. */
export const ENCRYPTED_PROFILE_FIELDS: readonly ProfileFieldName[] = [
  "date_of_birth",
  "passport_number",
  "emergency_contact",
];

export interface EmergencyContact {
  name: string;
  relationship: string | null;
  phone: string;
}

/** A write to the vault. `undefined` = leave unchanged; `null` = clear. */
export interface TravelerProfileInput {
  legalFirstName?: string | null;
  legalMiddleName?: string | null;
  legalLastName?: string | null;
  /** YYYY-MM-DD. Encrypted at rest. */
  dateOfBirth?: string | null;
  /** Encrypted at rest. */
  passportNumber?: string | null;
  passportIssuingCountry?: string | null;
  /** YYYY-MM-DD. Plaintext — queryable for validity checks. */
  passportExpiry?: string | null;
  nationality?: string | null;
  phone?: string | null;
  /** Encrypted at rest as one JSON blob. */
  emergencyContact?: EmergencyContact | null;
}

/** The owner's own decrypted view. Never served to anyone else. */
export interface TravelerProfileView {
  userId: number;
  legalFirstName: string | null;
  legalMiddleName: string | null;
  legalLastName: string | null;
  dateOfBirth: string | null;
  passportNumber: string | null;
  passportIssuingCountry: string | null;
  passportExpiry: string | null;
  nationality: string | null;
  phone: string | null;
  emergencyContact: EmergencyContact | null;
  profileVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Accessors, purposes, errors
// ---------------------------------------------------------------------------

/**
 * Who is touching the vault. "user" is always the profile OWNER for owner
 * surfaces; agent/system reads go through readProfileFields with an
 * explicit purpose and are visible in the owner's access log.
 */
export type ProfileAccessor =
  | { kind: "user"; userId: number }
  | { kind: "agent" }
  | { kind: "system" };

export type ProfilePurpose =
  | "owner_view"
  | "booking_execution"
  | "derived_check"
  | "agent_task";

export class ProfileValidationError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Invalid profile data: ${problems.join("; ")}`);
    this.name = "ProfileValidationError";
    this.problems = problems;
  }
}

export class ProfileVersionConflict extends Error {
  readonly currentVersion: number;
  constructor(currentVersion: number) {
    super(
      `Profile was modified since it was loaded (current version ${currentVersion}). Reload and retry.`,
    );
    this.name = "ProfileVersionConflict";
    this.currentVersion = currentVersion;
  }
}

// ---------------------------------------------------------------------------
// Validation (Story 5.1 — format + internal consistency, flagged immediately)
// ---------------------------------------------------------------------------

function isRealDateString(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function clean(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export interface ValidatedProfileInput {
  input: TravelerProfileInput;
  /** Non-fatal flags the traveler should see immediately (Story 5.1). */
  warnings: string[];
}

export function validateProfileInput(
  raw: TravelerProfileInput,
  now: Date = new Date(),
): ValidatedProfileInput {
  const problems: string[] = [];
  const warnings: string[] = [];
  const today = now.toISOString().slice(0, 10);

  const input: TravelerProfileInput = {
    legalFirstName: clean(raw.legalFirstName),
    legalMiddleName: clean(raw.legalMiddleName),
    legalLastName: clean(raw.legalLastName),
    dateOfBirth: clean(raw.dateOfBirth),
    passportNumber: clean(raw.passportNumber),
    passportIssuingCountry: clean(raw.passportIssuingCountry),
    passportExpiry: clean(raw.passportExpiry),
    nationality: clean(raw.nationality),
    phone: clean(raw.phone),
    emergencyContact: raw.emergencyContact,
  };

  if (input.dateOfBirth != null) {
    if (!isRealDateString(input.dateOfBirth)) {
      problems.push("date_of_birth must be a real date in YYYY-MM-DD format");
    } else if (input.dateOfBirth > today) {
      problems.push("date_of_birth cannot be in the future");
    }
  }
  if (input.passportExpiry != null) {
    if (!isRealDateString(input.passportExpiry)) {
      problems.push("passport_expiry must be a real date in YYYY-MM-DD format");
    } else if (input.passportExpiry < today) {
      // Stored, but flagged to the traveler immediately (Story 5.1) — an
      // expired passport is exactly what they need to know now, not at
      // the airport. Validity itself is a derived check, not a write ban.
      warnings.push("passport_expired");
    }
  }
  if (input.emergencyContact != null) {
    const ec = input.emergencyContact;
    const name = typeof ec.name === "string" ? ec.name.trim() : "";
    const phone = typeof ec.phone === "string" ? ec.phone.trim() : "";
    if (!name || !phone) {
      problems.push("emergency_contact needs at least a name and a phone number");
    } else {
      input.emergencyContact = {
        name,
        relationship:
          typeof ec.relationship === "string" && ec.relationship.trim() !== ""
            ? ec.relationship.trim()
            : null,
        phone,
      };
    }
  }

  if (problems.length > 0) throw new ProfileValidationError(problems);
  return { input, warnings };
}

// ---------------------------------------------------------------------------
// Presence & completeness — derived data only, no decryption anywhere here
// ---------------------------------------------------------------------------

/** Does the stored row hold a (non-empty) value for this field? */
export function profileHasField(row: TravelerProfile | null, field: ProfileFieldName): boolean {
  if (!row) return false;
  const present = (v: string | null): boolean => v !== null && v.trim() !== "";
  switch (field) {
    case "legal_first_name": return present(row.legalFirstName);
    case "legal_middle_name": return present(row.legalMiddleName);
    case "legal_last_name": return present(row.legalLastName);
    case "date_of_birth": return present(row.dateOfBirthEnc);
    case "passport_number": return present(row.passportNumberEnc);
    case "passport_issuing_country": return present(row.passportIssuingCountry);
    case "passport_expiry": return present(row.passportExpiry);
    case "nationality": return present(row.nationality);
    case "phone": return present(row.phone);
    case "emergency_contact": return present(row.emergencyContactEnc);
  }
}

/**
 * Required-field names (as organizers/trips use them, incl. the aliases
 * in outreachLogic's label table) → the canonical vault fields that
 * satisfy them. A name that resolves to nothing is a requirement the
 * vault cannot hold yet — it stays missing, honestly, rather than being
 * silently treated as satisfied.
 */
const REQUIRED_FIELD_ALIASES: Record<string, ProfileFieldName[]> = {
  legal_name: ["legal_first_name", "legal_last_name"],
  full_name: ["legal_first_name", "legal_last_name"],
  name: ["legal_first_name", "legal_last_name"],
  legal_first_name: ["legal_first_name"],
  legal_middle_name: ["legal_middle_name"],
  legal_last_name: ["legal_last_name"],
  date_of_birth: ["date_of_birth"],
  dob: ["date_of_birth"],
  passport: ["passport_number"],
  passport_number: ["passport_number"],
  passport_details: ["passport_number", "passport_issuing_country", "passport_expiry"],
  passport_issuing_country: ["passport_issuing_country"],
  passport_expiry: ["passport_expiry"],
  passport_expiration: ["passport_expiry"],
  nationality: ["nationality"],
  phone: ["phone"],
  phone_number: ["phone"],
  emergency_contact: ["emergency_contact"],
};

export function canonicalFieldsForRequired(requiredName: string): ProfileFieldName[] {
  return REQUIRED_FIELD_ALIASES[requiredName.trim().toLowerCase()] ?? [];
}

/**
 * The required names (as given) that the profile does NOT satisfy.
 * Pure — presence only, never decrypts.
 */
export function computeMissingFields(
  row: TravelerProfile | null,
  requiredFields: readonly string[],
): string[] {
  const missing: string[] = [];
  for (const name of requiredFields) {
    const canonical = canonicalFieldsForRequired(name);
    if (canonical.length === 0 || canonical.some((f) => !profileHasField(row, f))) {
      missing.push(name);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Access log
// ---------------------------------------------------------------------------

interface AccessLogWrite {
  profileUserId: number;
  accessor: ProfileAccessor;
  purpose: ProfilePurpose;
  fieldsAccessed: ProfileFieldName[];
  bookingId?: number | null;
}

async function insertAccessLog(
  exec: Pick<typeof db, "insert">,
  write: AccessLogWrite,
): Promise<void> {
  await exec.insert(profileAccessLogTable).values({
    profileUserId: write.profileUserId,
    accessorKind: write.accessor.kind,
    accessorUserId: write.accessor.kind === "user" ? write.accessor.userId : null,
    purpose: write.purpose,
    fieldsAccessed: [...write.fieldsAccessed],
    bookingId: write.bookingId ?? null,
  });
}

/** The owner's own access log — and ONLY the owner's (enforced by the WHERE). */
export async function getOwnAccessLog(
  userId: number,
  limit = 100,
): Promise<ProfileAccessLogEntry[]> {
  return db
    .select()
    .from(profileAccessLogTable)
    .where(eq(profileAccessLogTable.profileUserId, userId))
    .orderBy(desc(profileAccessLogTable.id))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Decryption — the only two doors, both logged in the same transaction
// ---------------------------------------------------------------------------

function decryptRowFields(
  row: TravelerProfile,
  fields: readonly ProfileFieldName[],
): { values: Partial<Record<ProfileFieldName, string | EmergencyContact | null>>; decrypted: ProfileFieldName[] } {
  const values: Partial<Record<ProfileFieldName, string | EmergencyContact | null>> = {};
  const decrypted: ProfileFieldName[] = [];
  for (const field of fields) {
    switch (field) {
      case "legal_first_name": values[field] = row.legalFirstName; break;
      case "legal_middle_name": values[field] = row.legalMiddleName; break;
      case "legal_last_name": values[field] = row.legalLastName; break;
      case "passport_issuing_country": values[field] = row.passportIssuingCountry; break;
      case "passport_expiry": values[field] = row.passportExpiry; break;
      case "nationality": values[field] = row.nationality; break;
      case "phone": values[field] = row.phone; break;
      case "date_of_birth":
        if (row.dateOfBirthEnc !== null) {
          values[field] = decryptProfileField("date_of_birth", row.dateOfBirthEnc);
          decrypted.push(field);
        } else values[field] = null;
        break;
      case "passport_number":
        if (row.passportNumberEnc !== null) {
          values[field] = decryptProfileField("passport_number", row.passportNumberEnc);
          decrypted.push(field);
        } else values[field] = null;
        break;
      case "emergency_contact":
        if (row.emergencyContactEnc !== null) {
          const raw = decryptProfileField("emergency_contact", row.emergencyContactEnc);
          values[field] = JSON.parse(raw) as EmergencyContact;
          decrypted.push(field);
        } else values[field] = null;
        break;
    }
  }
  return { values, decrypted };
}

/**
 * The authorized-use decrypt path — the ONLY way any non-owner flow can
 * obtain plaintext profile values (e.g. the booking gate supplying a
 * passport number to a booking the traveler is part of, Story 5.2).
 * Decrypts exactly the requested fields, and writes the access-log row
 * in the same transaction: a decrypt that isn't logged doesn't happen.
 * No route exposes this directly; callers are server-side services
 * acting on the traveler's authorization.
 */
export async function readProfileFields(
  userId: number,
  fields: readonly ProfileFieldName[],
  accessor: ProfileAccessor,
  purpose: Exclude<ProfilePurpose, "owner_view" | "derived_check">,
  bookingId?: number,
): Promise<Partial<Record<ProfileFieldName, string | EmergencyContact | null>>> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(travelerProfilesTable)
      .where(eq(travelerProfilesTable.userId, userId));
    if (!row) return {};
    const { values, decrypted } = decryptRowFields(row, fields);
    if (decrypted.length > 0) {
      await insertAccessLog(tx, {
        profileUserId: userId,
        accessor,
        purpose,
        fieldsAccessed: decrypted,
        bookingId: bookingId ?? null,
      });
    }
    return values;
  });
}

/** The owner's own full profile view. Keys strictly on the caller's id. */
export async function getOwnProfile(userId: number): Promise<TravelerProfileView | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(travelerProfilesTable)
      .where(eq(travelerProfilesTable.userId, userId));
    if (!row) return null;
    const { values, decrypted } = decryptRowFields(row, PROFILE_FIELD_NAMES);
    if (decrypted.length > 0) {
      await insertAccessLog(tx, {
        profileUserId: userId,
        accessor: { kind: "user", userId },
        purpose: "owner_view",
        fieldsAccessed: decrypted,
      });
    }
    return {
      userId: row.userId,
      legalFirstName: (values.legal_first_name as string | null) ?? null,
      legalMiddleName: (values.legal_middle_name as string | null) ?? null,
      legalLastName: (values.legal_last_name as string | null) ?? null,
      dateOfBirth: (values.date_of_birth as string | null) ?? null,
      passportNumber: (values.passport_number as string | null) ?? null,
      passportIssuingCountry: (values.passport_issuing_country as string | null) ?? null,
      passportExpiry: (values.passport_expiry as string | null) ?? null,
      nationality: (values.nationality as string | null) ?? null,
      phone: (values.phone as string | null) ?? null,
      emergencyContact: (values.emergency_contact as EmergencyContact | null) ?? null,
      profileVersion: row.profileVersion,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Create or update the owner's vault row. Only provided (non-undefined)
 * fields change; encrypted fields are encrypted here — plaintext never
 * reaches the database. `expectedVersion` gives optimistic concurrency
 * for the owner edit surface (Story 5.3).
 *
 * Callers that change a profile MUST follow with
 * flagProfileChangeForTrips so in-flight trips re-check (Story 5.3).
 */
export async function upsertProfile(
  userId: number,
  rawInput: TravelerProfileInput,
  opts: { expectedVersion?: number; now?: Date } = {},
): Promise<{ profileVersion: number; warnings: string[] }> {
  const now = opts.now ?? new Date();
  const { input, warnings } = validateProfileInput(rawInput, now);

  const [existing] = await db
    .select()
    .from(travelerProfilesTable)
    .where(eq(travelerProfilesTable.userId, userId));

  if (
    existing &&
    opts.expectedVersion !== undefined &&
    existing.profileVersion !== opts.expectedVersion
  ) {
    throw new ProfileVersionConflict(existing.profileVersion);
  }

  const columns: Partial<{
    legalFirstName: string | null;
    legalMiddleName: string | null;
    legalLastName: string | null;
    dateOfBirthEnc: string | null;
    passportNumberEnc: string | null;
    passportIssuingCountry: string | null;
    passportExpiry: string | null;
    nationality: string | null;
    phone: string | null;
    emergencyContactEnc: string | null;
  }> = {};
  if (input.legalFirstName !== undefined) columns.legalFirstName = input.legalFirstName;
  if (input.legalMiddleName !== undefined) columns.legalMiddleName = input.legalMiddleName;
  if (input.legalLastName !== undefined) columns.legalLastName = input.legalLastName;
  if (input.dateOfBirth !== undefined) {
    columns.dateOfBirthEnc =
      input.dateOfBirth === null
        ? null
        : encryptProfileField("date_of_birth", input.dateOfBirth);
  }
  if (input.passportNumber !== undefined) {
    columns.passportNumberEnc =
      input.passportNumber === null
        ? null
        : encryptProfileField("passport_number", input.passportNumber);
  }
  if (input.passportIssuingCountry !== undefined) {
    columns.passportIssuingCountry = input.passportIssuingCountry;
  }
  if (input.passportExpiry !== undefined) columns.passportExpiry = input.passportExpiry;
  if (input.nationality !== undefined) columns.nationality = input.nationality;
  if (input.phone !== undefined) columns.phone = input.phone;
  if (input.emergencyContact !== undefined) {
    columns.emergencyContactEnc =
      input.emergencyContact === null
        ? null
        : encryptProfileField("emergency_contact", JSON.stringify(input.emergencyContact));
  }

  if (existing) {
    const nextVersion = existing.profileVersion + 1;
    await db
      .update(travelerProfilesTable)
      .set({ ...columns, profileVersion: nextVersion, updatedAt: now })
      .where(eq(travelerProfilesTable.userId, userId));
    logger.info({ userId, profileVersion: nextVersion }, "[Profiles] profile updated");
    return { profileVersion: nextVersion, warnings };
  }

  await db.insert(travelerProfilesTable).values({
    userId,
    legalFirstName: columns.legalFirstName ?? null,
    legalMiddleName: columns.legalMiddleName ?? null,
    legalLastName: columns.legalLastName ?? null,
    dateOfBirthEnc: columns.dateOfBirthEnc ?? null,
    passportNumberEnc: columns.passportNumberEnc ?? null,
    passportIssuingCountry: columns.passportIssuingCountry ?? null,
    passportExpiry: columns.passportExpiry ?? null,
    nationality: columns.nationality ?? null,
    phone: columns.phone ?? null,
    emergencyContactEnc: columns.emergencyContactEnc ?? null,
    profileVersion: 1,
    updatedAt: now,
  });
  logger.info({ userId, profileVersion: 1 }, "[Profiles] profile created");
  return { profileVersion: 1, warnings };
}

/**
 * Change propagation (Story 5.3): after a profile update, every roster
 * entry of this traveler on a not-yet-finished trip is flagged for
 * re-check (chaseState.profileRecheck), its missingFields are recomputed
 * from real profile state, and its status moves with the truth — a
 * completed entry whose required field was just cleared drops back to
 * setting_up; a now-complete entry becomes ready and its chase clock
 * stops. Status + names only, as everywhere on the organizer surface.
 */
export async function flagProfileChangeForTrips(
  userId: number,
  profileVersion: number,
  now: Date = new Date(),
): Promise<{ flaggedEntryIds: number[] }> {
  const entries = await db
    .select()
    .from(tripRosterEntriesTable)
    .where(
      and(
        eq(tripRosterEntriesTable.userId, userId),
        inArray(tripRosterEntriesTable.status, [
          "invited",
          "setting_up",
          "ready",
          "needs_attention",
        ]),
      ),
    );
  if (entries.length === 0) return { flaggedEntryIds: [] };

  const tripIds = [...new Set(entries.map((e) => e.tripId))];
  const trips = await db
    .select()
    .from(tripsTable)
    .where(inArray(tripsTable.id, tripIds));
  const endDateByTrip = new Map(trips.map((t) => [t.id, t.endDate]));
  const today = now.toISOString().slice(0, 10);

  const [profileRow] = await db
    .select()
    .from(travelerProfilesTable)
    .where(eq(travelerProfilesTable.userId, userId));

  const flaggedEntryIds: number[] = [];
  for (const entry of entries) {
    const endDate = endDateByTrip.get(entry.tripId);
    if (endDate !== undefined && endDate < today) continue; // trip is over
    const missing = computeMissingFields(
      profileRow ?? null,
      entry.requiredFieldsProfile ?? [],
    );
    const status =
      missing.length === 0
        ? "ready"
        : entry.status === "ready"
          ? "setting_up"
          : entry.status;
    const chaseState: Record<string, unknown> = {
      ...((entry.chaseState ?? {}) as Record<string, unknown>),
      profileRecheck: { profileVersion, at: now.toISOString() },
    };
    if (missing.length === 0) chaseState.nextDueAt = null; // nothing to chase
    await db
      .update(tripRosterEntriesTable)
      .set({ missingFields: missing, status, chaseState, updatedAt: now })
      .where(eq(tripRosterEntriesTable.id, entry.id));
    flaggedEntryIds.push(entry.id);
  }
  if (flaggedEntryIds.length > 0) {
    logger.info(
      { userId, profileVersion, flaggedEntryIds },
      "[Profiles] profile change flagged in-flight roster entries for re-check",
    );
  }
  return { flaggedEntryIds };
}

// ---------------------------------------------------------------------------
// Derived checks — the ONLY cross-user reads. Booleans and names, never
// values (§3.1). Both log a derived_check row when a profile exists.
// ---------------------------------------------------------------------------

/**
 * Is this traveler's passport on file and valid through `throughDate`
 * (YYYY-MM-DD, e.g. a trip's end date)? Reads only the plaintext expiry
 * and the PRESENCE of the encrypted number — no decryption.
 */
export async function passportValidThrough(
  userId: number,
  throughDate: string,
  accessor: ProfileAccessor = { kind: "system" },
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(travelerProfilesTable)
    .where(eq(travelerProfilesTable.userId, userId));
  if (!row) return false;
  const valid =
    profileHasField(row, "passport_number") &&
    row.passportExpiry !== null &&
    row.passportExpiry >= throughDate;
  await insertAccessLog(db, {
    profileUserId: userId,
    accessor,
    purpose: "derived_check",
    fieldsAccessed: ["passport_expiry"],
  });
  return valid;
}

export interface ProfileCompleteness {
  status: "complete" | "incomplete" | "no_profile";
  /** Required field NAMES still outstanding — never values. */
  missingFieldNames: string[];
}

/**
 * Does this traveler's profile satisfy a trip's required fields? The
 * caller receives a status and missing field NAMES — the same projection
 * the roster shows the organizer (§3.3).
 */
export async function profileCompleteness(
  userId: number,
  requiredFields: readonly string[],
  accessor: ProfileAccessor = { kind: "system" },
): Promise<ProfileCompleteness> {
  const [row] = await db
    .select()
    .from(travelerProfilesTable)
    .where(eq(travelerProfilesTable.userId, userId));
  if (!row) {
    return { status: "no_profile", missingFieldNames: [...requiredFields] };
  }
  const missing = computeMissingFields(row, requiredFields);
  const consulted = [
    ...new Set(requiredFields.flatMap((name) => canonicalFieldsForRequired(name))),
  ];
  if (consulted.length > 0) {
    await insertAccessLog(db, {
      profileUserId: userId,
      accessor,
      purpose: "derived_check",
      fieldsAccessed: consulted,
    });
  }
  return {
    status: missing.length === 0 ? "complete" : "incomplete",
    missingFieldNames: missing,
  };
}

/** Internal: raw row load for the outreach submit flow (same service boundary). */
export async function loadProfileRow(userId: number): Promise<TravelerProfile | null> {
  const [row] = await db
    .select()
    .from(travelerProfilesTable)
    .where(eq(travelerProfilesTable.userId, userId));
  return row ?? null;
}
