export interface HotelResult {
  name: string;
  address: string;
  phone: string | null;
  lat: number;
  lon: number;
}

// Simple in-memory cache (5 min TTL)
const cache = new Map<string, { data: HotelResult[]; ts: number }>();
const TTL = 5 * 60 * 1000;

export async function searchHotels(query: string): Promise<HotelResult[]> {
  const key = query.toLowerCase().trim();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < TTL) return cached.data;

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    extratags: '1',
    limit: '10',
    'accept-language': 'en',
  });

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    { headers: { 'User-Agent': 'WanderTripPlanner/1.0' } }
  );

  if (!res.ok) throw new Error(`Nominatim error ${res.status}`);

  const raw = await res.json() as any[];

  const results: HotelResult[] = raw
    .filter(r => {
      const cls = (r.class ?? '').toLowerCase();
      const type = (r.type ?? '').toLowerCase();
      const name = (r.display_name ?? '').toLowerCase();
      // Keep hotels, motels, resorts, hostels, guesthouses, etc.
      return (
        cls === 'tourism' ||
        ['hotel', 'motel', 'hostel', 'resort', 'guest_house', 'apartment', 'lodge'].includes(type) ||
        ['hotel', 'motel', 'hostel', 'resort', 'inn', 'lodge', 'suites'].some(w => name.includes(w))
      );
    })
    .map(r => {
      const addr = r.address ?? {};
      const parts = [
        r.extratags?.['addr:housenumber'] ?? addr.house_number,
        r.extratags?.['addr:street'] ?? addr.road,
        addr.city ?? addr.town ?? addr.village ?? addr.county,
        addr.state,
        addr.country,
      ].filter(Boolean);

      return {
        name: r.name || r.display_name.split(',')[0],
        address: parts.length ? parts.join(', ') : r.display_name,
        phone: r.extratags?.phone ?? r.extratags?.['contact:phone'] ?? null,
        lat: parseFloat(r.lat),
        lon: parseFloat(r.lon),
      };
    });

  cache.set(key, { data: results, ts: Date.now() });
  return results;
}
