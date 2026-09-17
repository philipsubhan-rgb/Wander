import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  airportTimeZone,
  formatFlightTime,
  flightDateKey,
  flightEventTime,
  toDatetimeLocalValue,
} from './index';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Import a fresh copy of the module under the given process timezone.
 * (Module-level Intl formatters capture the default zone at creation, so a
 * mid-process TZ change only takes effect for a newly imported module —
 * mirroring how a real viewer process starts up in its own zone.)
 */
async function moduleInZone(tz: string) {
  vi.stubEnv('TZ', tz);
  vi.resetModules();
  return import('./index');
}

describe('airportTimeZone', () => {
  it('maps key airports to IANA zones', () => {
    expect(airportTimeZone('EWR')).toBe('America/New_York');
    expect(airportTimeZone('PLS')).toBe('America/Grand_Turk');
    expect(airportTimeZone('UVF')).toBe('America/St_Lucia');
  });

  it('extracts an IATA code from free text', () => {
    expect(airportTimeZone('Newark (EWR)')).toBe('America/New_York');
  });

  it('returns null for unknown airports', () => {
    expect(airportTimeZone('XXX')).toBeNull();
  });
});

describe('wall-clock preservation', () => {
  it('renders 9:41 AM for a wall-clock value regardless of process timezone', async () => {
    // UA1465 EWR->PLS departs 9:41 AM Newark time. Even when the viewer's
    // machine is on the other side of the planet, the card must say 9:41 AM —
    // the old code appended "Z" and rendered the instant in the viewer zone.
    for (const tz of ['Pacific/Auckland', 'America/Los_Angeles', 'UTC']) {
      const mod = await moduleInZone(tz);
      expect(mod.formatFlightTime('2027-05-08T09:41', 'America/New_York')).toBe('9:41 AM');
      expect(mod.formatFlightTime('2027-05-08T09:41')).toBe('9:41 AM');
      expect(mod.formatFlightTime24('2027-05-13T12:35', 'America/Grand_Turk')).toBe('12:35');
    }
  });
});

describe('legacy UTC values', () => {
  it('converts a legacy Z-suffixed instant to the airport wall time', async () => {
    // Old rows stored airport-local time mislabeled as UTC. With the airport
    // timezone known, 13:41Z renders as the 9:41 AM Newark departure.
    const mod = await moduleInZone('Pacific/Auckland');
    expect(mod.formatFlightTime('2027-05-08T13:41:00.000Z', 'America/New_York')).toBe('9:41 AM');
  });

  it('converts UVF arrivals using the St Lucia zone', () => {
    // AA1245 UVF arrival stored as legacy UTC; UVF is UTC-4 year-round.
    expect(formatFlightTime('2027-05-13T16:35:00.000Z', 'America/St_Lucia')).toBe('12:35 PM');
  });

  it('converts legacy UTC for the datetime-local editor', () => {
    expect(toDatetimeLocalValue('2027-05-08T13:41:00.000Z', 'America/New_York')).toBe('2027-05-08T09:41');
    expect(toDatetimeLocalValue('2027-05-08T09:41', 'America/New_York')).toBe('2027-05-08T09:41');
  });
});

describe('date-only flight values', () => {
  it('keeps time null for date-only values on the timeline', () => {
    expect(flightEventTime('2027-05-08', 'America/New_York')).toBeNull();
    expect(flightDateKey('2027-05-08')).toBe('2027-05-08');
    expect(flightDateKey('2027-05-08T09:41')).toBe('2027-05-08');
  });
});
