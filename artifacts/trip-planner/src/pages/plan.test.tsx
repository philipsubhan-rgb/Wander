// @vitest-environment jsdom
/**
 * Plan-a-trip page — the conversational intake entry (Stories 1.1–1.3).
 *
 * Covers: mounting the page creates an intake session via the API, and
 * Marco opens in intake scope (intake placeholder + intake empty-state
 * copy, history read scoped to the session — never a trip).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

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
    if (url.includes("/api/agent/intake-sessions") && method === "POST") {
      return jsonResponse(201, {
        id: 42,
        userId: 5,
        state: "OPENING",
        slots: {},
        openItems: [],
        draftTripId: null,
        channel: "text",
        questionsAsked: 0,
        nextAsk: null,
        reviewSummary: [],
      });
    }
    if (url.includes("/api/agent/history")) return jsonResponse(200, { messages: [] });
    return jsonResponse(200, {});
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

import PlanTripPage from "@/pages/plan";

describe("PlanTripPage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("creates an intake session on mount and opens Marco in intake scope", async () => {
    const calls = installFetch();
    render(<PlanTripPage />);

    // Marco's panel is open (the page uses defaultOpen, so the visible
    // input is the chat's own) with the intake empty-state copy, not
    // the trip copy.
    expect(await screen.findByPlaceholderText(/Message Marco/)).toBeTruthy();
    expect(screen.getByText(/Tell Marco where you'd like to go/)).toBeTruthy();

    // The session was created exactly once…
    const creates = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/api/agent/intake-sessions"),
    );
    expect(creates.length).toBe(1);
    // …and the conversation history was read in intake scope.
    expect(
      calls.some((c) => c.url.includes("/api/agent/history?intakeSessionId=42")),
    ).toBe(true);
    expect(calls.some((c) => c.url.includes("tripId="))).toBe(false);
  });
});
