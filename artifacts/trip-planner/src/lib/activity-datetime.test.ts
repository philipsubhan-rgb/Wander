import { describe, expect, it } from 'vitest';
import { formatStoredDate, formatStoredTime, parseStoredDate } from './activity-datetime';

describe('formatStoredDate', () => {
  it('formats ISO dates', () => {
    expect(formatStoredDate('2027-05-12')).toBe('May 12, 2027');
    expect(formatStoredDate('2027-05-12', 'EEE, MMM d')).toBe('Wed, May 12');
  });

  it('formats ISO datetimes', () => {
    expect(formatStoredDate('2027-05-12T14:30:00')).toBe('May 12, 2027');
  });

  it('falls back to non-ISO legacy dates instead of throwing', () => {
    // Legacy TEXT column rows predate strict ISO storage; the card must
    // still show the stored value rather than crash the render.
    expect(formatStoredDate('05/12/2027')).toBe('May 12, 2027');
    expect(formatStoredDate('not a date')).toBe('not a date');
  });

  it('returns null for missing dates', () => {
    expect(formatStoredDate(null)).toBeNull();
    expect(formatStoredDate(undefined)).toBeNull();
    expect(formatStoredDate('')).toBeNull();
    expect(formatStoredDate('   ')).toBeNull();
  });
});

describe('parseStoredDate', () => {
  it('never returns an Invalid Date', () => {
    for (const v of ['2027-05-12', '05/12/2027', 'garbage', '', null, undefined]) {
      const d = parseStoredDate(v);
      expect(d === null || !Number.isNaN(d.getTime())).toBe(true);
    }
  });
});

describe('formatStoredTime', () => {
  it('formats 24-hour times as 12-hour', () => {
    expect(formatStoredTime('16:30')).toBe('4:30 PM');
    expect(formatStoredTime('09:30')).toBe('9:30 AM');
    expect(formatStoredTime('00:00')).toBe('12:00 AM');
    expect(formatStoredTime('12:00')).toBe('12:00 PM');
  });

  it('handles seconds', () => {
    expect(formatStoredTime('16:30:00')).toBe('4:30 PM');
  });

  it('passes through already-12-hour legacy values without NaN garbage', () => {
    // Legacy rows store "2:45 PM"; the old split(':') formatter rendered
    // "2:NaN AM" for these.
    expect(formatStoredTime('2:45 PM')).toBe('2:45 PM');
    expect(formatStoredTime('02:45 pm')).toBe('2:45 PM');
    expect(formatStoredTime('11:05AM')).toBe('11:05 AM');
  });

  it('never emits NaN', () => {
    for (const v of ['16:30', '2:45 PM', 'nope', '25:99', '', null, undefined]) {
      const out = formatStoredTime(v);
      expect(out === null || !out.includes('NaN')).toBe(true);
    }
  });

  it('returns null for missing times', () => {
    expect(formatStoredTime(null)).toBeNull();
    expect(formatStoredTime(undefined)).toBeNull();
    expect(formatStoredTime('')).toBeNull();
  });
});
