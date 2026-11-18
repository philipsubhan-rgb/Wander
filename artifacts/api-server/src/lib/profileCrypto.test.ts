/**
 * profileCrypto tests — per-field AES-256-GCM with the field name as
 * GCM AAD (architecture-north-star §3.1). The AAD binding is the point:
 * a ciphertext produced for one field must fail decryption under any
 * other field's name, so ciphertexts can never be replayed across
 * columns.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import {
  decryptProfileField,
  encryptProfileField,
  profileEncryptionReady,
} from "./profileCrypto.js";

const TEST_KEK = randomBytes(32).toString("hex");
const saved = process.env.CREDENTIALS_KEK;

beforeEach(() => {
  process.env.CREDENTIALS_KEK = TEST_KEK;
});

afterEach(() => {
  if (saved === undefined) delete process.env.CREDENTIALS_KEK;
  else process.env.CREDENTIALS_KEK = saved;
});

const ENCRYPTED_FIELDS = ["date_of_birth", "passport_number", "emergency_contact"] as const;

describe("profileCrypto", () => {
  it("round-trips every encrypted vault field", () => {
    const samples: Record<string, string> = {
      date_of_birth: "1990-04-12",
      passport_number: "XUK1234567",
      emergency_contact: JSON.stringify({ name: "Mom", relationship: "mother", phone: "+1-555-0100" }),
    };
    for (const field of ENCRYPTED_FIELDS) {
      const packed = encryptProfileField(field, samples[field]);
      expect(packed).not.toContain(samples[field]);
      expect(decryptProfileField(field, packed)).toBe(samples[field]);
    }
  });

  it("AAD: a ciphertext copied into a different field fails decryption", () => {
    const packed = encryptProfileField("passport_number", "XUK1234567");
    for (const other of ENCRYPTED_FIELDS) {
      if (other === "passport_number") continue;
      expect(() => decryptProfileField(other, packed)).toThrow();
    }
    // …and into a plaintext field's name, for completeness.
    expect(() => decryptProfileField("passport_expiry", packed)).toThrow();
    expect(() => decryptProfileField("phone", packed)).toThrow();
  });

  it("AAD: the same plaintext encrypted under two fields yields field-bound ciphertexts", () => {
    const a = encryptProfileField("date_of_birth", "1990-04-12");
    const b = encryptProfileField("passport_number", "1990-04-12");
    expect(decryptProfileField("date_of_birth", a)).toBe("1990-04-12");
    expect(decryptProfileField("passport_number", b)).toBe("1990-04-12");
    expect(() => decryptProfileField("passport_number", a)).toThrow();
    expect(() => decryptProfileField("date_of_birth", b)).toThrow();
  });

  it("rejects tampered ciphertext and tampered auth tags", () => {
    const packed = encryptProfileField("passport_number", "XUK1234567");
    const [iv, ct, tag] = packed.split(":");
    const flip = (s: string) => (s.startsWith("A") ? "B" : "A") + s.slice(1);
    expect(() => decryptProfileField("passport_number", `${iv}:${flip(ct)}:${tag}`)).toThrow();
    expect(() => decryptProfileField("passport_number", `${iv}:${ct}:${flip(tag)}`)).toThrow();
    expect(() => decryptProfileField("passport_number", `${flip(iv)}:${ct}:${tag}`)).toThrow();
    expect(() => decryptProfileField("passport_number", "not-a-packed-value")).toThrow();
  });

  it("produces different ciphertexts for the same plaintext and field (random IV)", () => {
    expect(encryptProfileField("passport_number", "XUK1234567")).not.toBe(
      encryptProfileField("passport_number", "XUK1234567"),
    );
  });

  it("fails closed when the KEK is missing", () => {
    delete process.env.CREDENTIALS_KEK;
    expect(profileEncryptionReady()).toBe(false);
    expect(() => encryptProfileField("passport_number", "XUK1234567")).toThrow(/CREDENTIALS_KEK/);
    expect(() => decryptProfileField("passport_number", "a:b:c")).toThrow(/CREDENTIALS_KEK/);
  });

  it("shares the credential KEK: hex and base64 forms both work", () => {
    process.env.CREDENTIALS_KEK = randomBytes(32).toString("base64");
    const packed = encryptProfileField("date_of_birth", "1990-04-12");
    expect(decryptProfileField("date_of_birth", packed)).toBe("1990-04-12");
    expect(profileEncryptionReady()).toBe(true);
  });
});
