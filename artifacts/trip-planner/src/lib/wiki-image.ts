// Fetch real photos from Wikimedia Commons for a given place/activity name.
// Strategy: search Commons for actual media files (not Wikipedia article
// thumbnails, which are often logos, maps, or diagrams), filter out junk
// titles, and prefer photographic (JPEG) results of reasonable size.
// Returns null silently if nothing credible is found or on any error —
// a missing photo is better than a wrong one.

export interface ImageResult {
  title: string;
  url: string;
  width: number;
  height: number;
}

// Titles that almost never represent a real photograph of the subject.
const JUNK_TITLE =
  /logo|logos|logotype|brand|map|atlas|flag|banner|diagram|seal|coat of arms|crest|emblem|badge|icon|pictogram|chart|graph|plan|schematic|blueprint|symbol|signage|\.svg$/i;

const MIN_WIDTH = 500;

interface CommonsPage {
  title?: string;
  imageinfo?: {
    url?: string;
    thumburl?: string;
    width?: number;
    height?: number;
  }[];
}

async function runCommonsSearch(
  search: string,
  limit: number,
): Promise<ImageResult[]> {
  const params = new URLSearchParams({
    action: "query",
    generator: "search",
    gsrsearch: search,
    gsrnamespace: "6", // File namespace
    gsrlimit: String(limit),
    prop: "imageinfo",
    iiprop: "url|size",
    iiurlwidth: "1280",
    format: "json",
    origin: "*",
  });
  const res = await fetch(`https://commons.wikimedia.org/w/api.php?${params}`, {
    headers: { "Api-User-Agent": "WanderTripPlanner/1.0" },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const pages = Object.values(
    (data.query?.pages ?? {}) as Record<string, CommonsPage>,
  );
  return pages
    .map((p): ImageResult | null => {
      const info = p.imageinfo?.[0];
      const url = info?.thumburl ?? info?.url;
      const title = p.title ?? "";
      if (!url || JUNK_TITLE.test(title)) return null;
      const width = info?.width ?? 0;
      if (width < MIN_WIDTH) return null;
      return { title, url, width, height: info?.height ?? 0 };
    })
    .filter((r): r is ImageResult => r !== null);
}

/**
 * Search Commons for real media files matching `query`. Prefers raster
 * photographic results (filetype:bitmap) and retries without the restriction
 * when that yields nothing. Junk titles (logos, maps, diagrams, flags) and
 * tiny images are filtered out.
 */
async function commonsSearch(
  query: string,
  limit: number,
): Promise<ImageResult[]> {
  for (const search of [`${query} filetype:bitmap`, query]) {
    const results = await runCommonsSearch(search, limit);
    if (results.length > 0) return results;
  }
  return [];
}

function isPhoto(url: string): boolean {
  return /\.(jpe?g)(\/|$|\?)/i.test(url);
}

/** Rank: photographic JPEGs first, then everything else. */
function rank(results: ImageResult[]): ImageResult[] {
  return [...results].sort(
    (a, b) => Number(isPhoto(b.url)) - Number(isPhoto(a.url)),
  );
}

/**
 * Search for usable photos of `query`. Tries the full query first, then the
 * first comma-segment (strips address noise like "BLT Steak, The Ritz-Carlton…"
 * → "BLT Steak"). Returns an empty array when nothing credible is found.
 */
export async function searchImages(
  query: string,
  limit = 12,
): Promise<ImageResult[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const candidates = [trimmed];
  const first = trimmed.split(",")[0].trim();
  if (first && first !== trimmed && first.length > 2) candidates.push(first);
  for (const q of candidates) {
    try {
      const results = await commonsSearch(q, limit);
      if (results.length > 0) return rank(results);
    } catch {
      // try the next, simpler query
    }
  }
  return [];
}

const cache = new Map<string, string | null>();

/**
 * Best single photo URL for `name`, or null when nothing credible is found.
 * Cached in-memory per query. Kept under the historic name so existing call
 * sites (itinerary, overview, accommodations, reservations, activities,
 * car rentals, trip guide) all get real photos without changes.
 */
export async function fetchWikiImage(name: string): Promise<string | null> {
  const key = name.toLowerCase().trim();
  if (cache.has(key)) return cache.get(key)!;

  let result: string | null = null;
  try {
    const results = await searchImages(name, 8);
    result = results[0]?.url ?? null;
  } catch {
    result = null;
  }

  cache.set(key, result);
  return result;
}
