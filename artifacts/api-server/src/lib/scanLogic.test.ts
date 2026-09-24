/**
 * Unit tests for the Gmail-ingestion scan pipeline helpers.
 * Pure logic — no Express server, no DB.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  normalizeConfirmationCode,
  isDuplicateConfirmationCode,
  matchTrip,
  signState,
  verifyState,
  newOAuthState,
  type OAuthState,
} from "./scanLogic.js";

describe("normalizeConfirmationCode", () => {
  it("uppercases lowercase codes", () => {
    expect(normalizeConfirmationCode("gygzgzrlxq5v")).toBe("GYGZGZRLXQ5V");
  });

  it("strips dashes and spaces", () => {
    expect(normalizeConfirmationCode("JQ-ZZ 2H")).toBe("JQZZ2H");
  });

  it("leaves clean codes untouched", () => {
    expect(normalizeConfirmationCode("9739037749")).toBe("9739037749");
  });
});

describe("isDuplicateConfirmationCode", () => {
  it("detects an exact code match", () => {
    const seen = new Set(["GYGZGZRLXQ5V"]);
    expect(isDuplicateConfirmationCode(seen, "GYGZGZRLXQ5V")).toBe(true);
  });

  it("matches case-insensitively (TripIt vs vendor casing)", () => {
    const seen = new Set(["GYGZGZRLXQ5V"]);
    expect(isDuplicateConfirmationCode(seen, "gygzgzrlxq5v")).toBe(true);
  });

  it("returns false for a new code", () => {
    const seen = new Set(["GYGZGZRLXQ5V"]);
    expect(isDuplicateConfirmationCode(seen, "JQZZ2H")).toBe(false);
  });

  it("returns false when there is no code", () => {
    const seen = new Set(["GYGZGZRLXQ5V"]);
    expect(isDuplicateConfirmationCode(seen, undefined)).toBe(false);
  });
});

describe("matchTrip", () => {
  const trips = [
    { id: 1, startDate: "2026-09-23", endDate: "2026-09-28" },
    { id: 2, startDate: "2027-05-08", endDate: "2027-05-13" },
  ];

  it("matches a date inside exactly one trip", () => {
    expect(matchTrip(trips, "2026-09-26")).toBe(1);
    expect(matchTrip(trips, "2027-05-10")).toBe(2);
  });

  it("matches boundary dates inclusively", () => {
    expect(matchTrip(trips, "2026-09-23")).toBe(1);
    expect(matchTrip(trips, "2026-09-28")).toBe(1);
  });

  it("returns null when the date matches no trip", () => {
    expect(matchTrip(trips, "2026-10-01")).toBeNull();
  });

  it("returns null when the date is ambiguous across trips", () => {
    const overlapping = [
      { id: 1, startDate: "2026-09-23", endDate: "2026-09-28" },
      { id: 2, startDate: "2026-09-25", endDate: "2026-09-30" },
    ];
    expect(matchTrip(overlapping, "2026-09-26")).toBeNull();
  });

  it("returns null when there is no date", () => {
    expect(matchTrip(trips, undefined)).toBeNull();
  });
});

describe("OAuth state signing", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-secret-for-scan-logic";
  });

  const base: OAuthState = {
    userId: 42,
    returnTo: "/settings",
    nonce: "abc123",
    exp: Date.now() + 10 * 60 * 1000,
  };

  it("round-trips a signed state", () => {
    const signed = signState(base);
    const verified = verifyState(signed);
    expect(verified).not.toBeNull();
    expect(verified?.userId).toBe(42);
    expect(verified?.returnTo).toBe("/settings");
  });

  it("rejects a tampered payload", () => {
    const signed = signState(base);
    const [payload, sig] = signed.split(".");
    const tampered = Buffer.from(JSON.stringify({ ...base, userId: 99 })).toString("base64url");
    expect(verifyState(`${tampered}.${sig}`)).toBeNull();
    expect(payload).toBeTruthy();
  });

  it("rejects a tampered signature", () => {
    const signed = signState(base);
    const [payload] = signed.split(".");
    expect(verifyState(`${payload}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`)).toBeNull();
  });

  it("rejects an expired state", () => {
    const signed = signState({ ...base, exp: Date.now() - 1000 });
    expect(verifyState(signed)).toBeNull();
  });

  it("rejects malformed input", () => {
    expect(verifyState("")).toBeNull();
    expect(verifyState("not-a-state")).toBeNull();
    expect(verifyState("a.b.c")).toBeNull();
  });

  it("rejects a state signed with a different secret", () => {
    const signed = signState(base);
    process.env.SESSION_SECRET = "a-different-secret";
    expect(verifyState(signed)).toBeNull();
  });

  it("newOAuthState builds a verifiable state with a 10-minute expiry", () => {
    const before = Date.now();
    const verified = verifyState(newOAuthState(7, "/settings"));
    expect(verified?.userId).toBe(7);
    expect(verified!.exp).toBeGreaterThan(before + 9 * 60 * 1000);
    expect(verified!.exp).toBeLessThanOrEqual(before + 10 * 60 * 1000 + 1000);
  });
});
