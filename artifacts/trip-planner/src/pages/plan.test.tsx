// @vitest-environment jsdom
/**
 * Plan-a-trip page — the conversational intake entry (Stories 1.1–1.3,
 * design Decisions 1–2).
 *
 * Covers: mounting the page creates an intake session via the API, and
 * Marco opens in intake scope (intake placeholder + intake empty-state
 * copy, history read scoped to the session — never a trip); Marco
 * speaks first — the session view's nextAsk question renders as his
 * opening message; and /plan?session=<id> resumes an existing session
 * (loaded via GET, never recreated via POST).
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

const FRESH_VIEW = {
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
};

interface FetchScript {
  createView?: Record<string, unknown>;
  sessionView?: Record<string, unknown>;
  historyMessages?: Array<{ role: string; content: string }>;
}

function installFetch(script: FetchScript = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  const mock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (url.includes("/api/agent/intake-sessions") && method === "POST") {
      return jsonResponse(201, script.createView ?? FRESH_VIEW);
    }
    if (/\/api\/agent\/intake-sessions\/\d+$/.test(url) && method === "GET") {
      return script.sessionView
        ? jsonResponse(200, script.sessionView)
        : jsonResponse(404, { error: "not found" });
    }
    if (url.includes("/api/agent/history")) {
      return jsonResponse(200, { messages: script.historyMessages ?? [] });
    }
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
    window.history.pushState({}, "", "/");
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

  it("Marco speaks first: the session's nextAsk renders as his opening message", async () => {
    installFetch({
      createView: {
        ...FRESH_VIEW,
        nextAsk: { key: "destination", slot: "destination", question: "Ok, where are we going?" },
      },
    });
    render(<PlanTripPage />);

    // The opening question is on screen before the traveler types,
    // presented as Marco's message (his name rides on it)…
    expect(await screen.findByText("Ok, where are we going?")).toBeTruthy();
    expect(screen.getAllByText("Marco").length).toBeGreaterThan(0);
    // …and the generic "you go first" empty-state copy is gone.
    expect(screen.queryByText(/Tell Marco where you'd like to go/)).toBeNull();
  });

  it("resumes an existing session from ?session= without creating a new one", async () => {
    window.history.pushState({}, "", "/plan?session=7");
    const calls = installFetch({
      sessionView: {
        ...FRESH_VIEW,
        id: 7,
        state: "PARTY",
        nextAsk: { key: "party", slot: "party", question: "Who's going?" },
      },
      historyMessages: [
        { role: "user", content: "I want to plan a trip" },
        { role: "assistant", content: "Munich — love it. Who's going?" },
      ],
    });
    render(<PlanTripPage />);

    // The existing conversation is back on screen…
    expect(await screen.findByText("Munich — love it. Who's going?")).toBeTruthy();
    // …loaded via GET in intake scope…
    expect(
      calls.some((c) => c.method === "GET" && /intake-sessions\/7$/.test(c.url)),
    ).toBe(true);
    expect(
      calls.some((c) => c.url.includes("/api/agent/history?intakeSessionId=7")),
    ).toBe(true);
    // …and no new session was created.
    const creates = calls.filter(
      (c) => c.method === "POST" && c.url.includes("/api/agent/intake-sessions"),
    );
    expect(creates.length).toBe(0);
  });
});
