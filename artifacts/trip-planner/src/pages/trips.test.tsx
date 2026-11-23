// @vitest-environment jsdom
/**
 * Trips dashboard — the Marco-first front door (design Decision 1).
 *
 * The dashboard is the post-login landing. It must lead with Marco
 * (hero + planner CTA), keep the trips reachable below, and demote
 * the blank form to a secondary "Create manually" path — the old
 * co-equal "New Trip" button is gone.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("@workspace/api-client-react", () => ({
  useListTrips: () => ({ data: [], isLoading: false }),
  useCreateTrip: () => ({ mutate: vi.fn(), isPending: false }),
  getListTripsQueryKey: () => ["listTrips"],
}));

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ isAuthenticated: true }),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import TripsDashboard from "@/pages/trips";

describe("TripsDashboard front door", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("leads with Marco and demotes the blank form to 'Create manually'", async () => {
    // The Continue-planning section reads its endpoint; answer empty.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ sessions: [] }),
      })),
    );

    render(<TripsDashboard />);

    // Marco's hero is the headline, with the planner as primary CTA.
    expect(await screen.findByText("Where to next?")).toBeTruthy();
    const plannerCta = screen.getByText("Plan a trip with Marco").closest("a");
    expect(plannerCta?.getAttribute("href")).toBe("/plan");
    expect(screen.getByText("Plan it with Marco")).toBeTruthy();

    // The form survives only as the demoted manual path — no "New Trip".
    expect(screen.getAllByText("Create manually").length).toBeGreaterThan(0);
    expect(screen.queryByText("New Trip")).toBeNull();
    expect(screen.queryByText("Create First Trip")).toBeNull();
  });
});
