/**
 * Per-field encryption for the traveler-profile vault
 * (architecture-north-star §3.1).
 *
 * Same discipline as credentialCrypto — AES-256-GCM, same
 * CREDENTIALS_KEK, same "iv:ciphertext:authTag" base64 envelope — with
 * the two deliberate differences §3.1 calls for:
 *
 *  (a) Fields are encrypted individually, not as one record blob, so an
 *      authorized flow can decrypt exactly one field for exactly one use
 *      (and the access log can name exactly that field).
 *  (b) The field name AND the profile owner's user id are bound into
 *      the GCM tag as additional authenticated data (AAD). A ciphertext
 *      copied into a different field's column therefore fails
 *      decryption — a passport number ciphertext can never be replayed
 *      as a date of birth — and a ciphertext copied into ANOTHER USER's
 *      row fails too (QA finding F-1: the AAD originally bound the
 *      field name only, so a transplanted ciphertext decrypted into the
 *      wrong owner's view).
 *
 * The vault has never been deployed (migration 0009 was never applied
 * anywhere), so the owner binding needed no re-encryption migration:
 * ciphertexts in the original field-name-only AAD format simply fail
 * decryption — fail closed, like any other tampering.
 *
 * Fails closed: without a valid CREDENTIALS_KEK every operation throws.
 * Plaintext profile data is never stored, logged, or returned by this
 * module beyond the caller's own decrypt result.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { loadCredentialsKek } from "./credentialCrypto.js";
import { logger } from "./logger.js";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

/** The AAD binds a ciphertext to exactly one (owner, field) pair. */
function aadFor(userId: number, fieldName: string): Buffer {
  return Buffer.from(`wander-profile:${userId}:${fieldName}`, "utf8");
}

/** Encrypt one profile field's plaintext for its owner, under its field name. */
export function encryptProfileField(userId: number, fieldName: string, plaintext: string): string {
  const key = loadCredentialsKek();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(aadFor(userId, fieldName));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64")].join(":");
}

/**
 * Decrypt a value produced by encryptProfileField FOR THE SAME OWNER
 * AND FIELD. Throws on tampering, on a malformed envelope, and — via
 * the AAD — on a ciphertext that was produced for a different field or
 * a different profile owner (including the pre-F-1 field-name-only
 * format, which fails closed).
 */
export function decryptProfileField(userId: number, fieldName: string, packed: string): string {
  const key = loadCredentialsKek();
  const [ivB64, ctB64, tagB64] = packed.split(":");
  if (!ivB64 || !ctB64 || !tagB64) throw new Error("Malformed encrypted profile field");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAAD(aadFor(userId, fieldName));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Non-throwing readiness check, mirroring credentialsEncryptionReady. */
export function profileEncryptionReady(): boolean {
  try {
    loadCredentialsKek();
    return true;
  } catch (err) {
    logger.warn({ err }, "[Profiles] CREDENTIALS_KEK missing or invalid");
    return false;
  }
}
