import { describe, expect, it } from 'vitest';
import { buildGuideStops, buildRouteLegs, hasCoordinates } from './trip-guide';

describe('trip guide route model', () => {
  it('orders saved stops by their trip dates and preserves numbered labels', () => {
    const stops = buildGuideStops({
      stays: [{ id: 1, name: 'Hotel', checkIn: '2026-04-12T15:00:00Z', lat: 48.85, lon: 2.35 }],
      activities: [{ id: 2, title: 'Museum', date: '2026-04-10', lat: 48.86, lon: 2.33 }],
      reservations: [{ id: 3, title: 'Dinner', date: '2026-04-11', lat: 48.87, lon: 2.34 }],
      cars: [],
    });

    expect(stops.map((stop) => stop.name)).toEqual(['Museum', 'Dinner', 'Hotel']);
    expect(stops.map((stop) => stop.number)).toEqual([1, 2, 3]);
    expect(stops[0]).toMatchObject({ id: 'activity-2', lat: 48.86, lon: 2.33 });
  });

  it('calculates a coordinate-backed distance and duration', () => {
    const legs = buildRouteLegs([
      { id: 'a', number: 1, name: 'Louvre', lat: 48.8606, lon: 2.3376 },
      { id: 'b', number: 2, name: 'Eiffel Tower', lat: 48.8584, lon: 2.2945 },
    ]);

    expect(legs).toHaveLength(1);
    expect(legs[0].approximate).toBe(false);
    expect(legs[0].distance).toMatch(/km$/);
    expect(legs[0].duration).toMatch(/walk · .*drive/);
  });

  it('uses the clearly labeled fallback when either stop lacks coordinates', () => {
    const legs = buildRouteLegs([
      { id: 'a', number: 1, name: 'Hotel' },
      { id: 'b', number: 2, name: 'Cafe' },
    ]);

    expect(legs[0]).toMatchObject({
      distance: '800 m',
      duration: 'Approx. 12 min walk · 5 min drive',
      approximate: true,
    });
  });

  it('rejects incomplete or non-numeric coordinates', () => {
    expect(hasCoordinates({ lat: 48.85, lon: 2.35 })).toBe(true);
    expect(hasCoordinates({ lat: 'not-a-number', lon: 2.35 })).toBe(false);
    expect(hasCoordinates({ lat: 48.85 })).toBe(false);
  });
});