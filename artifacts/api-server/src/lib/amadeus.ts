// Amadeus API client — free test account at https://developers.amadeus.com
// Set AMADEUS_CLIENT_ID and AMADEUS_CLIENT_SECRET environment variables.
// Test environment returns realistic sandbox data.

const BASE_URL = 'https://test.api.amadeus.com';

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const clientId = process.env.AMADEUS_CLIENT_ID;
  const clientSecret = process.env.AMADEUS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('AMADEUS_CREDENTIALS_MISSING');
  }

  const res = await fetch(`${BASE_URL}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Amadeus token error: ${text}`);
  }

  const data = await res.json() as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000, // refresh 60s early
  };

  return cachedToken.token;
}

export interface FlightSegment {
  departure: { iataCode: string; at: string };
  arrival: { iataCode: string; at: string };
  carrierCode: string;
  number: string;
  numberOfStops: number;
  duration: string;
}

export interface FlightOffer {
  id: string;
  airline: string;          // carrier name resolved from dictionaries
  carrierCode: string;
  flightNumber: string;
  segments: FlightSegment[];
  totalDuration: string;
  stops: number;
  price: string | null;
  currency: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: string;
  arrivalTime: string;
}

export async function searchFlights(
  origin: string,
  destination: string,
  date: string,       // YYYY-MM-DD
  adults = 1
): Promise<FlightOffer[]> {
  const token = await getAccessToken();

  const params = new URLSearchParams({
    originLocationCode: origin.toUpperCase(),
    destinationLocationCode: destination.toUpperCase(),
    departureDate: date,
    adults: String(adults),
    max: '15',
    currencyCode: 'USD',
    nonStop: 'false',
  });

  const res = await fetch(
    `${BASE_URL}/v2/shopping/flightOffersSearch?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Amadeus search error ${res.status}: ${text}`);
  }

  const data = await res.json() as {
    data?: any[];
    dictionaries?: { carriers?: Record<string, string> };
    errors?: any[];
  };

  if (data.errors) {
    throw new Error(data.errors.map((e: any) => e.detail || e.title).join('; '));
  }

  const carriers = data.dictionaries?.carriers ?? {};
  const offers = data.data ?? [];

  return offers.map((offer: any): FlightOffer => {
    const itinerary = offer.itineraries[0];
    const segments: FlightSegment[] = itinerary.segments.map((s: any) => ({
      departure: { iataCode: s.departure.iataCode, at: s.departure.at },
      arrival: { iataCode: s.arrival.iataCode, at: s.arrival.at },
      carrierCode: s.carrierCode,
      number: s.number,
      numberOfStops: s.numberOfStops ?? 0,
      duration: s.duration ?? '',
    }));
    const firstSeg = segments[0];
    const lastSeg = segments[segments.length - 1];
    const stops = segments.length - 1;

    return {
      id: offer.id,
      airline: carriers[firstSeg.carrierCode] ?? firstSeg.carrierCode,
      carrierCode: firstSeg.carrierCode,
      flightNumber: `${firstSeg.carrierCode}${firstSeg.number}`,
      segments,
      totalDuration: itinerary.duration ?? '',
      stops,
      price: offer.price?.total ?? null,
      currency: offer.price?.currency ?? 'USD',
      departureAirport: firstSeg.departure.iataCode,
      arrivalAirport: lastSeg.arrival.iataCode,
      departureTime: firstSeg.departure.at,
      arrivalTime: lastSeg.arrival.at,
    };
  });
}
