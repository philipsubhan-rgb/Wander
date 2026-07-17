// AviationStack API — free tier: 500 req/month
// Sign up at https://aviationstack.com (free, no credit card)
// Set AVIATIONSTACK_API_KEY as a Replit Secret.
// Note: free tier uses HTTP (not HTTPS); that is fine for server-side calls.

export interface ScheduledFlight {
  flightNumber: string; // e.g. "LH441"
  airline: string;      // e.g. "Lufthansa"
  carrierCode: string;  // e.g. "LH"
  departureAirport: string;
  arrivalAirport: string;
  departureTime: string; // ISO 8601
  arrivalTime: string;   // ISO 8601
}

// 1-hour in-memory cache — avoids burning the free-tier quota on re-opens
const cache = new Map<string, { data: ScheduledFlight[]; expiresAt: number }>();

export async function getScheduledFlights(
  origin: string,
  destination: string,
  date: string // YYYY-MM-DD
): Promise<ScheduledFlight[]> {
  const key = `${origin.toUpperCase()}-${destination.toUpperCase()}-${date}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiresAt) return hit.data;

  const apiKey = process.env.AVIATIONSTACK_API_KEY;
  if (!apiKey) throw new Error('AVIATIONSTACK_KEY_MISSING');

  // Free tier is HTTP only
  const url =
    `http://api.aviationstack.com/v1/flights` +
    `?access_key=${encodeURIComponent(apiKey)}` +
    `&dep_iata=${encodeURIComponent(origin.toUpperCase())}` +
    `&arr_iata=${encodeURIComponent(destination.toUpperCase())}` +
    `&flight_date=${encodeURIComponent(date)}` +
    `&limit=50`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AviationStack HTTP ${res.status}: ${text}`);
  }

  const json = await res.json() as {
    data?: any[];
    error?: { message?: string; code?: string };
  };

  if (json.error) {
    const code = json.error.code ?? '';
    if (code === 'function_access_restricted' || res.status === 403) {
      throw new Error('AVIATIONSTACK_PLAN_RESTRICTED');
    }
    throw new Error(json.error.message ?? code ?? 'AviationStack API error');
  }

  const flights: ScheduledFlight[] = (json.data ?? [])
    .filter((f: any) => f.flight?.iata && f.departure?.scheduled && f.arrival?.scheduled)
    .map((f: any) => ({
      flightNumber: (f.flight.iata as string).replace(/\s+/g, ''),
      airline: f.airline?.name ?? f.airline?.iata ?? '',
      carrierCode: f.airline?.iata ?? '',
      departureAirport: f.departure.iata,
      arrivalAirport: f.arrival.iata,
      departureTime: f.departure.scheduled,
      arrivalTime: f.arrival.scheduled,
    }))
    .sort((a: ScheduledFlight, b: ScheduledFlight) =>
      a.departureTime.localeCompare(b.departureTime)
    );

  cache.set(key, { data: flights, expiresAt: Date.now() + 60 * 60 * 1000 });
  return flights;
}
