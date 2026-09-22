/**
 * Marco agent — open-world research tools backed by the Google Places API
 * (new, v1 text search).
 *
 * Key comes from GOOGLE_PLACES_API_KEY. When unset, every tool returns a
 * graceful `{ ok: false, text }` — never throws, never 500s the agent loop.
 * The API key is never logged.
 */

import { z } from "zod";
import { logger } from "./logger";
import type { ToolContext, AgentToolResult, ToolDefinition } from "./agentTools";

const PLACES_TEXT_SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";

interface PlacesPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
}

async function textSearch(textQuery: string, maxResultCount: number): Promise<PlacesPlace[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new ResearchUnavailableError("Research is unavailable: GOOGLE_PLACES_API_KEY is not configured.");
  }

  const res = await fetch(PLACES_TEXT_SEARCH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.priceLevel,places.id",
    },
    body: JSON.stringify({ textQuery, maxResultCount }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Places API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { places?: PlacesPlace[] };
  return data.places ?? [];
}

class ResearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchUnavailableError";
  }
}

function formatPlace(p: PlacesPlace): string {
  const name = p.displayName?.text ?? "Unnamed place";
  const bits = [`• ${name}`];
  if (p.rating !== undefined) {
    bits.push(`★ ${p.rating}${p.userRatingCount ? ` (${p.userRatingCount} reviews)` : ""}`);
  }
  if (p.priceLevel) bits.push(p.priceLevel.replace("PRICE_LEVEL_", "").toLowerCase());
  if (p.formattedAddress) bits.push(`— ${p.formattedAddress}`);
  return bits.join(" ");
}

function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return 5;
  return Math.min(10, Math.max(1, Math.floor(limit)));
}

// ─── search_restaurants ───────────────────────────────────────────────────────

const SearchRestaurantsInput = z.object({
  location: z.string().min(1).max(120).describe("City or area to search in, e.g. \"Munich, Germany\""),
  cuisine: z.string().min(1).max(60).optional().describe('Cuisine filter, e.g. "Italian", "Bavarian"'),
  priceLevel: z
    .enum(["inexpensive", "moderate", "expensive", "very_expensive"])
    .optional()
    .describe("Rough price band"),
  limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5, max 10)"),
});

// NOTE: `parameters` is hand-written JSON Schema — keep in sync with
// SearchRestaurantsInput above.

async function searchRestaurants(
  ctx: ToolContext,
  args: z.infer<typeof SearchRestaurantsInput>,
): Promise<AgentToolResult> {
  logger.info(
    { tool: "search_restaurants", userId: ctx.userId, location: args.location, cuisine: args.cuisine },
    "[Agent] tool call",
  );
  try {
    const query = `${args.cuisine ? args.cuisine + " " : ""}restaurants in ${args.location}`;
    let places = await textSearch(query, clampLimit(args.limit));

    // priceLevel in the v1 API is an enum string like "PRICE_LEVEL_MODERATE";
    // filter client-side when the caller asked for a band.
    if (args.priceLevel) {
      const want = `PRICE_LEVEL_${args.priceLevel.toUpperCase()}`;
      places = places.filter((p) => !p.priceLevel || p.priceLevel === want);
    }

    const text =
      places.length === 0
        ? `No restaurants found for "${query}".`
        : `${places.length} restaurant(s) for "${query}":\n` + places.map(formatPlace).join("\n");

    logger.info({ tool: "search_restaurants", userId: ctx.userId, count: places.length, outcome: "ok" }, "[Agent] tool success");
    return { ok: true, text, data: { places } };
  } catch (err) {
    if (err instanceof ResearchUnavailableError) return { ok: false, text: err.message };
    logger.error({ tool: "search_restaurants", userId: ctx.userId, err }, "[Agent] tool error");
    return { ok: false, text: "Restaurant search failed due to an internal error." };
  }
}

// ─── search_activities ────────────────────────────────────────────────────────

const SearchActivitiesInput = z.object({
  location: z.string().min(1).max(120).describe("City or area to search in, e.g. \"Munich, Germany\""),
  query: z.string().min(1).max(120).optional().describe('What to look for, e.g. "museums", "boat tours", "hiking"'),
  limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5, max 10)"),
});

// NOTE: `parameters` is hand-written JSON Schema — keep in sync with
// SearchActivitiesInput above.

async function searchActivities(
  ctx: ToolContext,
  args: z.infer<typeof SearchActivitiesInput>,
): Promise<AgentToolResult> {
  logger.info(
    { tool: "search_activities", userId: ctx.userId, location: args.location, query: args.query },
    "[Agent] tool call",
  );
  try {
    const textQuery = `${args.query ? args.query + " " : "tourist attractions "}in ${args.location}`;
    const places = await textSearch(textQuery, clampLimit(args.limit));

    const text =
      places.length === 0
        ? `No activities found for "${textQuery}".`
        : `${places.length} activit${places.length === 1 ? "y" : "ies"} for "${textQuery}":\n` +
          places.map(formatPlace).join("\n");

    logger.info({ tool: "search_activities", userId: ctx.userId, count: places.length, outcome: "ok" }, "[Agent] tool success");
    return { ok: true, text, data: { places } };
  } catch (err) {
    if (err instanceof ResearchUnavailableError) return { ok: false, text: err.message };
    logger.error({ tool: "search_activities", userId: ctx.userId, err }, "[Agent] tool error");
    return { ok: false, text: "Activity search failed due to an internal error." };
  }
}

// ─── search_events ────────────────────────────────────────────────────────────

const SearchEventsInput = z.object({
  location: z.string().min(1).max(120).describe("City or area to search in, e.g. \"Munich, Germany\""),
  query: z.string().min(1).max(120).optional().describe('What to look for, e.g. "concerts", "festivals this weekend"'),
  limit: z.number().int().min(1).max(10).optional().describe("Max results (default 5, max 10)"),
});

// NOTE: `parameters` is hand-written JSON Schema — keep in sync with
// SearchEventsInput above.

async function searchEvents(
  ctx: ToolContext,
  args: z.infer<typeof SearchEventsInput>,
): Promise<AgentToolResult> {
  logger.info(
    { tool: "search_events", userId: ctx.userId, location: args.location, query: args.query },
    "[Agent] tool call",
  );
  try {
    const textQuery = `events in ${args.location}${args.query ? " " + args.query : ""}`;
    const places = await textSearch(textQuery, clampLimit(args.limit));

    const text =
      places.length === 0
        ? `No events found for "${textQuery}".`
        : `${places.length} event result(s) for "${textQuery}":\n` + places.map(formatPlace).join("\n");

    logger.info({ tool: "search_events", userId: ctx.userId, count: places.length, outcome: "ok" }, "[Agent] tool success");
    return { ok: true, text, data: { places } };
  } catch (err) {
    if (err instanceof ResearchUnavailableError) return { ok: false, text: err.message };
    logger.error({ tool: "search_events", userId: ctx.userId, err }, "[Agent] tool error");
    return { ok: false, text: "Event search failed due to an internal error." };
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

export const AGENT_RESEARCH_TOOLS: ToolDefinition[] = [
  {
    name: "search_restaurants",
    description:
      "Search Google Places for restaurants in a location, optionally filtered by " +
      "cuisine and price band. Returns names, ratings, review counts, and addresses. " +
      "Use when the traveler wants dining ideas outside the current itinerary. " +
      "Requires GOOGLE_PLACES_API_KEY on the server; returns a graceful message when unset.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: 'City or area to search in, e.g. "Munich, Germany"' },
        cuisine: { type: "string", description: 'Cuisine filter, e.g. "Italian", "Bavarian"' },
        priceLevel: {
          type: "string",
          enum: ["inexpensive", "moderate", "expensive", "very_expensive"],
          description: "Rough price band",
        },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Max results (default 5, max 10)" },
      },
      required: ["location"],
      additionalProperties: false,
    },
    input: SearchRestaurantsInput,
    run: searchRestaurants as ToolDefinition["run"],
  },
  {
    name: "search_activities",
    description:
      "Search Google Places for tourist attractions and activities in a location, " +
      "optionally narrowed by a query like \"museums\" or \"boat tours\". " +
      "Use when the traveler wants ideas for things to do. " +
      "Requires GOOGLE_PLACES_API_KEY on the server; returns a graceful message when unset.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: 'City or area to search in, e.g. "Munich, Germany"' },
        query: { type: "string", description: 'What to look for, e.g. "museums", "boat tours", "hiking"' },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Max results (default 5, max 10)" },
      },
      required: ["location"],
      additionalProperties: false,
    },
    input: SearchActivitiesInput,
    run: searchActivities as ToolDefinition["run"],
  },
  {
    name: "search_events",
    description:
      "Best-effort search for events (concerts, festivals, shows) in a location via " +
      "Google Places text search. Coverage is approximate — say so if results look " +
      "thin. Requires GOOGLE_PLACES_API_KEY on the server; returns a graceful message when unset.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: 'City or area to search in, e.g. "Munich, Germany"' },
        query: { type: "string", description: 'What to look for, e.g. "concerts", "festivals this weekend"' },
        limit: { type: "integer", minimum: 1, maximum: 10, description: "Max results (default 5, max 10)" },
      },
      required: ["location"],
      additionalProperties: false,
    },
    input: SearchEventsInput,
    run: searchEvents as ToolDefinition["run"],
  },
];
