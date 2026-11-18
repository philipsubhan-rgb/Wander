// @vitest-environment jsdom
/**
 * Traveler setup page — the invitee trust surface (Story 4.3).
 *
 * Covers: inviter context + privacy promise rendered before the form,
 * the emailed-link token shape (?token=), expired/used token states,
 * a clean submit, a validation failure that keeps the form usable
 * (the API validates before consuming the token), and decline.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";

const CONTEXT = {
  travelerName: "Kurt Rao",
  organizerName: "Phil Subhan",
  trip: {
    title: "Munich guys' trip",
    destination: "Munich",
    startDate: "2026-09-24",
    endDate: "2026-09-28",
  },
  status: "setting_up",
  requiredFields: [
    { name: "passport", label: "your passport details" },
    { name: "date_of_birth", label: "your date of birth" },
  ],
  missingFields: [
    { name: "passport", label: "your passport details" },
    { name: "date_of_birth", label: "your date of birth" },
  ],
  privacyNotice:
    "Your details are private. You enter them yourself, directly to Wander. Phil Subhan can only see whether your details are complete — never the details themselves. Nobody else on the trip can see them either.",
  profileSetupAvailable: true,
};

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

interface FetchCall {
  url: string;
  method: string;
}

function installFetch(handler: (url: string, method: string) => Response) {
  const calls: FetchCall[] = [];
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    return handler(url, method);
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

import TravelerSetupPage from "@/pages/traveler-setup";

describe("TravelerSetupPage", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/traveler-setup?token=tok123");
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders inviter context, the privacy promise, and what's asked — before the form", async () => {
    installFetch(() => jsonResponse(200, CONTEXT));
    render(<TravelerSetupPage />);

    expect(await screen.findByText(/you're invited/)).toBeTruthy();
    expect(screen.getByText(/Munich guys' trip/)).toBeTruthy();
    // The server's privacy notice, verbatim.
    expect(screen.getByText(CONTEXT.privacyNotice)).toBeTruthy();
    // What's asked, in general terms.
    expect(screen.getByText("Passport details")).toBeTruthy();
    expect(screen.getAllByText("Date of birth").length).toBeGreaterThan(0);
    // The form exists, with trip-required markers.
    expect(screen.getByText("Save my details")).toBeTruthy();
    expect(screen.getAllByText("Needed for this trip").length).toBeGreaterThan(0);

    // Promise order: the privacy notice appears before the form's
    // first field label in the document.
    const text = document.body.textContent ?? "";
    expect(text.indexOf(CONTEXT.privacyNotice)).toBeGreaterThan(-1);
    expect(text.indexOf(CONTEXT.privacyNotice)).toBeLessThan(text.indexOf("Email address"));
  });

  it("shows the expired state for an expired token", async () => {
    installFetch(() =>
      jsonResponse(410, { error: "This invitation link has expired.", reason: "expired" }),
    );
    render(<TravelerSetupPage />);
    expect(await screen.findByText("This link has expired")).toBeTruthy();
    expect(screen.queryByText("Save my details")).toBeNull();
  });

  it("shows the already-used state for a consumed token", async () => {
    installFetch(() =>
      jsonResponse(400, { error: "This invitation link has already been used.", reason: "used" }),
    );
    render(<TravelerSetupPage />);
    expect(await screen.findByText("This link has already been used")).toBeTruthy();
  });

  it("submits and shows the all-set state", async () => {
    const calls = installFetch((url, method) => {
      if (method === "POST" && url.includes("/submit")) {
        return jsonResponse(200, { status: "ready", missingFields: [], warnings: [] });
      }
      return jsonResponse(200, CONTEXT);
    });
    render(<TravelerSetupPage />);
    fireEvent.click(await screen.findByText("Save my details"));
    expect(await screen.findByText(/You're all set, Kurt/)).toBeTruthy();
    expect(
      calls.some((c) => c.method === "POST" && c.url.includes("/api/traveler-setup/tok123/submit")),
    ).toBe(true);
  });

  it("renders server validation problems inline and keeps the form usable", async () => {
    installFetch((url, method) => {
      if (method === "POST" && url.includes("/submit")) {
        return jsonResponse(400, {
          error: "Invalid profile data",
          problems: ["date_of_birth must be a real date in YYYY-MM-DD format"],
        });
      }
      return jsonResponse(200, CONTEXT);
    });
    render(<TravelerSetupPage />);
    fireEvent.click(await screen.findByText("Save my details"));
    expect(
      await screen.findByText("date_of_birth must be a real date in YYYY-MM-DD format"),
    ).toBeTruthy();
    // Nothing was saved and the token was not consumed: the form —
    // and its submit button — are still here for a retry.
    expect(screen.getByText("Save my details")).toBeTruthy();
  });

  it("declines through the two-step confirm", async () => {
    const calls = installFetch((url, method) => {
      if (method === "POST" && url.includes("/decline")) {
        return jsonResponse(200, { status: "declined" });
      }
      return jsonResponse(200, CONTEXT);
    });
    render(<TravelerSetupPage />);
    fireEvent.click(await screen.findByText("Let Phil Subhan know"));
    fireEvent.click(await screen.findByText("Yes, let them know"));
    expect(await screen.findByText("No hard feelings")).toBeTruthy();
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.url.includes("/api/traveler-setup/tok123/decline")),
      ).toBe(true),
    );
  });
});
