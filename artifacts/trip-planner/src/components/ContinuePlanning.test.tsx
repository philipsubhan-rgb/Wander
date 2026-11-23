// @vitest-environment jsdom
/**
 * ContinuePlanning — the dashboard's resume cards (design Decision 2).
 *
 * Covers: a started-but-unfinished intake renders as a card carrying
 * the destination-so-far, the machine state, and Marco's pending
 * question, linking to /plan?session=<id> (resume, not recreate); an
 * empty list and a failed read both render nothing at all.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import React from "react";

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function installFetch(handler: (url: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      return handler(url);
    }),
  );
  return calls;
}

import ContinuePlanning from "@/components/ContinuePlanning";

const MUNICH_DRAFT = {
  id: 7,
  state: "PARTY",
  slots: {
    destination: { value: { kind: "place", text: "Munich" }, provenance: "stated" },
  },
  nextAsk: { key: "party", slot: "party", question: "Who's going?" },
  updatedAt: "2026-11-22T09:30:00.000Z",
};

describe("ContinuePlanning", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders a resume card per draft, linking to the session resume path", async () => {
    const calls = installFetch(() => jsonResponse(200, { sessions: [MUNICH_DRAFT] }));
    render(<ContinuePlanning />);

    expect(await screen.findByText("Munich")).toBeTruthy();
    expect(calls).toEqual(["/api/agent/intake-sessions"]);

    // State + Marco's pending question ride on the card.
    expect(screen.getByText("Who's going")).toBeTruthy();
    expect(screen.getByText(/Marco's waiting on:/)).toBeTruthy();
    expect(screen.getByText(/Last touched/)).toBeTruthy();

    // The card is the resume link — /plan?session=7, not a fresh /plan.
    const link = screen.getByText("Munich").closest("a");
    expect(link?.getAttribute("href")).toBe("/plan?session=7");
  });

  it("renders nothing when there is nothing to resume", async () => {
    installFetch(() => jsonResponse(200, { sessions: [] }));
    const { container } = render(<ContinuePlanning />);

    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText("Continue planning")).toBeNull();
  });

  it("renders nothing when the read fails", async () => {
    installFetch(() => jsonResponse(500, { error: "boom" }));
    const { container } = render(<ContinuePlanning />);

    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByText("Continue planning")).toBeNull();
  });
});
