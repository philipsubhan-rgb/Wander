import { describe, it, expect } from 'vitest';
import { getTransitionIndices } from './itinerary-transitions';

// Helper to build a minimal accommodation event
const accom = (title: string) => ({ type: 'accommodation', title });
const flight = (title: string) => ({ type: 'flight', title });

describe('getTransitionIndices', () => {
  it('returns an empty set when there are no events', () => {
    expect(getTransitionIndices([])).toEqual(new Set());
  });

  it('returns an empty set for a single accommodation', () => {
    expect(getTransitionIndices([accom('Check-in: Hotel A')])).toEqual(new Set());
  });

  it('returns an empty set when two accommodations do not form a check-out → check-in pair', () => {
    // Two check-ins — no transition
    expect(getTransitionIndices([
      accom('Check-in: Hotel A'),
      accom('Check-in: Hotel B'),
    ])).toEqual(new Set());

    // Two check-outs — no transition
    expect(getTransitionIndices([
      accom('Check-out: Hotel A'),
      accom('Check-out: Hotel B'),
    ])).toEqual(new Set());
  });

  it('inserts one divider for the standard two-accommodation transition', () => {
    const events = [
      accom('Check-out: Hotel A'),
      accom('Check-in: Hotel B'),
    ];
    expect(getTransitionIndices(events)).toEqual(new Set([0]));
  });

  it('ignores non-accommodation events between the pair', () => {
    // Flight sits between two accommodations — not a consecutive pair
    const events = [
      accom('Check-out: Hotel A'),
      flight('Flight AA123'),
      accom('Check-in: Hotel B'),
    ];
    expect(getTransitionIndices(events)).toEqual(new Set());
  });

  // ── Three-accommodation boundary condition ─────────────────────────────────
  //
  // This is the scenario the task asks us to confirm: e.g. a traveller checks
  // out of hotel A, checks into hotel B for a brief mid-day stop, then checks
  // out of hotel B and into hotel C — all on the same calendar day.
  //
  // Expected layout:
  //   [Check-out: Hotel A]
  //   ── Transition Day ──          ← divider after index 0
  //   [Check-in: Hotel B]
  //   [Check-out: Hotel B]
  //   ── Transition Day ──          ← divider after index 2
  //   [Check-in: Hotel C]
  //
  it('inserts two dividers for three accommodations forming two consecutive transitions', () => {
    const events = [
      accom('Check-out: Hotel A'),
      accom('Check-in: Hotel B'),
      accom('Check-out: Hotel B'),
      accom('Check-in: Hotel C'),
    ];
    expect(getTransitionIndices(events)).toEqual(new Set([0, 2]));
  });

  it('handles three accommodations where only the first pair matches', () => {
    // Check-out → Check-in → Check-out (no final Check-in)
    const events = [
      accom('Check-out: Hotel A'),
      accom('Check-in: Hotel B'),
      accom('Check-out: Hotel B'),
    ];
    // Only index 0 is a valid check-out → check-in pair
    expect(getTransitionIndices(events)).toEqual(new Set([0]));
  });

  it('handles three accommodations where only the second pair matches', () => {
    // Check-in → Check-out → Check-in (no leading Check-out before first Check-in)
    const events = [
      accom('Check-in: Hotel A'),
      accom('Check-out: Hotel A'),
      accom('Check-in: Hotel B'),
    ];
    // Index 1 is a valid check-out → check-in pair
    expect(getTransitionIndices(events)).toEqual(new Set([1]));
  });

  it('works correctly when non-accommodation events surround the three accommodations', () => {
    const events = [
      flight('Flight AA1'),
      accom('Check-out: Hotel A'),
      accom('Check-in: Hotel B'),
      accom('Check-out: Hotel B'),
      accom('Check-in: Hotel C'),
      flight('Flight AA2'),
    ];
    expect(getTransitionIndices(events)).toEqual(new Set([1, 3]));
  });
});
