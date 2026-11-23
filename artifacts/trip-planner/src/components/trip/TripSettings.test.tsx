// @vitest-environment jsdom
/**
 * TripSettings — AgentPicker retirement (design Decision 7).
 *
 * Settings used to mount the legacy AgentPicker, which could switch a
 * trip away from Marco to the mock assistant. It now shows a static
 * "Marco is this trip's travel agent" card: no radios, no legacy agent
 * on offer, nothing to switch.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("@workspace/api-client-react", () => ({
  useUpdateTrip: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteTrip: () => ({ mutate: vi.fn(), isPending: false }),
  useListTripParticipants: () => ({ data: [] }),
  useAddTripParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveTripParticipant: () => ({ mutate: vi.fn(), isPending: false }),
  useLookupUserByEmail: () => ({ mutate: vi.fn() }),
  requestUploadUrl: vi.fn(),
  getGetTripQueryKey: () => ["getTrip"],
  getListTripParticipantsQueryKey: () => ["participants"],
  getListExpensesQueryKey: () => ["expenses"],
  getGetExpenseBalanceQueryKey: () => ["balance"],
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { TripSettings } from "@/components/trip/TripSettings";

const TRIP = {
  id: 7,
  title: "Munich guys' trip",
  destination: "Munich",
  startDate: "2026-09-24",
  endDate: "2026-09-28",
  status: "planning",
  coverImage: null,
};

describe("TripSettings agent section", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("presents Marco as the trip's agent with no way to switch", async () => {
    // The one-pager settings block fetches on mount; answer it quietly.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({}),
      })),
    );

    const { container } = render(<TripSettings trip={TRIP} />);

    expect(await screen.findByText("AI Travel Agent")).toBeTruthy();
    expect(screen.getByText(/no other agent to switch to/i)).toBeTruthy();

    // The legacy agent is not on offer, and there is no picker control.
    expect(screen.queryByText(/Wander Assistant/)).toBeNull();
    expect(screen.queryByText(/Choose your travel agent/)).toBeNull();
    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(0);
  });
});
