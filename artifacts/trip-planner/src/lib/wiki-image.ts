// Fetch a photo thumbnail from Wikipedia for a given place/activity name.
// Strategy:
//  1. Exact REST summary lookup (fast, handles redirects)
//  2. First comma-segment — strips address noise ("BMW Welt, Munich…" → "BMW Welt")
//  3. Wikipedia search API — fuzzy match to find the right article title, then fetch its summary
// Returns null silently if nothing found or on any error.

const cache = new Map<string, string | null>();

async function summaryImage(title: string): Promise<string | null> {
  try {
    const slug = title.trim().replace(/ /g, '_');
    const res = await fetch(
      `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`,
      { headers: { 'Api-User-Agent': 'WanderTripPlanner/1.0' } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return (data.thumbnail?.source as string) ?? null;
  } catch {
    return null;
  }
}

async function searchWiki(query: string): Promise<string | null> {
  try {
    const params = new URLSearchParams({
      action: 'query',
      list: 'search',
      srsearch: query,
      format: 'json',
      origin: '*',
      srlimit: '3',
      srnamespace: '0',
    });
    const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, {
      headers: { 'Api-User-Agent': 'WanderTripPlanner/1.0' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const hits: { title: string }[] = data.query?.search ?? [];
    for (const hit of hits) {
      const img = await summaryImage(hit.title);
      if (img) return img;
    }
    return null;
  } catch {
    return null;
  }
}

export async function fetchWikiImage(name: string): Promise<string | null> {
  const key = name.toLowerCase().trim();
  if (cache.has(key)) return cache.get(key)!;

  // 1. Exact title
  let result = await summaryImage(name);

  // 2. First comma-segment (strips address noise)
  if (!result) {
    const first = name.split(',')[0].trim();
    if (first !== name && first.length > 2) {
      result = await summaryImage(first);
    }
  }

  // 3. Wikipedia search fallback
  if (!result) {
    const searchQuery = name.split(',')[0].trim();
    result = await searchWiki(searchQuery);
  }

  cache.set(key, result);
  return result;
}
