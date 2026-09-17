/**
 * Unit tests for ../lib/weather.
 *
 * Network behavior is exercised only through a mocked global fetch — these
 * tests must never hit the real Open-Meteo API.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  geocodeDestination,
  fetchWeatherForDate,
  weathercodeToCondition,
} from "./weather.js";

describe("weathercodeToCondition", () => {
  const cases: Array<[number, string]> = [
    [0, "Clear"],
    [1, "Mostly clear"],
    [2, "Partly cloudy"],
    [3, "Overcast"],
    [45, "Fog"],
    [48, "Fog"],
    [51, "Drizzle"],
    [53, "Drizzle"],
    [55, "Drizzle"],
    [56, "Freezing drizzle"],
    [57, "Freezing drizzle"],
    [61, "Rain"],
    [63, "Rain"],
    [65, "Rain"],
    [80, "Rain"],
    [81, "Rain"],
    [82, "Rain"],
    [66, "Freezing rain"],
    [67, "Freezing rain"],
    [71, "Snow"],
    [73, "Snow"],
    [75, "Snow"],
    [77, "Snow"],
    [85, "Snow"],
    [86, "Snow"],
    [95, "Thunderstorm"],
    [96, "Storm w/ hail"],
    [99, "Storm w/ hail"],
  ];

  it.each(cases)("maps code %i to %s", (code, expected) => {
    expect(weathercodeToCondition(code)).toBe(expected);
  });

  it('maps an unknown code to "—"', () => {
    expect(weathercodeToCondition(42)).toBe("—");
    expect(weathercodeToCondition(-1)).toBe("—");
  });
});

describe("geocodeDestination", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns lat/lon from results[0]", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ latitude: 48.1351, longitude: 11.582 }] })),
    ) as any;

    const result = await geocodeDestination("Munich");
    expect(result).toEqual({ lat: 48.1351, lon: 11.582 });
  });

  it("encodes the destination in the request URL", async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify({ results: [] }))) as any;
    globalThis.fetch = mock;

    await geocodeDestination("New York, NY");
    const url = String(mock.mock.calls[0][0]);
    expect(url).toContain(`name=${encodeURIComponent("New York, NY")}`);
    expect(url).toContain("count=1");
  });

  it("returns null when there are no results", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ results: [] }))) as any;
    expect(await geocodeDestination("Nowhere XYZ")).toBeNull();
  });

  it("returns null on a non-OK response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("boom", { status: 500 })) as any;
    expect(await geocodeDestination("Munich")).toBeNull();
  });

  it("returns null when fetch throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network down");
    }) as any;
    expect(await geocodeDestination("Munich")).toBeNull();
  });
});

describe("fetchWeatherForDate", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const goodPayload = {
    daily: {
      temperature_2m_max: [72.4],
      temperature_2m_min: [54.6],
      weathercode: [2],
      precipitation_probability_max: [20.2],
    },
  };

  it("maps the first daily entry to a WeatherSnapshot", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(goodPayload))) as any;

    const result = await fetchWeatherForDate(48.1351, 11.582, "2026-09-25", "Europe/Berlin");
    expect(result).toEqual({
      highF: 72,
      lowF: 55,
      condition: "Partly cloudy",
      rainChancePct: 20,
    });
  });

  it("builds the forecast URL with the requested date and timezone", async () => {
    const mock = vi.fn(async () => new Response(JSON.stringify(goodPayload))) as any;
    globalThis.fetch = mock;

    await fetchWeatherForDate(40.7, -74.0, "2026-09-25", "America/New_York");
    const url = String(mock.mock.calls[0][0]);
    expect(url).toContain("latitude=40.7");
    expect(url).toContain("longitude=-74");
    expect(url).toContain("start_date=2026-09-25");
    expect(url).toContain("end_date=2026-09-25");
    expect(url).toContain(`timezone=${encodeURIComponent("America/New_York")}`);
    expect(url).toContain("temperature_unit=fahrenheit");
  });

  it("returns null when fetch throws (timeout or network failure)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as any;
    expect(await fetchWeatherForDate(48.1, 11.5, "2026-09-25", "Europe/Berlin")).toBeNull();
  });

  it("returns null on a non-OK response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("oops", { status: 503 })) as any;
    expect(await fetchWeatherForDate(48.1, 11.5, "2026-09-25", "Europe/Berlin")).toBeNull();
  });

  it("returns null when daily arrays are missing or malformed", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ daily: null }))) as any;
    expect(await fetchWeatherForDate(48.1, 11.5, "2026-09-25", "Europe/Berlin")).toBeNull();
  });

  it("maps an unknown weathercode through without failing", async () => {
    const payload = {
      daily: {
        temperature_2m_max: [70],
        temperature_2m_min: [50],
        weathercode: [123],
        precipitation_probability_max: [0],
      },
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload))) as any;
    const result = await fetchWeatherForDate(48.1, 11.5, "2026-09-25", "Europe/Berlin");
    expect(result?.condition).toBe("—");
  });
});
