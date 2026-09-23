/**
 * Credential encryption for connected-account OAuth tokens.
 *
 * AES-256-GCM with a key-encryption key (KEK) from the CREDENTIALS_KEK env
 * var (32 bytes, hex or base64). Tokens are encrypted before storage and
 * decrypted only in memory at use time. If the KEK is missing, connecting
 * an account fails loudly — tokens are never stored in plaintext.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { logger } from "./logger";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function loadKek(): Buffer {
  const raw = process.env.CREDENTIALS_KEK;
  if (!raw) {
    throw new Error(
      "CREDENTIALS_KEK is not set — refusing to handle OAuth tokens without encryption. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw.trim())
    ? Buffer.from(raw.trim(), "hex")
    : Buffer.from(raw.trim(), "base64");
  if (key.length !== 32) {
    throw new Error("CREDENTIALS_KEK must be 32 bytes (64 hex chars or 44 base64 chars)");
  }
  return key;
}

/** Encrypt a plaintext token. Returns "iv:ciphertext:authTag" (base64 parts). */
export function encryptToken(plaintext: string): string {
  const key = loadKek();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString("base64"), ciphertext.toString("base64"), tag.toString("base64")].join(":");
}

/** Decrypt a value produced by encryptToken. */
export function decryptToken(packed: string): string {
  const key = loadKek();
  const [ivB64, ctB64, tagB64] = packed.split(":");
  if (!ivB64 || !ctB64 || !tagB64) throw new Error("Malformed encrypted token");
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

/** Non-throwing check used by the connect endpoint to give a clear 503. */
export function credentialsEncryptionReady(): boolean {
  try {
    loadKek();
    return true;
  } catch (err) {
    logger.warn({ err }, "[Integrations] CREDENTIALS_KEK missing or invalid");
    return false;
  }
}
