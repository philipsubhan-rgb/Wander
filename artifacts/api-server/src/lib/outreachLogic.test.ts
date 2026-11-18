/**
 * Outreach pure-logic tests: token math, the chase decision matrix and
 * its hard caps, email copy invariants (privacy statement BEFORE the
 * link; general-terms labels, never internal field names or values),
 * and the organizer status projection shape.
 */

import { describe, it, expect } from "vitest";
import {
  OUTREACH_CONFIG,
  buildInviteEmail,
  buildOrganizerAlertEmail,
  buildReminderEmail,
  buildSetupUrl,
  chaseStateAfterEscalation,
  chaseStateAfterInvite,
  chaseStateAfterReminder,
  decideChaseAction,
  emptyChaseState,
  fieldLabel,
  fieldLabels,
  generateInviteToken,
  hashInviteToken,
  inviteTokenExpiry,
  isInviteTokenUsable,
  parseChaseState,
  projectRosterEntryForOrganizer,
  type ChaseState,
} from "./outreachLogic.js";

const NOW = new Date("2026-11-18T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

describe("OUTREACH_CONFIG", () => {
  it("is a single config object with day-scale cadence and a reminder cap", () => {
    expect(OUTREACH_CONFIG.tokenTtlDays).toBeGreaterThanOrEqual(7); // days, not hours
    expect(OUTREACH_CONFIG.chase.firstReminderAfterDays).toBe(3);
    expect(OUTREACH_CONFIG.chase.reminderIntervalDays).toBe(4);
    expect(OUTREACH_CONFIG.chase.maxReminders).toBe(3);
  });
});

describe("invite tokens", () => {
  it("generates unique raw tokens and stores only their SHA-256 hash", () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).not.toBe(b);
    const hash = hashInviteToken(a);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe(a);
    expect(hash).not.toContain(a);
  });

  it("expiry is tokenTtlDays out", () => {
    expect(inviteTokenExpiry(NOW).getTime()).toBe(
      NOW.getTime() + OUTREACH_CONFIG.tokenTtlDays * DAY,
    );
  });

  it("usability: unused + unexpired only", () => {
    const future = new Date(NOW.getTime() + DAY);
    const past = new Date(NOW.getTime() - DAY);
    expect(isInviteTokenUsable({ usedAt: null, expiresAt: future }, NOW)).toBe(true);
    expect(isInviteTokenUsable({ usedAt: NOW, expiresAt: future }, NOW)).toBe(false);
    expect(isInviteTokenUsable({ usedAt: null, expiresAt: past }, NOW)).toBe(false);
  });

  it("builds the setup URL on the trusted base", () => {
    expect(buildSetupUrl("https://wander.test/", "abc123")).toBe(
      "https://wander.test/traveler-setup?token=abc123",
    );
  });
});

describe("chase state transitions", () => {
  it("invite schedules the first reminder firstReminderAfterDays out", () => {
    const next = chaseStateAfterInvite(emptyChaseState(), NOW);
    expect(next.invitesSent).toBe(1);
    expect(next.nextDueAt).toBe(new Date(NOW.getTime() + 3 * DAY).toISOString());
    expect(next.lastFailure).toBeNull();
  });

  it("reminder advances nextDueAt by a FULL interval (the per-interval cap)", () => {
    const state: ChaseState = {
      ...emptyChaseState(),
      invitesSent: 1,
      nextDueAt: NOW.toISOString(),
    };
    const next = chaseStateAfterReminder(state, NOW);
    expect(next.remindersSent).toBe(1);
    expect(Date.parse(next.nextDueAt!)).toBe(NOW.getTime() + 4 * DAY);
  });

  it("escalation stops the clock", () => {
    const next = chaseStateAfterEscalation(
      { ...emptyChaseState(), invitesSent: 1, nextDueAt: NOW.toISOString() },
      NOW,
    );
    expect(next.escalatedAt).toBe(NOW.toISOString());
    expect(next.nextDueAt).toBeNull();
  });

  it("parseChaseState degrades unknown shapes to empty", () => {
    expect(parseChaseState(null)).toEqual(emptyChaseState());
    expect(parseChaseState("junk")).toEqual(emptyChaseState());
    expect(parseChaseState({ paused: true, remindersSent: 2 }).paused).toBe(true);
    expect(parseChaseState({ paused: true, remindersSent: 2 }).remindersSent).toBe(2);
  });
});

describe("decideChaseAction", () => {
  const base = {
    status: "invited",
    missingFields: ["passport_number"],
    chaseState: {
      ...emptyChaseState(),
      invitesSent: 1,
      nextDueAt: new Date(NOW.getTime() - DAY).toISOString(), // due yesterday
    },
    tripStartDate: "2027-06-01", // far away — no deadline pressure
    now: NOW,
  };

  it("reminds when due with reminders left", () => {
    expect(decideChaseAction(base)).toEqual({ action: "remind" });
  });

  it("does nothing before the due time", () => {
    const s = { ...base.chaseState, nextDueAt: new Date(NOW.getTime() + DAY).toISOString() };
    expect(decideChaseAction({ ...base, chaseState: s })).toEqual({
      action: "none",
      reason: "not_due",
    });
  });

  it("escalates when reminders are exhausted", () => {
    const s = { ...base.chaseState, remindersSent: OUTREACH_CONFIG.chase.maxReminders };
    expect(decideChaseAction({ ...base, chaseState: s })).toEqual({
      action: "escalate",
      reason: "reminders_exhausted",
    });
  });

  it("escalates on an approaching deadline even between reminders", () => {
    const s = { ...base.chaseState, nextDueAt: new Date(NOW.getTime() + 2 * DAY).toISOString() };
    expect(
      decideChaseAction({ ...base, chaseState: s, tripStartDate: "2026-11-24" }),
    ).toEqual({ action: "escalate", reason: "deadline_approaching" });
  });

  it("never chases: paused, complete, terminal, escalated, or unsent entries", () => {
    expect(
      decideChaseAction({ ...base, chaseState: { ...base.chaseState, paused: true } }).action,
    ).toBe("none");
    expect(decideChaseAction({ ...base, missingFields: [] }).action).toBe("none");
    expect(decideChaseAction({ ...base, missingFields: null }).action).toBe("none");
    expect(decideChaseAction({ ...base, status: "ready" }).action).toBe("none");
    expect(decideChaseAction({ ...base, status: "declined" }).action).toBe("none");
    expect(decideChaseAction({ ...base, status: "needs_attention" }).action).toBe("none");
    expect(
      decideChaseAction({
        ...base,
        chaseState: { ...base.chaseState, escalatedAt: NOW.toISOString() },
      }).action,
    ).toBe("none");
    expect(
      decideChaseAction({
        ...base,
        chaseState: { ...emptyChaseState() }, // no invite sent yet
      }),
    ).toEqual({ action: "none", reason: "not_scheduled" });
  });
});

describe("field labels — general terms, never internal names or values", () => {
  it("maps known fields to traveler language", () => {
    expect(fieldLabel("passport_number")).toBe("your passport details");
    expect(fieldLabel("date_of_birth")).toBe("your date of birth");
    expect(fieldLabels(["passport_number", "phone"])).toEqual([
      "your passport details",
      "your phone number",
    ]);
  });

  it("humanizes unknown fields", () => {
    expect(fieldLabel("travel_insurance_policy")).toBe("your travel insurance policy");
  });
});

describe("email copy", () => {
  const invite = buildInviteEmail({
    travelerName: "Kurt",
    organizerName: "Phil",
    tripTitle: "Munich guys' trip",
    destination: "Munich",
    startDate: "2026-09-24",
    endDate: "2026-09-28",
    requiredFieldLabels: fieldLabels(["passport_number", "date_of_birth"]),
    setupUrl: "https://wander.test/traveler-setup?token=deadbeef",
  });

  it("invite: privacy statement comes BEFORE the link, in text and html", () => {
    const privacy = "can only see whether your details are complete";
    expect(invite.text.indexOf(privacy)).toBeGreaterThan(-1);
    expect(invite.text.indexOf(privacy)).toBeLessThan(invite.text.indexOf("https://wander.test"));
    expect(invite.html.indexOf(privacy)).toBeGreaterThan(-1);
    expect(invite.html.indexOf(privacy)).toBeLessThan(invite.html.indexOf("https://wander.test"));
  });

  it("invite: names organizer, trip, dates, and what will be asked — in general terms", () => {
    expect(invite.subject).toContain("Phil");
    expect(invite.text).toContain("Munich guys' trip");
    expect(invite.text).toContain("Sep 24, 2026");
    expect(invite.text).toContain("your passport details");
    expect(invite.text).not.toContain("passport_number"); // internal name never leaks
  });

  it("reminder: names missing items generally and promises to stop", () => {
    const reminder = buildReminderEmail({
      travelerName: "Pradip",
      organizerName: "Phil",
      tripTitle: "Munich guys' trip",
      missingLabels: fieldLabels(["passport_number"]),
      setupUrl: "https://wander.test/traveler-setup?token=cafe",
    });
    expect(reminder.text).toContain("we still need your passport details");
    expect(reminder.text).toContain("Reminders stop the moment");
    expect(reminder.text).not.toContain("passport_number");
  });

  it("organizer alerts carry status only — names, labels, reason classes", () => {
    const failed = buildOrganizerAlertEmail({
      kind: "send_failed",
      organizerName: "Phil",
      tripTitle: "Munich guys' trip",
      travelerName: "Kurt",
      travelerEmail: "kurt@example.com",
      reason: "email_send_failed",
    });
    expect(failed.text).toContain("needs attention");
    expect(failed.text).toContain("the email could not be sent");

    const escalation = buildOrganizerAlertEmail({
      kind: "escalation",
      organizerName: "Phil",
      tripTitle: "Munich guys' trip",
      startDate: "2026-11-24",
      reason: "deadline_approaching",
      pending: [{ name: "Kurt", missingLabels: ["your passport details"] }],
    });
    expect(escalation.text).toContain("Kurt: still needs your passport details");
    expect(escalation.text).toContain("Nov 24, 2026");

    const delivered = buildOrganizerAlertEmail({
      kind: "all_delivered",
      organizerName: "Phil",
      tripTitle: "Munich guys' trip",
      travelerNames: ["Kurt", "Pradip"],
    });
    expect(delivered.text).toContain("all 2 invitation(s)");
  });
});

describe("organizer roster projection", () => {
  it("exposes exactly the status shape — names, status, missing NAMES, chase summary", () => {
    const view = projectRosterEntryForOrganizer({
      id: 9,
      tripId: 7,
      invitedName: "Kurt",
      invitedEmail: "kurt@example.com",
      userId: null,
      status: "invited",
      requiredFieldsProfile: ["passport_number"],
      missingFields: ["passport_number"],
      chaseState: {
        invitesSent: 1,
        remindersSent: 0,
        paused: false,
        nextDueAt: "2026-11-21T12:00:00.000Z",
        escalatedAt: null,
        lastInviteSentAt: "2026-11-18T12:00:00.000Z",
        lastReminderSentAt: null,
        lastFailure: null,
      },
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    expect(Object.keys(view).sort()).toEqual(
      ["chase", "hasLinkedAccount", "id", "invitedEmail", "invitedName", "missingFields", "status", "tripId"].sort(),
    );
    expect(view.missingFields).toEqual(["passport_number"]);
    expect(view.chase.invitesSent).toBe(1);
    expect(view.hasLinkedAccount).toBe(false);
    // No profile-shaped key can appear in the projection.
    expect(JSON.stringify(view)).not.toContain("passportNumber");
  });
});
