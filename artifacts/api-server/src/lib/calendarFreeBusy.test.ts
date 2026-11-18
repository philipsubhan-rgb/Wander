/**
 * Calendar free/busy read (context rung 2, §4.1) — service tests with
 * injected deps. The privacy contract under test: the result is a
 * boolean + a count. Busy interval times never appear in the result,
 * and no code path here can produce event content (the freebusy API
 * returns intervals only; the service discards them after counting).
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./credentialCrypto", () => ({
  decryptToken: (s: string) => s,
  encryptToken: (s: string) => s,
}));

// The service's DEFAULT account loader reads @workspace/db (which
// throws at import without a database); every test here injects its
// loader, so a stub module suffices.
vi.mock("@workspace/db", () => ({
  db: { select: vi.fn() },
  connectedAccountsTable: { __table: "connected_accounts" },
}));

import {
  checkFreeBusyForDates,
  clearFreeBusyCacheForTests,
  hasFreeBusyAccount,
  type FreeBusyDeps,
} from "./calendarFreeBusy";

const SENTINEL_START = "2027-03-11T15:00:00.000Z";
const SENTINEL_END = "2027-03-11T16:30:00.000Z";

function account(scopes: string) {
  return {
    id: 7,
    userId: 42,
    provider: "google",
    encryptedRefreshToken: "refresh-token",
    scopes,
  } as never;
}

function deps(overrides: Partial<FreeBusyDeps> = {}): FreeBusyDeps & {
  queryBusy: ReturnType<typeof vi.fn>;
} {
  return {
    loadAccounts: async () => [account("gmail.readonly calendar.freebusy")],
    getClient: async () => ({}) as never,
    queryBusy: vi.fn(async () => ({
      primary: [{ start: SENTINEL_START, end: SENTINEL_END }],
    })),
    ...overrides,
  } as never;
}

beforeEach(() => {
  clearFreeBusyCacheForTests();
});

describe("checkFreeBusyForDates", () => {
  it("flags a collision: a busy block inside the proposed window", async () => {
    const result = await checkFreeBusyForDates(42, "2027-03-10", "2027-03-14", deps());
    expect(result).toEqual({ connected: true, conflict: true, busyCount: 1 });
  });

  it("no collision when the busy blocks fall outside the window", async () => {
    const result = await checkFreeBusyForDates(
      42,
      "2027-03-10",
      "2027-03-14",
      deps({
        queryBusy: vi.fn(async () => ({
          primary: [{ start: "2027-04-01T15:00:00.000Z", end: "2027-04-01T16:00:00.000Z" }],
        })),
      }),
    );
    expect(result).toEqual({ connected: true, conflict: false, busyCount: 0 });
  });

  it("half-open boundaries: a block ending at the window start (or starting at its end) is not a collision", async () => {
    const result = await checkFreeBusyForDates(
      42,
      "2027-03-10",
      "2027-03-14",
      deps({
        queryBusy: vi.fn(async () => ({
          primary: [
            { start: "2027-03-09T23:00:00.000Z", end: "2027-03-10T00:00:00.000Z" },
            { start: "2027-03-15T00:00:00.000Z", end: "2027-03-15T01:00:00.000Z" },
          ],
        })),
      }),
    );
    expect(result.conflict).toBe(false);
    expect(result.busyCount).toBe(0);
  });

  it("CONTENT-LEAK SCAN: the result carries no interval times and no other fields", async () => {
    const result = await checkFreeBusyForDates(42, "2027-03-10", "2027-03-14", deps());
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SENTINEL_START);
    expect(serialized).not.toContain(SENTINEL_END);
    expect(serialized).not.toContain("2027-03-11");
    expect(Object.keys(result).sort()).toEqual(["busyCount", "conflict", "connected"]);
  });

  it("no connected account → not connected, DATES proceeds as today", async () => {
    const result = await checkFreeBusyForDates(
      42,
      "2027-03-10",
      "2027-03-14",
      deps({ loadAccounts: async () => [] }),
    );
    expect(result).toEqual({ connected: false, conflict: false, busyCount: 0 });
  });

  it("an account without any calendar grant does not count as connected", async () => {
    const result = await checkFreeBusyForDates(
      42,
      "2027-03-10",
      "2027-03-14",
      deps({ loadAccounts: async () => [account("gmail.readonly")] }),
    );
    expect(result.connected).toBe(false);
  });

  it("the write-back grant (calendar.events) alone authorizes the read — no new consent needed", async () => {
    const d = deps({ loadAccounts: async () => [account("gmail.readonly calendar.events")] });
    const result = await checkFreeBusyForDates(42, "2027-03-10", "2027-03-14", d);
    expect(result.connected).toBe(true);
    expect(result.conflict).toBe(true);
    expect(d.queryBusy).toHaveBeenCalledTimes(1);
  });

  it("queries the primary calendar over the full days, end-exclusive", async () => {
    const d = deps();
    await checkFreeBusyForDates(42, "2027-03-10", "2027-03-14", d);
    const [, calendarIds, timeMin, timeMax] = d.queryBusy.mock.calls[0];
    expect(calendarIds).toEqual(["primary"]);
    expect(timeMin).toBe("2027-03-10T00:00:00.000Z");
    expect(timeMax).toBe("2027-03-15T00:00:00.000Z");
  });

  it("ADR-11 caching: a repeat check inside the TTL does not re-query; a new window does", async () => {
    const d = deps();
    await checkFreeBusyForDates(42, "2027-03-10", "2027-03-14", d);
    await checkFreeBusyForDates(42, "2027-03-10", "2027-03-14", d);
    expect(d.queryBusy).toHaveBeenCalledTimes(1);
    await checkFreeBusyForDates(42, "2027-03-12", "2027-03-14", d);
    expect(d.queryBusy).toHaveBeenCalledTimes(2);
  });

  it("a provider failure reads as no data — never a fabricated conflict, never a throw", async () => {
    const result = await checkFreeBusyForDates(
      42,
      "2027-03-10",
      "2027-03-14",
      deps({
        queryBusy: vi.fn(async () => {
          throw new Error("google is down");
        }),
      }),
    );
    expect(result).toEqual({ connected: false, conflict: false, busyCount: 0 });
  });
});

describe("hasFreeBusyAccount (the snapshot fact)", () => {
  it("true for a freebusy-capable grant, false otherwise", async () => {
    expect(
      await hasFreeBusyAccount(42, { loadAccounts: async () => [account("calendar.events")] }),
    ).toBe(true);
    expect(
      await hasFreeBusyAccount(42, { loadAccounts: async () => [account("gmail.readonly")] }),
    ).toBe(false);
    expect(await hasFreeBusyAccount(42, { loadAccounts: async () => [] })).toBe(false);
  });
});
