import { pgTable, text, timestamp, integer } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/**
 * Traveler profile vault (architecture-north-star §3.1, Story 5.1/5.2).
 *
 * One row per user, owned by that user, holding passport-class data.
 * Storage discipline per §3.1:
 *  - legal names, passport issuing country / expiry / nationality, and
 *    phone are PLAINTEXT — booking payloads need the names, and the
 *    expiry must stay queryable so the derived "valid through trip
 *    dates" check never has to decrypt anything.
 *  - date_of_birth, passport_number, and emergency_contact are ENCRYPTED
 *    per field (AES-256-GCM via the api-server's profileCrypto, field
 *    name as GCM AAD — see artifacts/api-server/src/lib/profileCrypto.ts).
 *    The ciphertext lives in the `*_enc` columns; plaintext never reaches
 *    the database.
 *
 * The vault is read by exactly ONE module — the Context/Profile service
 * (artifacts/api-server/src/lib/travelerProfile.ts). No route file imports
 * this table (§3.3: status projection enforced in the data layer), and the
 * codebase's super_admin trip-access bypass deliberately does NOT extend
 * here: no role can read another traveler's encrypted fields.
 *
 * `profile_version` is the optimistic-concurrency counter and the change
 * propagation signal (Story 5.3): an update bumps it and flags the
 * owner's in-flight roster entries for re-check.
 */
export const travelerProfilesTable = pgTable("traveler_profiles", {
  userId: integer("user_id")
    .primaryKey()
    .references(() => usersTable.id, { onDelete: "cascade" }),
  legalFirstName: text("legal_first_name"),
  legalMiddleName: text("legal_middle_name"),
  legalLastName: text("legal_last_name"),
  /** AES-256-GCM ciphertext of the YYYY-MM-DD date of birth. */
  dateOfBirthEnc: text("date_of_birth_enc"),
  /** AES-256-GCM ciphertext of the passport number. */
  passportNumberEnc: text("passport_number_enc"),
  passportIssuingCountry: text("passport_issuing_country"),
  /** YYYY-MM-DD, plaintext — queryable for validity checks (§3.1). */
  passportExpiry: text("passport_expiry"),
  nationality: text("nationality"),
  phone: text("phone"),
  /** AES-256-GCM ciphertext of the JSON blob { name, relationship, phone }. */
  emergencyContactEnc: text("emergency_contact_enc"),
  profileVersion: integer("profile_version").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type TravelerProfile = typeof travelerProfilesTable.$inferSelect;
