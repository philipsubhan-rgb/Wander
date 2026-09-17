// @vitest-environment jsdom
/**
 * Regression test for activity cards omitting stored time/location.
 *
 * Covers two things:
 * 1. The list renders each activity's time and location whenever present.
 * 2. Sorting the list never mutates the array returned by the query hook
 *    (the old code called `activities.sort()` in place, corrupting the
 *    React Query cache entry shared with every other consumer).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

const baseActivities = [
  {
    id: 1,
    tripId: 7,
    title: 'Dinner at Coco Bistro',
    description: null,
    date: '2027-05-10',
    time: '19:30',
    location: 'Coco Bistro, Grace Bay',
    lat: null,
    lon: null,
    imageUrl: 'https://example.com/coco.jpg',
    locationUrl: null,
    type: 'dining',
    notes: null,
    sortOrder: null,
  },
  {
    id: 2,
    tripId: 7,
    title: "Snorkel Smith's Reef",
    description: null,
    date: '2027-05-09',
    time: '09:30',
    location: "Smith's Reef, Turtle Cove",
    lat: null,
    lon: null,
    imageUrl: 'https://example.com/reef.jpg',
    locationUrl: null,
    type: 'adventure',
    notes: null,
    sortOrder: null,
  },
];

const { activityData } = vi.hoisted(() => ({
  activityData: { current: [] as readonly unknown[], loading: false },
}));
activityData.current = baseActivities;

vi.mock('@workspace/api-client-react', () => ({
  useListActivities: () => ({ data: activityData.current, isLoading: activityData.loading }),
  useCreateActivity: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateActivity: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteActivity: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { TripActivities } from '@/components/trip/TripActivities';

describe('TripActivities cards', () => {
  beforeEach(() => {
    activityData.current = baseActivities;
    activityData.loading = false;
  });

  it('renders each activity time and location when present', () => {
    render(<TripActivities tripId={7} />);

    // 19:30 -> 7:30 PM, 09:30 -> 9:30 AM
    expect(screen.getByText('7:30 PM')).toBeTruthy();
    expect(screen.getByText('9:30 AM')).toBeTruthy();
    expect(screen.getByText('Coco Bistro, Grace Bay')).toBeTruthy();
    expect(screen.getByText("Smith's Reef, Turtle Cove")).toBeTruthy();
  });

  it('does not mutate the query-hook array when sorting', () => {
    // Sorting a frozen array in place throws — the component must copy first.
    const frozen = Object.freeze(baseActivities.map(a => ({ ...a })));
    const orderBefore = frozen.map(a => a.id);
    activityData.current = frozen;

    expect(() => render(<TripActivities tripId={7} />)).not.toThrow();
    expect(frozen.map(a => a.id)).toEqual(orderBefore);
  });

  it('survives the loading → loaded transition without a hook-order crash', () => {
    // Regression: the sorted-list memo once sat below the `isLoading` early
    // return, so the first loaded render called one more hook than the loading
    // render and React tore the whole tab down to a blank page.
    activityData.loading = true;
    activityData.current = [];
    const { rerender } = render(<TripActivities tripId={7} />);
    expect(screen.getByText('Loading...')).toBeTruthy();

    activityData.loading = false;
    activityData.current = baseActivities;
    expect(() => rerender(<TripActivities tripId={7} />)).not.toThrow();
    expect(screen.getAllByText('Coco Bistro, Grace Bay').length).toBeGreaterThan(0);
  });
});
