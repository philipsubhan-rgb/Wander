import { describe, it, expect } from 'vitest';
import {
  venueFieldsToClearOnVenueChange,
  venueUpdatesForSuggestion,
  mayReplaceVenueImage,
} from './venue-metadata';

describe('venueFieldsToClearOnVenueChange', () => {
  it('always clears address, url, and coordinates on venue change', () => {
    const fields = venueFieldsToClearOnVenueChange(
      { address: '1 Old St', url: 'https://old.example', phone: '555-0100', imageUrl: 'old.jpg', lat: 1, lon: 2 },
      { phone: '555-0100', url: 'https://old.example', imageUrl: 'old.jpg' },
    );
    expect(fields).toContain('address');
    expect(fields).toContain('url');
    expect(fields).toContain('lat');
    expect(fields).toContain('lon');
  });

  it('clears auto-filled phone/imageUrl but preserves user-customized values', () => {
    const fields = venueFieldsToClearOnVenueChange(
      {
        address: '1 Old St',
        url: 'https://old.example',
        phone: '555-0100', // still the auto-filled value -> stale
        imageUrl: 'custom-picked.jpg', // user chose their own -> keep
        lat: 1,
        lon: 2,
      },
      { phone: '555-0100', url: 'https://old.example', imageUrl: 'auto-old.jpg' },
    );
    expect(fields).toContain('phone');
    expect(fields).not.toContain('imageUrl');
  });

  it('clears phone/imageUrl too when there is no auto-filled baseline', () => {
    const fields = venueFieldsToClearOnVenueChange(
      { address: 'x', url: 'y', phone: '555-0100', imageUrl: 'z.jpg', lat: 1, lon: 2 },
      null,
    );
    expect(fields).toEqual(expect.arrayContaining(['address', 'url', 'lat', 'lon', 'phone', 'imageUrl']));
  });
});

describe('venueUpdatesForSuggestion', () => {
  const suggestion = {
    name: 'New Bistro',
    address: '2 New Ave',
    lat: 10,
    lon: 20,
    phone: '555-0200',
    website: 'https://new.example',
  };

  it('always replaces address and coordinates from the new suggestion', () => {
    const { updates } = venueUpdatesForSuggestion(
      { address: '1 Old St', lat: 1, lon: 2, phone: 'user-typed', url: 'user-typed-url' },
      suggestion,
      { phone: '555-0100', url: 'https://old.example' },
    );
    expect(updates.address).toBe('2 New Ave');
    expect(updates.lat).toBe(10);
    expect(updates.lon).toBe(20);
  });

  it('replaces phone/url that still hold the old venue auto-filled values', () => {
    const { updates, autoFilled } = venueUpdatesForSuggestion(
      { phone: '555-0100', url: 'https://old.example' },
      suggestion,
      { phone: '555-0100', url: 'https://old.example' },
    );
    expect(updates.phone).toBe('555-0200');
    expect(updates.url).toBe('https://new.example');
    expect(autoFilled.phone).toBe('555-0200');
    expect(autoFilled.url).toBe('https://new.example');
  });

  it('preserves user-typed phone/url instead of the old blank-only behavior', () => {
    const { updates } = venueUpdatesForSuggestion(
      { phone: '555-9999', url: 'https://mine.example' },
      suggestion,
      { phone: '555-0100', url: 'https://old.example' },
    );
    expect(updates.phone).toBeUndefined();
    expect(updates.url).toBeUndefined();
  });

  it('fills blank phone/url from the suggestion', () => {
    const { updates } = venueUpdatesForSuggestion({ phone: '', url: '' }, suggestion, null);
    expect(updates.phone).toBe('555-0200');
    expect(updates.url).toBe('https://new.example');
  });

  it('blanks phone/url when the new suggestion has none and the old value was auto-filled', () => {
    const { updates } = venueUpdatesForSuggestion(
      { phone: '555-0100', url: 'https://old.example' },
      { name: 'No Phone Place', address: '3 Nowhere Ln', lat: 30, lon: 40 },
      { phone: '555-0100', url: 'https://old.example' },
    );
    expect(updates.phone).toBe('');
    expect(updates.url).toBe('');
  });
});

describe('mayReplaceVenueImage', () => {
  it('allows replacing a blank or auto-filled photo', () => {
    expect(mayReplaceVenueImage('', 'auto.jpg')).toBe(true);
    expect(mayReplaceVenueImage('auto.jpg', 'auto.jpg')).toBe(true);
  });

  it('refuses to clobber a user-picked photo', () => {
    expect(mayReplaceVenueImage('my-photo.jpg', 'auto.jpg')).toBe(false);
  });
});
