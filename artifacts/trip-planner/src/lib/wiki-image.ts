// Fetch a photo thumbnail from Wikipedia for a given place name.
// Uses the REST summary endpoint which handles redirects automatically.
// Returns null silently if not found or on any error.

const cache = new Map<string, string | null>();

export async function fetchWikiImage(name: string): Promise<string | null> {
  const key = name.toLowerCase().trim();
  if (cache.has(key)) return cache.get(key)!;

  try {
    const title = name.trim().replace(/ /g, '_');
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`,
      { headers: { 'Api-User-Agent': 'WanderTripPlanner/1.0' } }
    );
    if (res.ok) {
      const data = await res.json();
      const url: string | null = data.thumbnail?.source ?? null;
      cache.set(key, url);
      return url;
    }
  } catch {}

  cache.set(key, null);
  return null;
}
