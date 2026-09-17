/**
 * Open-Meteo geocoding + forecast helpers for day-sheet weather snapshots.
 *
 * No API key needed. Both fetches use a 5-second AbortController timeout and
 * NEVER throw — any failure resolves to null so callers can treat "no
 * weather" as a normal state.
 */

export interface WeatherSnapshot {
  highF: number;
  lowF: number;
  condition: string;
  rainChancePct: number;
}

const FETCH_TIMEOUT_MS = 5_000;

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Geocode a free-text destination to lat/lon via Open-Meteo.
 * Returns null when the lookup fails, yields no results, or times out.
 */
export async function geocodeDestination(
  destination: string,
): Promise<{ lat: number; lon: number } | null> {
  try {
    const url =
      `https://geocoding-api.open-meteo.com/v1/search` +
      `?name=${encodeURIComponent(destination)}&count=1&language=en`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: Array<{ latitude: number; longitude: number }>;
    };
    const first = data.results?.[0];
    if (!first || typeof first.latitude !== "number" || typeof first.longitude !== "number") {
      return null;
    }
    return { lat: first.latitude, lon: first.longitude };
  } catch {
    return null;
  }
}

/**
 * Map an Open-Meteo weathercode to a short human-readable condition label.
 * Exported separately so it is unit-testable.
 */
export function weathercodeToCondition(code: number): string {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code === 51 || code === 53 || code === 55) return "Drizzle";
  if (code === 56 || code === 57) return "Freezing drizzle";
  if (code === 61 || code === 63 || code === 65 || code === 80 || code === 81 || code === 82) return "Rain";
  if (code === 66 || code === 67) return "Freezing rain";
  if (code === 71 || code === 73 || code === 75 || code === 77 || code === 85 || code === 86) return "Snow";
  if (code === 95) return "Thunderstorm";
  if (code === 96 || code === 99) return "Storm w/ hail";
  return "—";
}

/**
 * Fetch the daily forecast for a single date (forecast or historical, up to
 * 16 days out via the forecast endpoint) in the given IANA timezone.
 * Returns null on any failure — never throws.
 */
export async function fetchWeatherForDate(
  lat: number,
  lon: number,
  dateISO: string,
  timezone: string,
): Promise<WeatherSnapshot | null> {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,weathercode,precipitation_probability_max` +
      `&temperature_unit=fahrenheit` +
      `&timezone=${encodeURIComponent(timezone)}` +
      `&start_date=${dateISO}&end_date=${dateISO}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      daily?: {
        temperature_2m_max?: Array<number | null>;
        temperature_2m_min?: Array<number | null>;
        weathercode?: Array<number | null>;
        precipitation_probability_max?: Array<number | null>;
      };
    };
    const daily = data.daily;
    if (!daily) return null;
    const highF = daily.temperature_2m_max?.[0];
    const lowF = daily.temperature_2m_min?.[0];
    const code = daily.weathercode?.[0];
    const rainChancePct = daily.precipitation_probability_max?.[0];
    if (
      typeof highF !== "number" ||
      typeof lowF !== "number" ||
      typeof code !== "number" ||
      typeof rainChancePct !== "number"
    ) {
      return null;
    }
    return {
      highF: Math.round(highF),
      lowF: Math.round(lowF),
      condition: weathercodeToCondition(code),
      rainChancePct: Math.round(rainChancePct),
    };
  } catch {
    return null;
  }
}
