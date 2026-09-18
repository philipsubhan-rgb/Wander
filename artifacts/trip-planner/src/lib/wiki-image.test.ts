import { describe, it, expect, vi, beforeEach } from 'vitest';
import { searchImages, fetchWikiImage } from './wiki-image';

function commonsResponse(pages: Record<string, any>) {
  return {
    ok: true,
    json: async () => ({ query: { pages } }),
  };
}

function page(title: string, url: string, width = 1280, height = 800) {
  return {
    title,
    imageinfo: [{ url, thumburl: url, width, height }],
  };
}

describe('searchImages', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns real photos and filters out logos, maps, and diagrams', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        commonsResponse({
          '1': page('File:Grace Bay Beach.jpg', 'https://upload.wikimedia.org/thumb/1/1280px-Grace_Bay_Beach.jpg'),
          '2': page('File:Ritz-Carlton logo.svg', 'https://upload.wikimedia.org/thumb/2/logo.png'),
          '3': page('File:Providenciales map.png', 'https://upload.wikimedia.org/thumb/3/map.png'),
          '4': page('File:Turks and Caicos flag.svg', 'https://upload.wikimedia.org/thumb/4/flag.png'),
        })
      )
    );
    const results = await searchImages('Grace Bay');
    expect(results).toHaveLength(1);
    expect(results[0].url).toContain('Grace_Bay_Beach.jpg');
  });

  it('prefers photographic JPEGs over PNGs', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        commonsResponse({
          '1': page('File:Beach aerial.png', 'https://upload.wikimedia.org/thumb/1/beach.png'),
          '2': page('File:Beach sunset.jpg', 'https://upload.wikimedia.org/thumb/2/beach.jpg'),
        })
      )
    );
    const results = await searchImages('Beach');
    expect(results).toHaveLength(2);
    expect(results[0].url).toContain('beach.jpg');
  });

  it('drops tiny images', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        commonsResponse({
          '1': page('File:Tiny icon.jpg', 'https://upload.wikimedia.org/thumb/1/tiny.jpg', 120, 120),
          '2': page('File:Big beach.jpg', 'https://upload.wikimedia.org/thumb/2/big.jpg', 1600, 900),
        })
      )
    );
    const results = await searchImages('Beach');
    expect(results).toHaveLength(1);
    expect(results[0].url).toContain('big.jpg');
  });

  it('falls back to the first comma-segment when the full query finds nothing', async () => {
    const fetchMock = vi.fn(async (input: any) => {
      const url = String(input);
      // Full query contains "Turks & Caicos"; the comma-segment fallback does not.
      if (url.includes('Turks')) {
        return commonsResponse({});
      }
      return commonsResponse({
        '1': page('File:Steak dinner.jpg', 'https://upload.wikimedia.org/thumb/1/steak.jpg'),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const results = await searchImages('BLT Steak, The Ritz-Carlton, Turks & Caicos');
    expect(results).toHaveLength(1);
    // full query: bitmap-restricted search + unrestricted retry (both empty),
    // then the comma-segment fallback finds the photo
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns [] on network failure instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('nope');
      })
    );
    await expect(searchImages('Beach')).resolves.toEqual([]);
  });
});

describe('fetchWikiImage', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the top-ranked photo URL', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        commonsResponse({
          '1': page('File:Chalk Sound.jpg', 'https://upload.wikimedia.org/thumb/1/chalk.jpg'),
        })
      )
    );
    await expect(fetchWikiImage('Chalk Sound, Providenciales')).resolves.toContain('chalk.jpg');
  });

  it('returns null when Commons has nothing credible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => commonsResponse({})));
    await expect(fetchWikiImage('Some Nonexistent Place XYZ')).resolves.toBeNull();
  });

  it('caches results per normalized query', async () => {
    const fetchMock = vi.fn(async () =>
      commonsResponse({
        '1': page('File:Beach.jpg', 'https://upload.wikimedia.org/thumb/1/beach.jpg'),
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    await fetchWikiImage('  Grace Bay ');
    await fetchWikiImage('grace bay');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
