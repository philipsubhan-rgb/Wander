// @vitest-environment jsdom
/**
 * Agent selection fence (design Decision 7).
 *
 * The legacy picker let a traveler switch a trip away from Marco to
 * the mock "Wander Assistant". The picker is retired and the selection
 * is pinned: whatever an older client stored, the resolved agent is
 * Marco — and the module no longer exports a picker component at all.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as agentModule from "./AgentPicker";
import { getSelectedAgentId, AGENT_OPTIONS, MARCO_AGENT_ID } from "./AgentPicker";

describe("agent selection fence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("always resolves to Marco, ignoring stored legacy choices", () => {
    localStorage.setItem("wander.selectedAgent", "wander");
    localStorage.setItem("wander.selectedAgent.trip.7", "wander");

    expect(getSelectedAgentId()).toBe("muse-spark");
    expect(getSelectedAgentId(7)).toBe("muse-spark");
    expect(getSelectedAgentId("7")).toBe("muse-spark");
    expect(MARCO_AGENT_ID).toBe("muse-spark");
  });

  it("keeps Marco in the display-name registry", () => {
    expect(AGENT_OPTIONS.find((o) => o.id === MARCO_AGENT_ID)?.name).toBe("Marco");
  });

  it("exports no picker component anymore", () => {
    expect((agentModule as Record<string, unknown>).default).toBeUndefined();
  });
});
