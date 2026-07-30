/**
 * Itinerary transition-divider helpers
 *
 * A "transition" is a same-day hotel swap: a "Check-out:" accommodation
 * immediately followed by a "Check-in:" accommodation in the sorted event list.
 *
 * With three or more accommodations on one day (e.g. a very short stay or a
 * data-entry mistake) multiple transitions can occur.  This module returns
 * ALL matching indices so every consecutive check-out → check-in pair gets
 * its own divider.
 *
 * Boundary conditions covered by tests in itinerary-transitions.test.ts:
 *   • 0 events           → empty set
 *   • 1 accommodation    → empty set (no transition)
 *   • 2 accommodations   → set with 1 index (the standard case)
 *   • 3 accommodations   → set with up to 2 indices
 *   • non-matching pairs → empty set (two check-ins, two check-outs, etc.)
 */

export interface TransitionEvent {
  type: string;
  title: string;
}

/**
 * Returns the set of event-list indices after which a TransitionDivider
 * should be rendered.  An index i is included when events[i] is a
 * "Check-out:" accommodation AND events[i+1] is a "Check-in:" accommodation.
 */
export function getTransitionIndices(events: TransitionEvent[]): Set<number> {
  const indices = new Set<number>();
  for (let i = 0; i < events.length - 1; i++) {
    const curr = events[i];
    const next = events[i + 1];
    if (
      curr.type === 'accommodation' &&
      next.type === 'accommodation' &&
      curr.title.startsWith('Check-out:') &&
      next.title.startsWith('Check-in:')
    ) {
      indices.add(i);
    }
  }
  return indices;
}
