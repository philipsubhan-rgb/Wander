/**
 * Tests for sendDailyBriefingEmail.
 *
 * The "no SMTP configured" path must return { sent: false } without throwing —
 * this is the path exercised in development/test environments.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sendDailyBriefingEmail } from "./email.js";

const SMTP_VARS = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of SMTP_VARS) {
    saved[v] = process.env[v];
    delete process.env[v];
  }
});

afterEach(() => {
  for (const v of SMTP_VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
});

describe("sendDailyBriefingEmail", () => {
  it("returns { sent: false } without throwing when SMTP is not configured", async () => {
    const result = await sendDailyBriefingEmail({
      to: ["alice@example.com", "bob@example.com"],
      tripTitle: "Munich Trip",
      dateLabel: "Thu Sep 24",
      pdfBuffer: Buffer.from("%PDF-1.4 fake"),
      filename: "wander-one-pager-1-2026-09-24.pdf",
    });

    expect(result).toEqual({ sent: false });
  });

  it("handles a single recipient without throwing when SMTP is not configured", async () => {
    const result = await sendDailyBriefingEmail({
      to: ["solo@example.com"],
      tripTitle: "Munich Trip",
      dateLabel: "Thu Sep 24",
      pdfBuffer: Buffer.from("%PDF-1.4 fake"),
      filename: "wander-one-pager-1-2026-09-24.pdf",
    });

    expect(result.sent).toBe(false);
  });
});
