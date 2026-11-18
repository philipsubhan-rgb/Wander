/**
 * call_* Marco tools — the façade over the ConciergeCallService.
 *
 * Asserts the tool inventory is exactly the five call tools, that no
 * tool parameter can carry personal or card data (identity comes
 * from the ToolContext; names come from the vault inside the
 * service), that place-call surfaces the service's confirmed-brief
 * discipline, and that virtual-card details returned to the live
 * session are STRIPPED from tool results.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// The tools' module graph reaches @workspace/db, whose real index
// throws without DATABASE_URL. The façade is exercised against an
// injected fake service, so a structural stub is all the graph
// needs (the same approach as agentBookingTools.test.ts).
vi.mock("@workspace/db", () => {
  const table = (name: string) => ({ __table: name });
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  for (const m of ["from", "where", "orderBy", "limit", "offset", "innerJoin", "leftJoin", "groupBy", "set", "values", "returning", "onConflictDoNothing", "onConflictDoUpdate"]) {
    chain[m] = self;
  }
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve([]).then(resolve);
  const db = {
    select: () => chain,
    insert: () => chain,
    update: () => chain,
    delete: () => chain,
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
  };
  return {
    db,
    callBriefsTable: table("call_briefs"),
    callTasksTable: table("call_tasks"),
    bookingsTable: table("bookings"),
    bookingTravelersTable: table("booking_travelers"),
    bookingSplitsTable: table("booking_splits"),
    commissionRecordsTable: table("commission_records"),
    reservationsTable: table("reservations"),
    tripsTable: table("trips"),
    tripParticipantsTable: table("trip_participants"),
    extrasSuggestionsTable: table("extras_suggestions"),
    bookingAttemptsTable: table("booking_attempts"),
    bookingAttemptTravelersTable: table("booking_attempt_travelers"),
    usersTable: table("users"),
    travelerProfilesTable: table("traveler_profiles"),
    profileAccessLogTable: table("profile_access_log"),
    tripRosterEntriesTable: table("trip_roster_entries"),
    connectedAccountsTable: table("connected_accounts"),
    calendarEventLinksTable: table("calendar_event_links"),
  };
});

vi.mock("drizzle-orm", () => {
  const op =
    (name: string) =>
    (...args: unknown[]) => ({ __op: name, args });
  return {
    and: op("and"), or: op("or"), eq: op("eq"), ne: op("ne"), gt: op("gt"),
    gte: op("gte"), lt: op("lt"), lte: op("lte"), inArray: op("inArray"),
    notInArray: op("notInArray"), isNull: op("isNull"), isNotNull: op("isNotNull"),
    asc: op("asc"), desc: op("desc"), sql: op("sql"),
  };
});

import { CALL_TOOLS, getCallToolDefinition } from "./agentCallTools";
import { setDefaultConciergeCallServiceForTests } from "./conciergeCalls";
import type { ToolContext } from "./agentTools";

const CTX: ToolContext = { userId: 7, role: "user" };

afterEach(() => {
  setDefaultConciergeCallServiceForTests(null);
});

describe("tool inventory", () => {
  it("is exactly the five call tools", () => {
    expect(CALL_TOOLS.map((t) => t.name).sort()).toEqual([
      "call_confirm_brief",
      "call_place",
      "call_prepare_brief",
      "call_present_brief",
      "call_status",
    ]);
    for (const t of CALL_TOOLS) expect(getCallToolDefinition(t.name)).toBe(t);
    expect(getCallToolDefinition("call_me_maybe")).toBeUndefined();
  });

  it("no tool parameter can carry personal details or card data", () => {
    for (const tool of CALL_TOOLS) {
      const schema = JSON.stringify(tool.parameters).toLowerCase();
      for (const banned of ["passport", "legalfirstname", "legallastname", "dateofbirth", "pan", "cvc", "cardnumber", "card_number"]) {
        expect(schema, `${tool.name} must not accept ${banned}`).not.toContain(banned);
      }
    }
  });
});

describe("call_place through the façade", () => {
  it("an unconfirmed brief's refusal is surfaced verbatim and nothing dials", async () => {
    const placeCall = vi.fn(async () => ({
      placed: false as const,
      reason: "Call brief #11 hasn't been confirmed yet — a call that can commit money is placed only against a confirmed brief.",
    }));
    setDefaultConciergeCallServiceForTests({
      placeCall,
    } as never);
    const tool = getCallToolDefinition("call_place")!;
    const result = await tool.run(CTX, { briefId: 11 } as never);
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/hasn't been confirmed/);
    expect(placeCall).toHaveBeenCalledTimes(1);
  });

  it("a placed call's result NEVER contains the virtual card's details", async () => {
    const placeCall = vi.fn(async () => ({
      placed: true as const,
      task: { id: 21, briefId: 11, attemptNumber: 1, state: "calling" },
      cardDetails: {
        instrumentRef: "vi_test_ref_1",
        pan: "SENTINELPAN4111111111",
        expiryMonth: 12,
        expiryYear: 2027,
        cvc: "SENTINELCVC",
        brand: "visa",
        limit: { amountMinor: 21_000, currency: "USD" },
      },
    }));
    setDefaultConciergeCallServiceForTests({ placeCall } as never);
    const tool = getCallToolDefinition("call_place")!;
    const result = await tool.run(CTX, { briefId: 11 } as never);
    expect(result.ok).toBe(true);
    expect(result.text).toMatch(/single-use virtual card/);
    const everything = JSON.stringify(result);
    expect(everything).not.toContain("SENTINELPAN");
    expect(everything).not.toContain("SENTINELCVC");
    expect(everything).not.toContain("vi_test_ref_1");
  });
});

describe("call_confirm_brief through the façade", () => {
  it("passes the channel through so the service can enforce the voice rule", async () => {
    const confirmBrief = vi.fn(async () => ({
      confirmed: false as const,
      reason: "A call brief that authorizes spending can't be confirmed by voice alone.",
      brief: { id: 11 },
    }));
    setDefaultConciergeCallServiceForTests({ confirmBrief } as never);
    const tool = getCallToolDefinition("call_confirm_brief")!;
    const result = await tool.run({ ...CTX, channel: "voice" }, { briefId: 11 } as never);
    expect(result.text).toMatch(/Not confirmed/);
    const actor = (confirmBrief.mock.calls[0] as unknown[])[1] as { channel?: string };
    expect(actor.channel).toBe("voice");
  });
});
