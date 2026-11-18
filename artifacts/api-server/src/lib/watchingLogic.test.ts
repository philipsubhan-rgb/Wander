/**
 * Watching pipeline — pure logic tests. Dedupe, materiality thresholds
 * (international §4.2 defaults), worsening, and the impact walk over
 * timeline events: connection risk, check-in risk, named reservations,
 * group coherence — plus the "unaffected trip stays silent" control.
 */

import { describe, it, expect } from "vitest";
import type { FlightStatusSnapshot } from "@workspace/db";
import type { TimelineEvent } from "./timeline.js";
import {
  WATCHING_CONFIG,
  buildAdvisoryEmail,
  buildImpactSummary,
  detectChanges,
  isWorseThan,
  runImpactWalk,
  snapshotsEqual,
  wallClockToUtcMs,
  type WatchFlightContext,
} from "./watchingLogic.js";

const FLIGHT: WatchFlightContext = {
  label: "UA30",
  route: "EWR → MUC",
  originTimezone: "America/New_York",
  destinationTimezone: "Europe/Berlin",
  bookedDepartureMs: Date.UTC(2026, 8, 23, 21, 0), // 17:00 EDT
  bookedArrivalMs: Date.UTC(2026, 8, 24, 5, 10), // 07:10 CEST
};

function snap(overrides: Partial<FlightStatusSnapshot> = {}): FlightStatusSnapshot {
  return {
    faFlightId: "UAL30-1",
    status: "Scheduled / On Time",
    cancelled: false,
    diverted: false,
    scheduledOut: "2026-09-23T21:00:00Z",
    estimatedOut: "2026-09-23T21:00:00Z",
    actualOut: null,
    scheduledIn: "2026-09-24T05:10:00Z",
    estimatedIn: "2026-09-24T05:10:00Z",
    actualIn: null,
    gateOrigin: "C120",
    gateDestination: null,
    terminalOrigin: "C",
    terminalDestination: null,
    arrivalDelayMinutes: 0,
    departureDelayMinutes: 0,
    source: "alert",
    observedAt: "2026-09-20T12:00:00Z",
    ...overrides,
  };
}

const NOW = new Date("2026-09-20T12:00:00Z");
const THRESHOLDS = WATCHING_CONFIG.thresholds;

describe("wallClockToUtcMs", () => {
  it("converts airport-local wall clock using the zone (DST-aware)", () => {
    expect(wallClockToUtcMs("2026-09-23T17:00", "America/New_York")).toBe(Date.UTC(2026, 8, 23, 21, 0)); // EDT
    expect(wallClockToUtcMs("2026-12-03T17:00", "America/New_York")).toBe(Date.UTC(2026, 11, 3, 22, 0)); // EST
    expect(wallClockToUtcMs("2026-09-24T07:10", "Europe/Berlin")).toBe(Date.UTC(2026, 8, 24, 5, 10)); // CEST
  });

  it("treats a null zone as UTC", () => {
    expect(wallClockToUtcMs("2026-09-24T07:10", null)).toBe(Date.UTC(2026, 8, 24, 7, 10));
  });
});

describe("snapshotsEqual (dedupe)", () => {
  it("treats identical situations as duplicates regardless of source/observedAt", () => {
    const a = snap();
    const b = snap({ source: "lookup", observedAt: "2026-09-21T00:00:00Z" });
    expect(snapshotsEqual(a, b)).toBe(true);
  });

  it("sees a moved estimate as a new situation", () => {
    expect(snapshotsEqual(snap(), snap({ estimatedIn: "2026-09-24T06:10:00Z" }))).toBe(false);
    expect(snapshotsEqual(null, snap())).toBe(false);
    expect(snapshotsEqual(null, null)).toBe(true);
  });
});

describe("detectChanges (materiality)", () => {
  it("flags an arrival delay at/above 30m with the delay as metric", () => {
    const changes = detectChanges({
      prev: snap(),
      next: snap({ estimatedIn: "2026-09-24T05:55:00Z", arrivalDelayMinutes: 45 }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(changes).toHaveLength(1);
    expect(changes[0].kind).toBe("arrival_delay");
    expect(changes[0].severity).toBe("medium");
    expect(changes[0].situation.metric).toBe(45);
    expect(changes[0].summary).toContain("45m late");
  });

  it("escalates a 2h+ delay to high severity", () => {
    const changes = detectChanges({
      prev: snap(),
      next: snap({ estimatedIn: "2026-09-24T07:25:00Z", arrivalDelayMinutes: 135 }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(changes[0].severity).toBe("high");
  });

  it("stays quiet for a sub-threshold 20m delay", () => {
    const changes = detectChanges({
      prev: snap(),
      next: snap({ estimatedIn: "2026-09-24T05:30:00Z", arrivalDelayMinutes: 20 }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(changes).toHaveLength(0);
  });

  it("reports cancellation alone, critical — delay noise is superseded", () => {
    const changes = detectChanges({
      prev: snap(),
      next: snap({ cancelled: true, status: "Cancelled", arrivalDelayMinutes: 90 }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(changes.map((c) => c.kind)).toEqual(["cancellation"]);
    expect(changes[0].severity).toBe("critical");
  });

  it("reports diversion alone, critical", () => {
    const changes = detectChanges({
      prev: snap(),
      next: snap({ diverted: true, status: "En Route / Diverted" }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(changes.map((c) => c.kind)).toEqual(["diversion"]);
  });

  it("flags a schedule change against the booked baseline (first snapshot)", () => {
    const changes = detectChanges({
      prev: null,
      next: snap({
        scheduledOut: "2026-09-23T21:30:00Z",
        estimatedOut: "2026-09-23T21:30:00Z",
        scheduledIn: "2026-09-24T05:40:00Z",
        estimatedIn: "2026-09-24T05:40:00Z",
      }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(changes.map((c) => c.kind)).toEqual(["schedule_change"]);
    expect(changes[0].situation.metric).toBe(30);
  });

  it("ignores a 10m schedule drift and any schedule move after departure", () => {
    const drift = detectChanges({
      prev: snap(),
      next: snap({ scheduledOut: "2026-09-23T21:10:00Z", scheduledIn: "2026-09-24T05:20:00Z", estimatedIn: "2026-09-24T05:20:00Z" }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(drift).toHaveLength(0);
    const afterDeparture = detectChanges({
      prev: snap(),
      next: snap({
        actualOut: "2026-09-23T21:05:00Z",
        scheduledOut: "2026-09-23T22:00:00Z",
        scheduledIn: "2026-09-24T06:10:00Z",
        estimatedIn: "2026-09-24T05:10:00Z",
      }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(afterDeparture.map((c) => c.kind)).not.toContain("schedule_change");
  });

  it("accumulates sub-threshold schedule steps against the booked baseline", () => {
    // Step 1: +10m vs booked — below the 15m threshold, stays quiet.
    const step1 = snap({
      scheduledOut: "2026-09-23T21:10:00Z",
      scheduledIn: "2026-09-24T05:20:00Z",
      estimatedIn: "2026-09-24T05:20:00Z",
    });
    expect(
      detectChanges({ prev: snap(), next: step1, flight: FLIGHT, thresholds: THRESHOLDS, now: NOW }),
    ).toHaveLength(0);

    // Step 2: another +10m. Step-over-step that is again only 10m — but
    // the cumulative shift vs booked is 20m, and that is what fires.
    // (Regression: measuring vs the previous snapshot let this creep
    // past the threshold forever.)
    const step2 = snap({
      scheduledOut: "2026-09-23T21:20:00Z",
      scheduledIn: "2026-09-24T05:30:00Z",
      estimatedIn: "2026-09-24T05:30:00Z",
    });
    const changes = detectChanges({
      prev: step1,
      next: step2,
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(changes.map((c) => c.kind)).toEqual(["schedule_change"]);
    expect(changes[0].situation.metric).toBe(20);
    expect(changes[0].summary).toContain("20m later");

    // Step 3: +15m more — cumulative 35m vs booked, and the worsening
    // gate sees real growth over the 20m situation.
    const step3 = snap({
      scheduledOut: "2026-09-23T21:35:00Z",
      scheduledIn: "2026-09-24T05:45:00Z",
      estimatedIn: "2026-09-24T05:45:00Z",
    });
    const changes3 = detectChanges({
      prev: step2,
      next: step3,
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(changes3.map((c) => c.kind)).toEqual(["schedule_change"]);
    expect(changes3[0].situation.metric).toBe(35);
    expect(isWorseThan("schedule_change", changes[0].situation, changes3[0].situation)).toBe(true);

    // Re-detecting the SAME cumulative situation is not worse — the
    // gate suppresses it, so a repeat delivery cannot double-fire.
    const again = detectChanges({
      prev: step1,
      next: step2,
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(isWorseThan("schedule_change", changes[0].situation, again[0].situation)).toBe(false);
  });

  it("single-step: a 30m move from a real previous snapshot fires at metric 30, as before", () => {
    const changes = detectChanges({
      prev: snap({ gateOrigin: "C121" }), // a real prev whose schedule still equals booked
      next: snap({
        scheduledOut: "2026-09-23T21:30:00Z",
        scheduledIn: "2026-09-24T05:40:00Z",
        estimatedIn: "2026-09-24T05:40:00Z",
      }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    expect(changes.map((c) => c.kind)).toEqual(["schedule_change"]);
    expect(changes[0].situation.metric).toBe(30);
  });

  it("flags a gate change inside 24h of departure, not days out, and not a first assignment", () => {
    const dayOf = detectChanges({
      prev: snap(),
      next: snap({ gateOrigin: "C121" }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: new Date("2026-09-23T12:00:00Z"), // 9h before departure
    });
    expect(dayOf.map((c) => c.kind)).toEqual(["gate_change"]);

    const daysOut = detectChanges({
      prev: snap(),
      next: snap({ gateOrigin: "C121" }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW, // 3+ days before departure
    });
    expect(daysOut).toHaveLength(0);

    const firstAssignment = detectChanges({
      prev: snap({ gateOrigin: null }),
      next: snap({ gateOrigin: "C121" }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: new Date("2026-09-23T12:00:00Z"),
    });
    expect(firstAssignment).toHaveLength(0);
  });
});

describe("isWorseThan (dismissal remembered)", () => {
  it("delays and schedule shifts must strictly grow", () => {
    expect(isWorseThan("arrival_delay", { signature: "a", metric: 45 }, { signature: "b", metric: 90 })).toBe(true);
    expect(isWorseThan("arrival_delay", { signature: "a", metric: 45 }, { signature: "b", metric: 40 })).toBe(false);
    expect(isWorseThan("schedule_change", { signature: "a", metric: 30 }, { signature: "b", metric: 30 })).toBe(false);
  });

  it("a different gate assignment is a new situation; the same one is not", () => {
    expect(isWorseThan("gate_change", { signature: "gate:C120", metric: 1 }, { signature: "gate:C121", metric: 1 })).toBe(true);
    expect(isWorseThan("gate_change", { signature: "gate:C120", metric: 1 }, { signature: "gate:C120", metric: 1 })).toBe(false);
  });

  it("cancellation and diversion never re-fire", () => {
    expect(isWorseThan("cancellation", { signature: "cancelled", metric: 1 }, { signature: "cancelled", metric: 1 })).toBe(false);
    expect(isWorseThan("diversion", { signature: "diverted", metric: 1 }, { signature: "diverted", metric: 1 })).toBe(false);
  });
});

// ─── Impact walk ─────────────────────────────────────────────────────────────

function ev(overrides: Partial<TimelineEvent> = {}): TimelineEvent {
  return {
    id: 1,
    type: "reservation",
    date: "2026-09-24",
    title: "Schneider Bräuhaus",
    description: null,
    location: null,
    time: null,
    imageUrl: null,
    carrierCode: null,
    confirmationCode: null,
    ...overrides,
  };
}

const SCHED_ARR = Date.UTC(2026, 8, 24, 5, 10); // 07:10 Berlin

function walkInput(overrides: Partial<Parameters<typeof runImpactWalk>[0]> = {}) {
  return {
    changedLeg: {
      flightId: 1,
      label: "UA30",
      arrivalAirport: "MUC",
      arrivalTimezone: "Europe/Berlin",
      scheduledArrivalMs: SCHED_ARR,
      estimatedArrivalMs: SCHED_ARR + 120 * 60000, // 2h late: 09:10 Berlin
      cancelled: false,
    },
    timelineEvents: [] as TimelineEvent[],
    onwardFlights: [],
    participantCount: 1,
    ...overrides,
  };
}

describe("runImpactWalk", () => {
  it("flags a connection whose slack fell below the minimum", () => {
    const est = SCHED_ARR + 120 * 60000;
    const impacts = runImpactWalk(
      walkInput({
        onwardFlights: [
          { flightId: 2, label: "LH123 MUC → FRA", departureAirport: "MUC", departureMs: est + 45 * 60000 },
          { flightId: 3, label: "LH200 MUC → FRA", departureAirport: "MUC", departureMs: est + 180 * 60000 },
        ],
      }),
    );
    expect(impacts.map((i) => i.type)).toEqual(["connection_risk"]);
    expect(impacts[0].detail).toContain("LH123");
    expect(impacts[0].detail).toContain("45m");
  });

  it("calls a negative-slack connection missed, and ignores other airports / unreachable-anyway legs", () => {
    const est = SCHED_ARR + 120 * 60000;
    const impacts = runImpactWalk(
      walkInput({
        onwardFlights: [
          { flightId: 2, label: "LH123 MUC → FRA", departureAirport: "MUC", departureMs: est - 15 * 60000 },
          { flightId: 3, label: "XX9 FRA → BER", departureAirport: "FRA", departureMs: est + 30 * 60000 },
          { flightId: 4, label: "LH1 MUC → HAM", departureAirport: "MUC", departureMs: SCHED_ARR - 60 * 60000 },
        ],
      }),
    );
    expect(impacts.map((i) => i.type)).toEqual(["connection_missed"]);
  });

  it("flags a late arrival at the day's check-in, and a past-midnight arrival as check-in at risk", () => {
    const checkin = ev({ type: "accommodation", title: "Check-in: The Westin Grand", time: null });
    const late = runImpactWalk(
      walkInput({
        changedLeg: {
          flightId: 1, label: "UA30", arrivalAirport: "MUC", arrivalTimezone: "Europe/Berlin",
          scheduledArrivalMs: SCHED_ARR,
          estimatedArrivalMs: Date.UTC(2026, 8, 24, 19, 30), // 21:30 Berlin, +1h transfer = 22:30
          cancelled: false,
        },
        timelineEvents: [checkin],
      }),
    );
    expect(late.map((i) => i.type)).toEqual(["late_arrival"]);
    expect(late[0].detail).toContain("The Westin Grand");

    const pastMidnight = runImpactWalk(
      walkInput({
        changedLeg: {
          flightId: 1, label: "UA30", arrivalAirport: "MUC", arrivalTimezone: "Europe/Berlin",
          scheduledArrivalMs: SCHED_ARR,
          estimatedArrivalMs: Date.UTC(2026, 8, 24, 21, 30), // 23:30 Berlin, +1h = 00:30 next day
          cancelled: false,
        },
        timelineEvents: [checkin],
      }),
    );
    expect(pastMidnight.map((i) => i.type)).toEqual(["checkin_at_risk"]);
  });

  it("names reservations that now start before the traveler can arrive", () => {
    const impacts = runImpactWalk(
      walkInput({
        changedLeg: {
          flightId: 1, label: "UA30", arrivalAirport: "MUC", arrivalTimezone: "Europe/Berlin",
          scheduledArrivalMs: SCHED_ARR,
          estimatedArrivalMs: Date.UTC(2026, 8, 24, 17, 45), // 19:45 Berlin; ready 20:45
          cancelled: false,
        },
        timelineEvents: [
          ev({ title: "Schneider Bräuhaus", time: "19:30" }),
          ev({ id: 2, title: "Late Supper", time: "22:00" }),
        ],
      }),
    );
    expect(impacts.map((i) => i.type)).toEqual(["reservation_at_risk"]);
    expect(impacts[0].detail).toContain("Schneider Bräuhaus");
  });

  it("adds the group coherence note for a multi-traveler trip with impacts", () => {
    const est = SCHED_ARR + 120 * 60000;
    const impacts = runImpactWalk(
      walkInput({
        participantCount: 5,
        onwardFlights: [
          { flightId: 2, label: "LH123 MUC → FRA", departureAirport: "MUC", departureMs: est + 30 * 60000 },
        ],
      }),
    );
    expect(impacts.map((i) => i.type)).toEqual(["connection_risk", "group_coherence"]);
    expect(impacts[1].detail).toContain("5 travelers");
  });

  it("stays silent for an unaffected trip (on-time arrival, roomy connection, midday check-in)", () => {
    const impacts = runImpactWalk(
      walkInput({
        changedLeg: {
          flightId: 1, label: "UA30", arrivalAirport: "MUC", arrivalTimezone: "Europe/Berlin",
          scheduledArrivalMs: SCHED_ARR, estimatedArrivalMs: SCHED_ARR, cancelled: false,
        },
        timelineEvents: [
          ev({ type: "accommodation", title: "Check-in: The Westin Grand", time: null }),
          ev({ id: 2, title: "Schneider Bräuhaus", time: "19:30" }),
        ],
        onwardFlights: [
          { flightId: 2, label: "LH123 MUC → FRA", departureAirport: "MUC", departureMs: SCHED_ARR + 240 * 60000 },
        ],
        participantCount: 4,
      }),
    );
    expect(impacts).toEqual([]);
    expect(buildImpactSummary(impacts)).toContain("No downstream impact");
  });

  it("for a cancellation, names missed onward connections and skips check-in math", () => {
    const impacts = runImpactWalk(
      walkInput({
        changedLeg: {
          flightId: 1, label: "UA30", arrivalAirport: "MUC", arrivalTimezone: "Europe/Berlin",
          scheduledArrivalMs: SCHED_ARR, estimatedArrivalMs: null, cancelled: true,
        },
        timelineEvents: [ev({ type: "accommodation", title: "Check-in: The Westin Grand", time: null })],
        onwardFlights: [
          { flightId: 2, label: "LH123 MUC → FRA", departureAirport: "MUC", departureMs: SCHED_ARR + 180 * 60000 },
        ],
      }),
    );
    expect(impacts.map((i) => i.type)).toEqual(["connection_missed"]);
  });
});

describe("buildAdvisoryEmail", () => {
  it("is plain language: what changed, the impact, and the no-auto-change promise", () => {
    const changes = detectChanges({
      prev: snap(),
      next: snap({ estimatedIn: "2026-09-24T05:55:00Z", arrivalDelayMinutes: 45 }),
      flight: FLIGHT,
      thresholds: THRESHOLDS,
      now: NOW,
    });
    const email = buildAdvisoryEmail({
      tripTitle: "Munich — guys' trip",
      changes,
      impactSummary: "No downstream impact found on the rest of the itinerary.",
    });
    expect(email.subject).toContain("UA30");
    expect(email.text).toContain("45m late");
    expect(email.text).toContain("No downstream impact");
    expect(email.text).toContain("Nothing has been rebooked");
  });
});
