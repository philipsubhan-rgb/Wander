/**
 * Free/busy at the intake DATES step (§4.1): when exact dates are set
 * and the traveler's connected calendar has something on them, the
 * intake_set_dates tool result carries the plain fact — and NOTHING
 * else. The leak scan poisons the checker's return with sentinel
 * content a regression might add; none of it may reach the tool text
 * (which is what Marco voices).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const intakeMock = vi.hoisted(() => ({
  applyIntakeSlotWrite: vi.fn(),
}));

const freeBusyMock = vi.hoisted(() => ({
  checkFreeBusyForDates: vi.fn(),
}));

vi.mock("./intake", () => ({
  applyIntakeSlotWrite: intakeMock.applyIntakeSlotWrite,
  applyIntakeSkip: vi.fn(),
  applyIntakePartyFromGroup: vi.fn(),
  assertIntakeAccess: vi.fn(),
  confirmIntakeSlot: vi.fn(),
  materializeIntake: vi.fn(),
  IntakeAccessDenied: class extends Error {},
  IntakeGroupNotFound: class extends Error {},
  IntakeMaterializationError: class extends Error {},
}));

vi.mock("./calendarFreeBusy", () => ({
  checkFreeBusyForDates: freeBusyMock.checkFreeBusyForDates,
}));

import { getIntakeToolDefinition } from "./agentIntakeTools";
import type { AgentToolResult, ToolContext, ToolDefinition } from "./agentTools";

const CTX: ToolContext = { userId: 42, role: "traveler", intakeSessionId: 5 };

/** ToolDefinition types run-args as never (each tool casts its own
 * handler in); call through a typed façade. */
function runTool(tool: ToolDefinition, args: unknown): Promise<AgentToolResult> {
  return (tool.run as (ctx: ToolContext, a: unknown) => Promise<AgentToolResult>)(CTX, args);
}

function datesView() {
  return {
    id: 5,
    userId: 42,
    state: "STYLE",
    slots: {
      dates: {
        value: { startDate: "2027-03-10", endDate: "2027-03-14" },
        provenance: "asked",
      },
    },
    openItems: [],
    draftTripId: null,
    channel: "text",
    questionsAsked: 3,
    nextAsk: { key: "style", slot: "style", question: "What kind of trip is this?" },
    reviewSummary: ["Dates: 2027-03-10 → 2027-03-14"],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  intakeMock.applyIntakeSlotWrite.mockResolvedValue(datesView());
});

describe("intake_set_dates — the free/busy flag", () => {
  it("a collision is flagged in plain terms — 'you have something on those dates'", async () => {
    freeBusyMock.checkFreeBusyForDates.mockResolvedValue({
      connected: true,
      conflict: true,
      busyCount: 2,
    });
    const tool = getIntakeToolDefinition("intake_set_dates")!;
    const result = await runTool(tool, {
      startDate: "2027-03-10",
      endDate: "2027-03-14",
      provenance: "asked",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("has something on those dates");
    expect(freeBusyMock.checkFreeBusyForDates).toHaveBeenCalledWith(42, "2027-03-10", "2027-03-14");
  });

  it("CONTENT-LEAK SCAN: sentinel titles/intervals in the check result never reach the tool text", async () => {
    freeBusyMock.checkFreeBusyForDates.mockResolvedValue({
      connected: true,
      conflict: true,
      busyCount: 1,
      // Poisoned extras — a future regression's shape. The tool reads
      // only {connected, conflict}; none of this may surface.
      busy: [{ start: "SENTINEL_INTERVAL_START", end: "SENTINEL_INTERVAL_END" }],
      titles: ["SENTINEL_EVENT_TITLE"],
      attendees: ["sentinel@example.com"],
    });
    const tool = getIntakeToolDefinition("intake_set_dates")!;
    const result = await runTool(tool, {
      startDate: "2027-03-10",
      endDate: "2027-03-14",
      provenance: "asked",
    });
    expect(result.text).not.toContain("SENTINEL");
    expect(result.text).not.toContain("sentinel@example.com");
    expect(result.text).toContain("has something on those dates");
  });

  it("no conflict → no flag, the result is exactly the pre-rung-2 text", async () => {
    freeBusyMock.checkFreeBusyForDates.mockResolvedValue({
      connected: true,
      conflict: false,
      busyCount: 0,
    });
    const tool = getIntakeToolDefinition("intake_set_dates")!;
    const result = await runTool(tool, {
      startDate: "2027-03-10",
      endDate: "2027-03-14",
      provenance: "asked",
    });
    expect(result.text).not.toContain("Calendar check");
  });

  it("no connected account → DATES proceeds exactly as today (checker still consulted, flag absent)", async () => {
    freeBusyMock.checkFreeBusyForDates.mockResolvedValue({
      connected: false,
      conflict: false,
      busyCount: 0,
    });
    const tool = getIntakeToolDefinition("intake_set_dates")!;
    const result = await runTool(tool, {
      startDate: "2027-03-10",
      endDate: "2027-03-14",
      provenance: "asked",
    });
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Dates recorded.");
    expect(result.text).not.toContain("Calendar check");
  });

  it("fuzzy dates (no exact window) never trigger a free/busy check", async () => {
    intakeMock.applyIntakeSlotWrite.mockResolvedValue({
      ...datesView(),
      slots: { dates: { value: { windowText: "late March" }, provenance: "asked" } },
    });
    const tool = getIntakeToolDefinition("intake_set_dates")!;
    const result = await runTool(tool, { windowText: "late March", provenance: "asked" });
    expect(result.ok).toBe(true);
    expect(freeBusyMock.checkFreeBusyForDates).not.toHaveBeenCalled();
  });
});
