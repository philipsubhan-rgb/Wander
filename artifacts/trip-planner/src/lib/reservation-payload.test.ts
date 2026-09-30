import { describe, expect, it } from 'vitest';
import { buildReservationPayload } from './reservation-payload';

const base = {
  type: 'restaurant' as const,
  title: 'Dinner',
  venue: 'Bayside',
  address: 'Rodney Bay',
  date: '2027-05-12',
  time: '19:30',
  url: 'https://bayside.example',
  phone: '555-0100',
};

describe('buildReservationPayload', () => {
  it('sends explicit null for cleared fields so the PATCH persists the clear', () => {
    // Regression: the form cleared the Website URL when the venue text was
    // edited away from "Orlando's", but the payload mapped it to `undefined`,
    // which JSON.stringify drops — so the old URL survived the save.
    const payload = buildReservationPayload({ ...base, url: '', phone: '', address: '' });

    expect(payload.url).toBeNull();
    expect(payload.phone).toBeNull();
    expect(payload.address).toBeNull();

    // The null must survive JSON serialization (undefined would not).
    const serialized = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    expect('url' in serialized).toBe(true);
    expect(serialized.url).toBeNull();
  });

  it('clears coordinates to null when the venue is edited away', () => {
    const payload = buildReservationPayload({ ...base, lat: undefined, lon: undefined });
    expect(payload.lat).toBeNull();
    expect(payload.lon).toBeNull();
  });

  it('passes through provided values unchanged', () => {
    const payload = buildReservationPayload({ ...base, lat: 14.01, lon: -60.98 });
    expect(payload.url).toBe('https://bayside.example');
    expect(payload.time).toBe('19:30');
    expect(payload.venue).toBe('Bayside');
    expect(payload.lat).toBe(14.01);
    expect(payload.lon).toBe(-60.98);
    expect(payload.title).toBe('Dinner');
    expect(payload.date).toBe('2027-05-12');
  });
});
