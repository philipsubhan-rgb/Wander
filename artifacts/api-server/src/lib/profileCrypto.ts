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
 *  (b) The field name is bound into the GCM tag as additional
 *      authenticated data (AAD). A ciphertext copied into a different
 *      field's column therefore fails decryption — a passport number
 *      ciphertext can never be replayed as a date of birth.
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

/** Encrypt one profile field's plaintext under its field name. */
export function encryptProfileField(fieldName: string, plaintext: string): string {
  const key = loadCredentialsKek();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(fieldName, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64")].join(":");
}

/**
 * Decrypt a value produced by encryptProfileField FOR THE SAME FIELD.
 * Throws on tampering, on a malformed envelope, and — via the AAD — on a
 * ciphertext that was produced for a different field.
 */
export function decryptProfileField(fieldName: string, packed: string): string {
  const key = loadCredentialsKek();
  const [ivB64, ctB64, tagB64] = packed.split(":");
  if (!ivB64 || !ctB64 || !tagB64) throw new Error("Malformed encrypted profile field");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAAD(Buffer.from(fieldName, "utf8"));
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
