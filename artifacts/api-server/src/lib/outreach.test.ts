/**
 * Outreach Service — DB-level tests with a recording @workspace/db mock
 * and a mocked mailer (same pattern as intake.test.ts / email.test.ts).
 *
 * SMTP is not configured in this environment, so live sending is
 * unverified here by design: every send goes through the mocked
 * sendEmail, and the tests assert on the exact payloads that WOULD go
 * out — including that no profile field value can appear in any of them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const store = vi.hoisted(() => {
  const table = (name: string) => ({ __table: name });
  const ops: Array<{ op: string; table: string; values?: unknown; set?: unknown }> = [];
  const selectQueues: Record<string, unknown[][]> = {};
  const insertReturns: Record<string, unknown[]> = {};
  const updateReturns: Record<string, unknown[]> = {};

  function makeChain(kind: string, tableName?: string): Record<string, unknown> {
    const ctx = { table: tableName };
    const resolve = (): Promise<unknown> => {
      if (kind === "select") return Promise.resolve(selectQueues[ctx.table ?? ""]?.shift() ?? []);
      if (kind === "insert") return Promise.resolve(insertReturns[ctx.table ?? ""] ?? []);
      if (kind === "update") return Promise.resolve(updateReturns[ctx.table ?? ""] ?? []);
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
    for (const m of ["where", "orderBy", "limit", "returning"]) {
      chain[m] = () => chain;
    }
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
    delete: vi.fn((t: { __table: string }) => {
      ops.push({ op: "delete", table: t.__table });
      return makeChain("delete", t.__table);
    }),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(db)),
  };
  return { table, ops, selectQueues, insertReturns, updateReturns, db };
});

const mailer = vi.hoisted(() => ({
  calls: [] as Array<{ to: string; subject: string; text: string; html: string }>,
  sendEmail: vi.fn(
    async (opts: { to: string; subject: string; text: string; html: string }) => {
      mailer.calls.push(opts);
      return { sent: true };
    },
  ),
}));

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  isNull: (...args: unknown[]) => args,
  inArray: (...args: unknown[]) => args,
}));

vi.mock("@workspace/db", () => ({
  db: store.db,
  travelerInviteTokensTable: store.table("traveler_invite_tokens"),
  tripParticipantsTable: store.table("trip_participants"),
  tripRosterEntriesTable: store.table("trip_roster_entries"),
  tripsTable: store.table("trips"),
  usersTable: store.table("users"),
}));

vi.mock("./email.js", () => ({ sendEmail: mailer.sendEmail }));

import {
  InviteTokenError,
  OutreachAccessDenied,
  ProfileSetupUnavailable,
  applyChaseReminder,
  beginTravelerSetup,
  declineInvite,
  getRosterStatus,
  getShareLink,
  issueInviteToken,
  resendInvite,
  sendRosterInvites,
  setChasePaused,
  submitTravelerProfile,
  validateInviteToken,
} from "./outreach.js";
import { hashInviteToken } from "./outreachLogic.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ORGANIZER = { userId: 42, role: "traveler" }; // trip admin via participant row

const tripRow = {
  id: 7,
  title: "Munich guys' trip",
  destination: "Munich",
  startDate: "2026-09-24",
  endDate: "2026-09-28",
  status: "planning",
};
const organizerUser = { id: 42, name: "Phil", email: "phil@example.com" };
const adminParticipant = { tripId: 7, userId: 42, isTripAdmin: true };

function entryRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 11,
    tripId: 7,
    invitedName: "Kurt",
    invitedEmail: "kurt@example.com",
    userId: null,
    status: "invited",
    requiredFieldsProfile: ["passport_number"],
    missingFields: null,
    chaseState: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function queue(table: string, rows: unknown[]): void {
  (store.selectQueues[table] ??= []).push(rows);
}

/** Queue the standard organizer-access + trip + organizer lookups. */
function queueOrganizerContext(entries: unknown[]): void {
  queue("trip_participants", [adminParticipant]); // assertTripOrganizer
  queue("trips", [tripRow]); // loadTrip
  queue("trip_participants", [adminParticipant]); // loadTripOrganizer
  queue("users", [organizerUser]);
  queue("trip_roster_entries", entries);
}

function tokenInsertValues(): Array<Record<string, unknown>> {
  return store.ops
    .filter((o) => o.op === "insert" && o.table === "traveler_invite_tokens")
    .map((o) => o.values as Record<string, unknown>);
}

function entryUpdates(): Array<Record<string, unknown>> {
  return store.ops
    .filter((o) => o.op === "update" && o.table === "trip_roster_entries")
    .map((o) => o.set as Record<string, unknown>);
}

/** Extract the raw token from a setup URL in an outbound email body. */
function rawTokenFromEmail(text: string): string {
  const m = /traveler-setup\?token=([0-9a-f]+)/.exec(text);
  if (!m) throw new Error("no setup link found in email");
  return m[1];
}

const savedBase = process.env.APP_BASE_URL;

beforeEach(() => {
  store.ops.length = 0;
  mailer.calls.length = 0;
  mailer.sendEmail.mockClear();
  mailer.sendEmail.mockImplementation(
    async (opts: { to: string; subject: string; text: string; html: string }) => {
      mailer.calls.push(opts);
      return { sent: true };
    },
  );
  for (const k of Object.keys(store.selectQueues)) delete store.selectQueues[k];
  for (const k of Object.keys(store.insertReturns)) delete store.insertReturns[k];
  for (const k of Object.keys(store.updateReturns)) delete store.updateReturns[k];
  process.env.APP_BASE_URL = "https://wander.test";
});

afterEach(() => {
  if (savedBase === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = savedBase;
});

// ─── Send gating (Story 4.1) ─────────────────────────────────────────────────

describe("send gating", () => {
  it("reading the roster sends nothing and issues no tokens", async () => {
    queue("trip_participants", [adminParticipant]);
    queue("trip_roster_entries", [entryRow()]);
    const roster = await getRosterStatus(7, 42, "traveler");
    expect(roster).toHaveLength(1);
    expect(mailer.calls).toHaveLength(0);
    expect(tokenInsertValues()).toHaveLength(0);
  });

  it("a non-admin participant cannot send invites — and nothing goes out", async () => {
    queue("trip_participants", []); // organizer check finds no admin row
    await expect(sendRosterInvites(7, 99, "traveler", NOW)).rejects.toBeInstanceOf(
      OutreachAccessDenied,
    );
    expect(mailer.calls).toHaveLength(0);
    expect(tokenInsertValues()).toHaveLength(0);
  });
});

// ─── Invite send (Story 4.1) ─────────────────────────────────────────────────

describe("sendRosterInvites", () => {
  it("sends per-entry invites, stores only token hashes, reports no-email entries, alerts organizer when all delivered", async () => {
    const kurt = entryRow();
    const pradip = entryRow({ id: 12, invitedName: "Pradip", invitedEmail: "pradip@example.com" });
    const noEmail = entryRow({ id: 13, invitedName: "Manish", invitedEmail: null });
    const ready = entryRow({ id: 14, invitedName: "Done", invitedEmail: "done@example.com", status: "ready" });
    queueOrganizerContext([kurt, pradip, noEmail, ready]);

    const summary = await sendRosterInvites(7, 42, "traveler", NOW);

    expect(summary.sent).toEqual([11, 12]);
    expect(summary.needsEmail).toEqual([13]);
    expect(summary.failed).toEqual([]);
    expect(summary.skipped).toEqual([{ entryId: 14, reason: "status_ready" }]);

    // Two invite emails + one all-delivered organizer alert.
    expect(mailer.calls).toHaveLength(3);
    expect(mailer.calls[0].to).toBe("kurt@example.com");
    expect(mailer.calls[2].to).toBe("phil@example.com");
    expect(mailer.calls[2].subject).toContain("All invitations sent");

    // The emailed raw token is never what the DB stores.
    const raw = rawTokenFromEmail(mailer.calls[0].text);
    const inserts = tokenInsertValues();
    expect(inserts).toHaveLength(2);
    expect(inserts[0].tokenHash).toBe(hashInviteToken(raw));
    expect(inserts[0].tokenHash).not.toBe(raw);
    expect(JSON.stringify(inserts)).not.toContain(raw);

    // Entry update: invited, missing initialized from required, first
    // reminder scheduled 3 days out.
    const updates = entryUpdates();
    expect(updates[0].status).toBe("invited");
    expect(updates[0].missingFields).toEqual(["passport_number"]);
    const chase = updates[0].chaseState as Record<string, unknown>;
    expect(chase.invitesSent).toBe(1);
    expect(chase.nextDueAt).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
  });

  it("a failed send flips the entry to needs_attention and alerts the organizer immediately", async () => {
    mailer.sendEmail.mockImplementation(
      async (opts: { to: string; subject: string; text: string; html: string }) => {
        mailer.calls.push(opts);
        return { sent: opts.to === "phil@example.com" }; // traveler send fails, alert succeeds
      },
    );
    queueOrganizerContext([entryRow()]);

    const summary = await sendRosterInvites(7, 42, "traveler", NOW);

    expect(summary.sent).toEqual([]);
    expect(summary.failed).toEqual([{ entryId: 11, reason: "email_send_failed" }]);

    const updates = entryUpdates();
    expect(updates[0].status).toBe("needs_attention");
    const chase = updates[0].chaseState as Record<string, unknown>;
    expect((chase.lastFailure as Record<string, unknown>).reason).toBe("email_send_failed");

    // Immediate organizer alert, and NO all-delivered email.
    expect(mailer.calls).toHaveLength(2);
    expect(mailer.calls[1].to).toBe("phil@example.com");
    expect(mailer.calls[1].subject).toContain("Invitation problem");
    expect(mailer.calls.some((c) => c.subject.includes("All invitations sent"))).toBe(false);
  });

  it("without APP_BASE_URL the send fails closed as setup_link_unavailable", async () => {
    delete process.env.APP_BASE_URL;
    delete process.env.REPLIT_DEV_DOMAIN;
    queueOrganizerContext([entryRow()]);

    const summary = await sendRosterInvites(7, 42, "traveler", NOW);

    expect(summary.failed).toEqual([{ entryId: 11, reason: "setup_link_unavailable" }]);
    expect(entryUpdates()[0].status).toBe("needs_attention");
    expect(tokenInsertValues()).toHaveLength(0); // no token minted for a link we can't build
  });
});

// ─── Token lifecycle (§3.4) ──────────────────────────────────────────────────

describe("token lifecycle", () => {
  it("issue → validate round-trips; only the hash is stored", async () => {
    const { rawToken, expiresAt } = await issueInviteToken(11, NOW);
    expect(expiresAt.getTime()).toBe(NOW.getTime() + 14 * DAY);
    const inserts = tokenInsertValues();
    expect(inserts[0].tokenHash).toBe(hashInviteToken(rawToken));
    expect(JSON.stringify(inserts)).not.toContain(rawToken);

    queue("traveler_invite_tokens", [
      { id: 5, rosterEntryId: 11, tokenHash: hashInviteToken(rawToken), expiresAt, usedAt: null, createdAt: NOW },
    ]);
    queue("trip_roster_entries", [entryRow()]);
    const valid = await validateInviteToken(rawToken, NOW);
    expect(valid.entry.id).toBe(11);
  });

  it("reissue deletes prior unused tokens, invalidating the old link", async () => {
    await issueInviteToken(11, NOW);
    await issueInviteToken(11, NOW);
    const deletes = store.ops.filter(
      (o) => o.op === "delete" && o.table === "traveler_invite_tokens",
    );
    expect(deletes).toHaveLength(2); // one per issuance

    queue("traveler_invite_tokens", []); // old hash no longer resolves
    await expect(validateInviteToken("0".repeat(64), NOW)).rejects.toMatchObject({
      name: "InviteTokenError",
      reason: "invalid",
    });
  });

  it("expired and used tokens are rejected with distinct reasons", async () => {
    const expiredRow = {
      id: 5, rosterEntryId: 11, tokenHash: "x",
      expiresAt: new Date(NOW.getTime() - DAY), usedAt: null, createdAt: NOW,
    };
    queue("traveler_invite_tokens", [expiredRow]);
    await expect(validateInviteToken("raw", NOW)).rejects.toMatchObject({
      name: "InviteTokenError",
      reason: "expired",
    });

    const usedRow = { ...expiredRow, expiresAt: new Date(NOW.getTime() + DAY), usedAt: NOW };
    queue("traveler_invite_tokens", [usedRow]);
    await expect(validateInviteToken("raw", NOW)).rejects.toMatchObject({
      name: "InviteTokenError",
      reason: "used",
    });
  });
});

// ─── Traveler setup seam (Story 4.3) ─────────────────────────────────────────

describe("traveler setup seam", () => {
  const tokenRow = {
    id: 5, rosterEntryId: 11, tokenHash: "x",
    expiresAt: new Date(NOW.getTime() + DAY), usedAt: null, createdAt: NOW,
  };

  function queueValidToken(entry: Record<string, unknown> = entryRow()): void {
    queue("traveler_invite_tokens", [tokenRow]);
    queue("trip_roster_entries", [entry]);
    queue("trips", [tripRow]);
    queue("trip_participants", [adminParticipant]);
    queue("users", [organizerUser]);
  }

  it("begin: validates, moves entry to setting_up, states privacy first, does NOT consume the token", async () => {
    queueValidToken();
    const ctx = await beginTravelerSetup("raw-token", NOW);
    expect(ctx.travelerName).toBe("Kurt");
    expect(ctx.trip.title).toBe("Munich guys' trip");
    expect(ctx.status).toBe("setting_up");
    expect(ctx.privacyNotice).toContain("never the details themselves");
    expect(ctx.requiredFields).toEqual([
      { name: "passport_number", label: "your passport details" },
    ]);
    expect(ctx.profileSetupAvailable).toBe(false);

    const updates = entryUpdates();
    expect(updates).toHaveLength(1);
    expect(updates[0].status).toBe("setting_up");
    // Token untouched: no update against the tokens table at all.
    expect(
      store.ops.filter((o) => o.op === "update" && o.table === "traveler_invite_tokens"),
    ).toHaveLength(0);
  });

  it("submit: rejects as unavailable, consumes nothing, stores nothing", async () => {
    queue("traveler_invite_tokens", [tokenRow]);
    queue("trip_roster_entries", [entryRow()]);
    await expect(submitTravelerProfile("raw-token", NOW)).rejects.toBeInstanceOf(
      ProfileSetupUnavailable,
    );
    // No writes of any kind beyond the validation reads.
    expect(store.ops.filter((o) => o.op !== "select")).toHaveLength(0);
  });

  it("decline: consumes the token, marks declined, stops the chase clock", async () => {
    queue("traveler_invite_tokens", [tokenRow]);
    queue("trip_roster_entries", [
      entryRow({ chaseState: { invitesSent: 1, nextDueAt: NOW.toISOString() } }),
    ]);
    const result = await declineInvite("raw-token", NOW);
    expect(result).toEqual({ status: "declined" });

    const tokenUpdates = store.ops.filter(
      (o) => o.op === "update" && o.table === "traveler_invite_tokens",
    );
    expect(tokenUpdates).toHaveLength(1);
    expect((tokenUpdates[0].set as Record<string, unknown>).usedAt).toEqual(NOW);

    const updates = entryUpdates();
    expect(updates[0].status).toBe("declined");
    expect((updates[0].chaseState as Record<string, unknown>).nextDueAt).toBeNull();
  });

  it("an invalid token never reaches the trip or entry", async () => {
    queue("traveler_invite_tokens", []);
    await expect(beginTravelerSetup("bogus", NOW)).rejects.toBeInstanceOf(InviteTokenError);
    expect(store.ops.filter((o) => o.op !== "select")).toHaveLength(0);
  });
});

// ─── Organizer controls ──────────────────────────────────────────────────────

describe("organizer controls", () => {
  it("resend to a needs_attention entry recovers it to invited on success", async () => {
    queue("trip_roster_entries", [entryRow({ status: "needs_attention" })]); // loadEntry
    queue("trip_participants", [adminParticipant]); // assertTripOrganizer
    queue("trips", [tripRow]);
    queue("trip_participants", [adminParticipant]); // loadTripOrganizer
    queue("users", [organizerUser]);

    const outcome = await resendInvite(11, 42, "traveler", NOW);
    expect(outcome).toEqual({ entryId: 11, outcome: "sent" });
    expect(entryUpdates()[0].status).toBe("invited");
    expect(mailer.calls[0].to).toBe("kurt@example.com");
  });

  it("share link returns a working URL whose raw token is stored only as a hash", async () => {
    queue("trip_roster_entries", [entryRow({ invitedEmail: null })]);
    queue("trip_participants", [adminParticipant]);
    const link = await getShareLink(11, 42, "traveler", NOW);
    expect(link.url).toContain("https://wander.test/traveler-setup?token=");
    const raw = rawTokenFromEmail(`x ${link.url}`);
    expect(tokenInsertValues()[0].tokenHash).toBe(hashInviteToken(raw));
  });

  it("pause/resume flips the chase flag and returns the projection", async () => {
    queue("trip_roster_entries", [entryRow()]);
    queue("trip_participants", [adminParticipant]);
    const view = await setChasePaused(11, 42, "traveler", true);
    expect(view.chase.paused).toBe(true);
    expect((entryUpdates()[0].chaseState as Record<string, unknown>).paused).toBe(true);
  });
});

// ─── Chase execution (Story 4.2) ─────────────────────────────────────────────

describe("applyChaseReminder", () => {
  it("sends a fresh-link reminder naming missing items in general terms — and no field value anywhere", async () => {
    const entry = entryRow({
      missingFields: ["passport_number"],
      chaseState: {
        invitesSent: 1, remindersSent: 0, paused: false,
        nextDueAt: NOW.toISOString(), escalatedAt: null,
        lastInviteSentAt: NOW.toISOString(), lastReminderSentAt: null, lastFailure: null,
      },
    }) as never;
    const outcome = await applyChaseReminder(
      entry,
      tripRow as never,
      { userId: 42, name: "Phil", email: "phil@example.com" },
      NOW,
    );
    expect(outcome).toBe("sent");
    expect(mailer.calls).toHaveLength(1);
    const body = `${mailer.calls[0].subject}\n${mailer.calls[0].text}\n${mailer.calls[0].html}`;
    expect(body).toContain("your passport details");
    expect(body).not.toContain("passport_number");
    // Sentinel check: no plausible field VALUE appears in any outbound payload.
    expect(body).not.toContain("XUK1234567");

    const chase = entryUpdates()[0].chaseState as Record<string, unknown>;
    expect(chase.remindersSent).toBe(1);
    expect(chase.nextDueAt).toBe(new Date(NOW.getTime() + 4 * DAY).toISOString());
  });

  it("a failed reminder marks needs_attention and alerts the organizer", async () => {
    mailer.sendEmail.mockImplementation(
      async (opts: { to: string; subject: string; text: string; html: string }) => {
        mailer.calls.push(opts);
        return { sent: opts.to === "phil@example.com" };
      },
    );
    const entry = entryRow({
      missingFields: ["passport_number"],
      chaseState: { invitesSent: 1, remindersSent: 1, nextDueAt: NOW.toISOString() },
    }) as never;
    const outcome = await applyChaseReminder(
      entry,
      tripRow as never,
      { userId: 42, name: "Phil", email: "phil@example.com" },
      NOW,
    );
    expect(outcome).toBe("failed");
    expect(entryUpdates()[0].status).toBe("needs_attention");
    expect(mailer.calls[1].subject).toContain("Invitation problem");
  });
});
