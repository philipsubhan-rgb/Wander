/**
 * Credential crypto tests — AES-256-GCM round-trip with a fixed test KEK.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encryptToken, decryptToken, credentialsEncryptionReady } from "./credentialCrypto.js";
import { randomBytes } from "node:crypto";

const TEST_KEK = randomBytes(32).toString("hex");
const saved = process.env.CREDENTIALS_KEK;

beforeEach(() => {
  process.env.CREDENTIALS_KEK = TEST_KEK;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CREDENTIALS_KEK;
  else process.env.CREDENTIALS_KEK = saved;
});

describe("credentialCrypto", () => {
  it("round-trips a refresh token", () => {
    const token = "1//0g-refresh-token-secret-value";
    const packed = encryptToken(token);
    expect(packed).not.toContain(token);
    expect(decryptToken(packed)).toBe(token);
  });

  it("produces different ciphertexts for the same plaintext (random IV)", () => {
    expect(encryptToken("abc")).not.toBe(encryptToken("abc"));
  });

  it("rejects tampered ciphertext", () => {
    const packed = encryptToken("abc");
    const [iv, ct, tag] = packed.split(":");
    const tampered = `${iv}:${ct}:${tag.slice(0, -2)}AA`;
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("reports not-ready when the KEK is missing", () => {
    delete process.env.CREDENTIALS_KEK;
    expect(credentialsEncryptionReady()).toBe(false);
    expect(() => encryptToken("abc")).toThrow(/CREDENTIALS_KEK/);
  });

  it("accepts base64 KEKs too", () => {
    process.env.CREDENTIALS_KEK = randomBytes(32).toString("base64");
    expect(decryptToken(encryptToken("hello"))).toBe("hello");
  });
});
