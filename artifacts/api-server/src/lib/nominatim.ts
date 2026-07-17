export interface PlaceResult {
  name: string;
  address: string;
  lat: number;
  lon: number;
}

export async function searchPlaces(query: string, near?: string): Promise<PlaceResult[]> {
  const key = `places:${query.toLowerCase().trim()}:${(near ?? '').toLowerCase().trim()}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < TTL) return cached.data;

  // Optionally geo-bias toward the trip destination
  const geo = near ? await geocodeDestination(near) : null;
  const delta = 1.5; // ~150 km box around destination center

  const params = new URLSearchParams({
    q: query,
    format: 'jsonv2',
    addressdetails: '1',
    extratags: '1',
    limit: '10',
    'accept-language': 'en',
  });
  if (geo) {
    // viewbox: left,top,right,bottom  (lon-delta, lat+delta, lon+delta, lat-delta)
    params.set('viewbox', `${geo.lon - delta},${geo.lat + delta},${geo.lon + delta},${geo.lat - delta}`);
    params.set('bounded', '0'); // prefer but don't restrict to viewbox
  }

  const res = await fetch(
    `https://nominatim.openstreetmap.org/search?${params}`,
    { headers: { 'User-Agent': 'WanderTripPlanner/1.0' } }
  );

  if (!res.ok) throw new Error(`Nominatim error ${res.status}`);

  const raw = await res.json() as any[];

  const results: PlaceResult[] = raw.map(r => {
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
      address: parts.length ? parts.join(', ') : r.display_name.split(',').slice(0, 3).join(',').trim(),
      lat: parseFloat(r.lat),
      lon: parseFloat(r.lon),
    };
  });

  cache.set(key, { data: results, ts: Date.now() });
  return results;
}

export interface HotelResult {
  name: string;
  address: string;
  phone: string | null;
  lat: number;
  lon: number;
}

// Simple in-memory cache (5 min TTL for search results, 24h for geocoded destinations)
const cache = new Map<string, { data: any; ts: number }>();
const TTL      = 5 * 60  * 1000;
const GEO_TTL  = 24 * 60 * 60 * 1000;

// Geocode a free-text destination to {lat, lon} for viewbox biasing
async function geocodeDestination(destination: string): Promise<{ lat: number; lon: number } | null> {
  const key = `geo:${destination.toLowerCase().trim()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < GEO_TTL) return hit.data;

  const params = new URLSearchParams({
    q: destination,
    format: 'jsonv2',
    limit: '1',
    'accept-language': 'en',
  });
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      { headers: { 'User-Agent': 'WanderTripPlanner/1.0' } }
    );
    const raw = await res.json() as any[];
    const result = raw[0] ? { lat: parseFloat(raw[0].lat), lon: parseFloat(raw[0].lon) } : null;
    cache.set(key, { data: result, ts: Date.now() });
    return result;
  } catch {
    return null;
  }
}

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
