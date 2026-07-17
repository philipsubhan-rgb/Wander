/**
 * Fetch a cover image URL for a travel destination.
 *
 * Strategy:
 *  1. Try Wikipedia REST API summary (free, no API key).
 *     Skip SVGs and map graphics which sometimes appear for islands/regions.
 *  2. Try alternate search terms (e.g. "Bali island", "Bali tourism").
 *
 * Returns a stable image URL string, or null if nothing suitable is found.
 */

const USER_AGENT = "TripPlannerApp/1.0 (contact@tripplanner.app)";

async function tryWikipedia(term: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      originalimage?: { source: string };
      thumbnail?: { source: string };
    };
    const img = data.originalimage?.source ?? data.thumbnail?.source ?? null;
    // Skip SVG maps and location markers
    if (!img) return null;
    if (img.endsWith(".svg") || img.includes(".svg/")) return null;
    return img;
  } catch {
    return null;
  }
}

export async function fetchDestinationImage(destination: string): Promise<string | null> {
  const city = destination.split(",")[0].trim();
  const country = destination.split(",")[1]?.trim() ?? "";

  const candidates = [
    city,
    `${city} ${country}`.trim(),
    `${city} island`,
    `${city} city`,
    `${city} tourism`,
  ];

  for (const term of candidates) {
    const url = await tryWikipedia(term);
    if (url) return url;
  }

  return null;
}
