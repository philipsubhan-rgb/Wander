/**
 * profileCrypto tests — per-field AES-256-GCM with the field name AND
 * the profile owner's user id as GCM AAD (architecture-north-star §3.1,
 * QA finding F-1). The AAD binding is the point: a ciphertext produced
 * for one field must fail decryption under any other field's name, and
 * a ciphertext produced for one owner must fail in any other owner's
 * row, so ciphertexts can never be replayed across columns or rows.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
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
      const packed = encryptProfileField(77, field, samples[field]);
      expect(packed).not.toContain(samples[field]);
      expect(decryptProfileField(77, field, packed)).toBe(samples[field]);
    }
  });

  it("AAD: a ciphertext copied into a different field fails decryption", () => {
    const packed = encryptProfileField(77, "passport_number", "XUK1234567");
    for (const other of ENCRYPTED_FIELDS) {
      if (other === "passport_number") continue;
      expect(() => decryptProfileField(77, other, packed)).toThrow();
    }
    // …and into a plaintext field's name, for completeness.
    expect(() => decryptProfileField(77, "passport_expiry", packed)).toThrow();
    expect(() => decryptProfileField(77, "phone", packed)).toThrow();
  });

  it("AAD: the same plaintext encrypted under two fields yields field-bound ciphertexts", () => {
    const a = encryptProfileField(77, "date_of_birth", "1990-04-12");
    const b = encryptProfileField(77, "passport_number", "1990-04-12");
    expect(decryptProfileField(77, "date_of_birth", a)).toBe("1990-04-12");
    expect(decryptProfileField(77, "passport_number", b)).toBe("1990-04-12");
    expect(() => decryptProfileField(77, "passport_number", a)).toThrow();
    expect(() => decryptProfileField(77, "date_of_birth", b)).toThrow();
  });

  it("rejects tampered ciphertext and tampered auth tags", () => {
    const packed = encryptProfileField(77, "passport_number", "XUK1234567");
    const [iv, ct, tag] = packed.split(":");
    const flip = (s: string) => (s.startsWith("A") ? "B" : "A") + s.slice(1);
    expect(() => decryptProfileField(77, "passport_number", `${iv}:${flip(ct)}:${tag}`)).toThrow();
    expect(() => decryptProfileField(77, "passport_number", `${iv}:${ct}:${flip(tag)}`)).toThrow();
    expect(() => decryptProfileField(77, "passport_number", `${flip(iv)}:${ct}:${tag}`)).toThrow();
    expect(() => decryptProfileField(77, "passport_number", "not-a-packed-value")).toThrow();
  });

  it("F-1: AAD binds the owner — a ciphertext transplanted into another user's row fails decryption", () => {
    const packed = encryptProfileField(77, "passport_number", "XUK1234567");
    expect(decryptProfileField(77, "passport_number", packed)).toBe("XUK1234567");
    // The same ciphertext sitting in user 88's row must NOT decrypt as 88's.
    expect(() => decryptProfileField(88, "passport_number", packed)).toThrow();
    // …and the reverse transplant fails too.
    const foreign = encryptProfileField(88, "passport_number", "XUK1234567");
    expect(() => decryptProfileField(77, "passport_number", foreign)).toThrow();
  });

  it("F-1: pre-fix ciphertexts (field-name-only AAD) fail closed", () => {
    // Reconstruct the ORIGINAL format by hand: same KEK, same envelope,
    // but the AAD was the bare field name. The vault was never deployed,
    // so no live data uses it — and if any ever surfaced, it must fail
    // decryption rather than silently succeed under the weaker binding.
    const key = Buffer.from(TEST_KEK, "hex");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(Buffer.from("passport_number", "utf8"));
    const ct = Buffer.concat([cipher.update("XUK1234567", "utf8"), cipher.final()]);
    const legacy = [iv.toString("base64"), ct.toString("base64"), cipher.getAuthTag().toString("base64")].join(":");
    expect(() => decryptProfileField(77, "passport_number", legacy)).toThrow();
  });

  it("produces different ciphertexts for the same plaintext and field (random IV)", () => {
    expect(encryptProfileField(77, "passport_number", "XUK1234567")).not.toBe(
      encryptProfileField(77, "passport_number", "XUK1234567"),
    );
  });

  it("fails closed when the KEK is missing", () => {
    delete process.env.CREDENTIALS_KEK;
    expect(profileEncryptionReady()).toBe(false);
    expect(() => encryptProfileField(77, "passport_number", "XUK1234567")).toThrow(/CREDENTIALS_KEK/);
    expect(() => decryptProfileField(77, "passport_number", "a:b:c")).toThrow(/CREDENTIALS_KEK/);
  });

  it("shares the credential KEK: hex and base64 forms both work", () => {
    process.env.CREDENTIALS_KEK = randomBytes(32).toString("base64");
    const packed = encryptProfileField(77, "date_of_birth", "1990-04-12");
    expect(decryptProfileField(77, "date_of_birth", packed)).toBe("1990-04-12");
    expect(profileEncryptionReady()).toBe(true);
  });
});
