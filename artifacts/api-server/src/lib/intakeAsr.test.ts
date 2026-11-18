/**
 * §2.4 ASR read-back rule — a voice-sourced intake slot write with
 * low recognition confidence is stored as `needs_confirm`: the slot
 * does not settle, the machine's next ask reads the value back, and
 * materialization stays unreachable until the traveler confirms (or
 * corrects with a fresh write). Text writes are unaffected.
 *
 * Logic-level tests run the pure machine; service-level tests run the
 * Intake Service against a recording db mock and prove the rule is
 * applied at the write seam (applyIntakeSlotWrite's source param).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  applyAsrProvenance,
  applySlotConfirmation,
  applySlotWrite,
  buildMaterializationPlan,
  deriveState,
  emptyIntakeData,
  isSlotSettled,
  markIntent,
  nextAsk,
  slotReadBackQuestion,
  ASR_CONFIDENCE_THRESHOLD,
  type IntakeData,
} from "./intakeLogic";

// ─── Pure logic ──────────────────────────────────────────────────────────────

describe("applyAsrProvenance — the threshold rule", () => {
  it("voice below the threshold → needs_confirm, whatever was claimed", () => {
    expect(applyAsrProvenance("stated", { channel: "voice", asrConfidence: 0.42 })).toBe("needs_confirm");
    expect(applyAsrProvenance("asked", { channel: "voice", asrConfidence: 0 })).toBe("needs_confirm");
  });

  it("voice at or above the threshold is untouched", () => {
    expect(applyAsrProvenance("stated", { channel: "voice", asrConfidence: ASR_CONFIDENCE_THRESHOLD })).toBe("stated");
    expect(applyAsrProvenance("stated", { channel: "voice", asrConfidence: 0.97 })).toBe("stated");
  });

  it("voice with NO confidence signal is untouched (absence is not low confidence)", () => {
    expect(applyAsrProvenance("stated", { channel: "voice" })).toBe("stated");
  });

  it("text writes are never affected, even with a (meaningless) low score attached", () => {
    expect(applyAsrProvenance("stated", { channel: "text", asrConfidence: 0.1 })).toBe("stated");
    expect(applyAsrProvenance("stated", undefined)).toBe("stated");
  });
});

function lowConfidenceDestination(): IntakeData {
  return applySlotWrite(markIntent(emptyIntakeData()), {
    slot: "destination",
    value: { kind: "place", text: "Scottsdale" },
    provenance: applyAsrProvenance("stated", { channel: "voice", asrConfidence: 0.42 }),
  });
}

describe("the read-back flow (pure machine)", () => {
  it("a low-confidence destination is stored but does NOT settle; the next ask is the read-back", () => {
    const data = lowConfidenceDestination();
    expect(data.destination?.value.text).toBe("Scottsdale");
    expect(data.destination?.provenance).toBe("needs_confirm");
    expect(isSlotSettled(data, "destination")).toBe(false);
    expect(deriveState(data, null)).toBe("DESTINATION");
    const ask = nextAsk(data, null);
    expect(ask?.key).toBe("confirm:destination");
    expect(ask?.question).toBe('I heard "Scottsdale" — is that right?');
  });

  it("read-back questions render each slot's value as heard", () => {
    let data = markIntent(emptyIntakeData());
    data = applySlotWrite(data, {
      slot: "dates",
      value: { startDate: "2027-03-10", endDate: "2027-03-14" },
      provenance: "needs_confirm",
    });
    expect(slotReadBackQuestion(data, "dates")).toBe(
      "I heard 2027-03-10 to 2027-03-14 for the dates — is that right?",
    );
    expect(slotReadBackQuestion(data, "destination")).toBeNull();
  });

  it("confirming the read-back settles the slot and the machine advances", () => {
    const data = applySlotConfirmation(lowConfidenceDestination(), "destination");
    expect(data.destination?.provenance).toBe("stated");
    expect(isSlotSettled(data, "destination")).toBe(true);
    expect(deriveState(data, null)).toBe("PARTY");
    expect(nextAsk(data, null)?.key).toBe("party");
  });

  it("confirming a slot that isn't awaiting read-back is a no-op", () => {
    const data = applySlotWrite(markIntent(emptyIntakeData()), {
      slot: "destination",
      value: { kind: "place", text: "Scottsdale" },
      provenance: "stated",
    });
    expect(applySlotConfirmation(data, "destination")).toBe(data);
  });

  it("a correction (fresh write) replaces the shaky hearing and settles", () => {
    const corrected = applySlotWrite(lowConfidenceDestination(), {
      slot: "destination",
      value: { kind: "place", text: "Sedona" },
      provenance: "asked",
    });
    expect(corrected.destination?.value.text).toBe("Sedona");
    expect(isSlotSettled(corrected, "destination")).toBe(true);
  });

  it("materialization is unreachable while any slot awaits read-back", () => {
    let data = markIntent(emptyIntakeData());
    data = applySlotWrite(data, {
      slot: "destination",
      value: { kind: "place", text: "Scottsdale" },
      provenance: "needs_confirm",
    });
    data = applySlotWrite(data, { slot: "party", value: { solo: true, travelers: [] }, provenance: "asked" });
    data = applySlotWrite(data, {
      slot: "dates",
      value: { startDate: "2027-03-10", endDate: "2027-03-14" },
      provenance: "asked",
    });
    data = applySlotWrite(data, { slot: "style", value: { text: "golf weekend" }, provenance: "asked" });
    expect(deriveState(data, null)).toBe("DESTINATION");
    const check = buildMaterializationPlan(data);
    expect(check.ok).toBe(false);
    // After the read-back confirms, the same data materializes.
    const settled = applySlotConfirmation(data, "destination");
    expect(deriveState(settled, null)).toBe("REVIEW");
    expect(buildMaterializationPlan(settled).ok).toBe(true);
  });

  it("a high-confidence voice write settles immediately — no read-back", () => {
    const data = applySlotWrite(markIntent(emptyIntakeData()), {
      slot: "destination",
      value: { kind: "place", text: "Scottsdale" },
      provenance: applyAsrProvenance("stated", { channel: "voice", asrConfidence: 0.97 }),
    });
    expect(data.destination?.provenance).toBe("stated");
    expect(isSlotSettled(data, "destination")).toBe(true);
    expect(nextAsk(data, null)?.key).toBe("party");
  });
});

// ─── Service level (the rule applied at the write seam) ─────────────────────

const store = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name });
  const ops: Array<{ op: string; table: string; values?: unknown; set?: unknown }> = [];
  const selectQueues: Record<string, unknown[][]> = {};

  function makeChain(kind: string, tableName?: string): Record<string, unknown> {
    const ctx = { table: tableName };
    const resolve = (): Promise<unknown> => {
      if (kind === "select") return Promise.resolve(selectQueues[ctx.table ?? ""]?.shift() ?? []);
      return Promise.resolve([]);
    };
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => resolve().then(res, rej),
      catch: (rej: (e: unknown) => unknown) => resolve().catch(rej),
      finally: (fin: () => void) => resolve().finally(fin),
    };
    chain.from = (t: { __table: string }) => {
      ctx.table = t.__table;
      return chain;
    };
    for (const m of ["where", "orderBy", "limit", "returning"]) chain[m] = () => chain;
    chain.values = (v: unknown) => {
      ops.push({ op: "insert", table: ctx.table ?? "", values: v });
      return chain;
    };
    chain.set = (v: unknown) => {
      ops.push({ op: "update", table: ctx.table ?? "", set: v });
      return chain;
    };
    return chain;
  }

  const db = {
    select: vi.fn(() => makeChain("select")),
    insert: vi.fn((t: { __table: string }) => makeChain("insert", t.__table)),
    update: vi.fn((t: { __table: string }) => makeChain("update", t.__table)),
    delete: vi.fn((t: { __table: string }) => makeChain("delete", t.__table)),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { table, ops, selectQueues, db };
});

vi.mock("@workspace/db", () => ({
  db: store.db,
  intakeSessionsTable: store.table("intake_sessions"),
  marcoMessagesTable: store.table("marco_messages"),
  tripParticipantsTable: store.table("trip_participants"),
  tripRosterEntriesTable: store.table("trip_roster_entries"),
  tripsTable: store.table("trips"),
}));

import { applyIntakeSlotWrite, confirmIntakeSlot } from "./intake";

function sessionRow(slots: Record<string, unknown> = { intentCaptured: true }) {
  return {
    id: 5,
    userId: 42,
    state: "DESTINATION",
    slots,
    openItems: [],
    draftTripId: null,
    channel: "voice",
    questionsAsked: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  store.ops.length = 0;
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
});

describe("Intake Service — §2.4 at the write seam", () => {
  it("a low-confidence voice write lands as needs_confirm and the view's next ask is the read-back", async () => {
    store.selectQueues["intake_sessions"] = [[sessionRow()]];
    const view = await applyIntakeSlotWrite(
      5,
      42,
      "traveler",
      { slot: "destination", value: { kind: "place", text: "Scottsdale" }, provenance: "stated" },
      { channel: "voice", asrConfidence: 0.42 },
    );
    expect(view.slots.destination?.provenance).toBe("needs_confirm");
    expect(view.state).toBe("DESTINATION");
    expect(view.nextAsk?.key).toBe("confirm:destination");
    expect(view.nextAsk?.question).toContain("Scottsdale");
    // The persisted row carries the same provenance.
    const update = store.ops.find((o) => o.table === "intake_sessions" && o.op === "update");
    const slots = (update?.set as { slots: { destination: { provenance: string } } }).slots;
    expect(slots.destination.provenance).toBe("needs_confirm");
  });

  it("confirmIntakeSlot settles the read-back and the machine moves on", async () => {
    store.selectQueues["intake_sessions"] = [
      [
        sessionRow({
          intentCaptured: true,
          destination: { value: { kind: "place", text: "Scottsdale" }, provenance: "needs_confirm" },
        }),
      ],
    ];
    const view = await confirmIntakeSlot(5, 42, "traveler", "destination");
    expect(view.slots.destination?.provenance).toBe("stated");
    expect(view.state).toBe("PARTY");
  });

  it("a high-confidence voice write settles normally", async () => {
    store.selectQueues["intake_sessions"] = [[sessionRow()]];
    const view = await applyIntakeSlotWrite(
      5,
      42,
      "traveler",
      { slot: "destination", value: { kind: "place", text: "Scottsdale" }, provenance: "stated" },
      { channel: "voice", asrConfidence: 0.97 },
    );
    expect(view.slots.destination?.provenance).toBe("stated");
    expect(view.state).toBe("PARTY");
  });

  it("a text-channel write is unaffected even if a confidence value rides along", async () => {
    store.selectQueues["intake_sessions"] = [[sessionRow()]];
    const view = await applyIntakeSlotWrite(
      5,
      42,
      "traveler",
      { slot: "destination", value: { kind: "place", text: "Scottsdale" }, provenance: "stated" },
      { channel: "text", asrConfidence: 0.1 },
    );
    expect(view.slots.destination?.provenance).toBe("stated");
    expect(view.state).toBe("PARTY");
  });

  it("a write with no source at all behaves exactly as before (back-compat)", async () => {
    store.selectQueues["intake_sessions"] = [[sessionRow()]];
    const view = await applyIntakeSlotWrite(5, 42, "traveler", {
      slot: "destination",
      value: { kind: "place", text: "Scottsdale" },
      provenance: "stated",
    });
    expect(view.slots.destination?.provenance).toBe("stated");
    expect(view.state).toBe("PARTY");
  });
});
