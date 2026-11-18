// @vitest-environment jsdom
/**
 * TripRoster — the organizer's status projection (Story 3.2, §3.3).
 *
 * Covers: projection rendering (status, missing field NAMES, chase
 * summary), the one send path firing on the organizer's explicit
 * action, read-only rendering for non-organizers, and — the privacy
 * point — that rendering the roster never touches a profile endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const ROSTER = [
  {
    id: 11,
    tripId: 7,
    invitedName: "Kurt Rao",
    invitedEmail: "kurt@example.com",
    status: "setting_up",
    hasLinkedAccount: false,
    missingFields: ["passport", "date_of_birth"],
    chase: {
      invitesSent: 1,
      remindersSent: 2,
      paused: false,
      nextDueAt: "2026-12-01T15:00:00.000Z",
      escalated: false,
      lastFailureReason: null,
    },
  },
  {
    id: 12,
    tripId: 7,
    invitedName: "Pradip Tripathy",
    invitedEmail: "pradip@example.com",
    status: "ready",
    hasLinkedAccount: true,
    missingFields: [],
    chase: {
      invitesSent: 1,
      remindersSent: 0,
      paused: false,
      nextDueAt: null,
      escalated: false,
      lastFailureReason: null,
    },
  },
];

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function installFetch() {
  const calls: Array<{ url: string; method: string }> = [];
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.includes("/roster/send-invites")) {
      return jsonResponse(200, { sent: [11], needsEmail: [], failed: [], skipped: [{ entryId: 12, reason: "status_ready" }] });
    }
    if (url.includes("/roster")) return jsonResponse(200, { roster: ROSTER });
    return jsonResponse(200, {});
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

import { TripRoster } from "@/components/trip/TripRoster";

describe("TripRoster", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the status projection: names, statuses, missing field names, chase summary", async () => {
    installFetch();
    render(<TripRoster tripId={7} canManage />);

    expect(await screen.findByText("Kurt Rao")).toBeTruthy();
    expect(screen.getByText("Pradip Tripathy")).toBeTruthy();
    expect(screen.getByText("Setting up")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    // Missing fields are NAMES in general terms — never values.
    expect(screen.getByText(/Still needed:/)).toBeTruthy();
    expect(screen.getByText(/Passport details, Date of birth/)).toBeTruthy();
    expect(screen.getByText(/2 reminders sent/)).toBeTruthy();
    expect(screen.getByText(/All set — nothing outstanding/)).toBeTruthy();
  });

  it("never calls a profile endpoint to render the roster", async () => {
    const calls = installFetch();
    render(<TripRoster tripId={7} canManage />);
    await screen.findByText("Kurt Rao");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => !c.url.includes("/profile"))).toBe(true);
    expect(calls.every((c) => c.url.includes("/roster"))).toBe(true);
  });

  it("sends invitations only from the explicit Send action", async () => {
    const calls = installFetch();
    render(<TripRoster tripId={7} canManage />);

    const sendButton = await screen.findByText(/Send invitations \(1\)/);
    // Nothing has been sent just by viewing the roster.
    expect(calls.some((c) => c.url.includes("send-invites"))).toBe(false);

    fireEvent.click(sendButton);
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.url.includes("/api/trips/7/roster/send-invites")),
      ).toBe(true),
    );
  });

  it("hides organizer actions from non-organizers", async () => {
    installFetch();
    render(<TripRoster tripId={7} canManage={false} />);
    await screen.findByText("Kurt Rao");
    expect(screen.queryByText(/Send invitations/)).toBeNull();
    expect(screen.queryByText("Resend invite")).toBeNull();
    expect(screen.queryByText("Pause reminders")).toBeNull();
    expect(screen.getByText(/read-only status view/)).toBeTruthy();
  });
});
