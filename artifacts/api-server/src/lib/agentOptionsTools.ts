/**
 * Marco agent — options tools (`options_*`).
 *
 * Thin, typed façades over the Options Service (architecture §5.1):
 * this is how Marco shows REAL priced options — Duffel flights today —
 * filtered by the traveler's hard rules and ranked by their tastes,
 * with every price carrying its priced-at age. Presentation only:
 * there is deliberately NO booking tool here (the gate is January);
 * Marco can show options and their totals, never commit money.
 *
 * Same conventions as agentContextTools.ts: zod input + hand-written
 * JSON Schema parameters, structured [Agent] logs, { ok, text, data? }
 * results. Identity comes from the ToolContext (auth-derived) — the
 * traveler's rules and home currency are loaded for the CALLER; no
 * argument can aim the search at anyone else's profile.
 */

import { z } from "zod";
import { formatMoney } from "@workspace/money";
import type { AgentToolResult, ToolContext, ToolDefinition } from "./agentTools";
import type { FlightSearchContext, OptionSet, PresentedOption } from "./options";
import { getDefaultOptionsService } from "./optionsService";
import { DuffelError, OptionsAdapterDisabledError } from "./duffel";
import { logger } from "./logger";

function toolOk(text: string, data?: unknown): AgentToolResult {
  return { ok: true, text, data };
}

function toolErr(text: string, data?: unknown): AgentToolResult {
  return { ok: false, text, data };
}

// ─── Input ───────────────────────────────────────────────────────────────────

const IATA = /^[A-Za-z]{3}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const SearchFlightsInput = z.object({
  origin: z.string().regex(IATA, "origin must be a 3-letter IATA code"),
  destination: z.string().regex(IATA, "destination must be a 3-letter IATA code"),
  departureDate: z.string().regex(DATE, "departureDate must be YYYY-MM-DD"),
  returnDate: z.string().regex(DATE, "returnDate must be YYYY-MM-DD").optional(),
  passengers: z.number().int().min(1).max(9).optional(),
  cabinClass: z.enum(["economy", "premium_economy", "business", "first"]).optional(),
  maxConnections: z.number().int().min(0).max(2).optional(),
  tripScope: z.enum(["work", "personal"]).optional(),
  refresh: z.boolean().optional(),
});

// ─── Formatting (what Marco voices) ──────────────────────────────────────────

const MAX_VOICED_OPTIONS = 8;

function timePart(iso: string): string {
  // "2026-09-23T17:00:00-04:00" → "17:00"; naive local times pass through.
  return iso.slice(11, 16) || iso;
}

function datePart(iso: string): string {
  return iso.slice(0, 10);
}

function dayOffset(departIso: string, arriveIso: string): number {
  const d = Date.parse(`${datePart(departIso)}T00:00:00Z`);
  const a = Date.parse(`${datePart(arriveIso)}T00:00:00Z`);
  if (Number.isNaN(d) || Number.isNaN(a)) return 0;
  return Math.round((a - d) / 86400000);
}

function weekday(dateText: string): string {
  const d = new Date(`${dateText}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
}

function durationText(minutes: number | null): string {
  if (minutes === null) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : `${h} h ${String(m).padStart(2, "0")} min`;
}

function stopsText(p: PresentedOption): string {
  const s = p.option.summary;
  if (s.totalStops === 0) return "nonstop";
  const parts = s.slices.flatMap((slice) =>
    slice.layovers.map((l) => `${l.airport} (${durationText(l.minutes)} layover)`),
  );
  return `${s.totalStops} stop${s.totalStops === 1 ? "" : "s"} via ${parts.join(", ")}`;
}

function formatOption(p: PresentedOption, index: number): string {
  const o = p.option;
  const s = o.summary;
  const lines: string[] = [];
  const first = s.slices[0];
  const last = s.slices[s.slices.length - 1];
  const roundTrip = s.slices.length > 1 ? " (round trip)" : "";
  lines.push(`${index + 1}. ${s.carrier} — ${stopsText(p)}${roundTrip}`);
  if (first && last) {
    const offset = dayOffset(first.departAt, last.arriveAt);
    lines.push(
      `   ${weekday(datePart(first.departAt))} ${datePart(first.departAt)} ${timePart(first.departAt)} ${first.origin} → ` +
        `${timePart(last.arriveAt)} ${last.destination}${offset > 0 ? ` (+${offset} day${offset === 1 ? "" : "s"})` : ""}` +
        (s.totalDurationMinutes !== null ? ` · ${durationText(s.totalDurationMinutes)}` : ""),
    );
  }
  const flightNumbers = s.slices.flatMap((sl) => sl.flightNumbers).join(", ");
  const fareBits = [
    flightNumbers,
    s.fareClass ?? s.cabinClass ?? null,
    s.changeable === true ? "changeable" : s.changeable === false ? "not changeable" : null,
    s.refundable === true ? "refundable" : null,
  ].filter(Boolean);
  if (fareBits.length > 0) lines.push(`   ${fareBits.join(" · ")}`);
  let priceLine = `   Total: ${formatMoney(o.money, "en-US")}`;
  if (o.priceNature !== "firm") priceLine += ` (${o.priceNature})`;
  if (o.homeEquivalent) {
    priceLine += ` — ≈ ${formatMoney(o.homeEquivalent.money, "en-US")} in your currency (estimate)`;
  }
  lines.push(priceLine);
  if (p.reasons.length > 0) lines.push(`   Why: ${p.reasons.join("; ")}`);
  if (p.against.length > 0) lines.push(`   Trade-offs: ${p.against.join("; ")}`);
  if (p.violations.length > 0) {
    lines.push(`   ⚠ ${p.violations.map((v) => v.message).join(" ")}`);
  }
  if (p.disclosure) lines.push(`   ${p.disclosure}`);
  return lines.join("\n");
}

export function formatOptionSetText(set: OptionSet, ctx: FlightSearchContext): string {
  const route = `${ctx.origin.toUpperCase()} → ${ctx.destination.toUpperCase()}`;
  const pax = `${ctx.passengerCount} adult${ctx.passengerCount === 1 ? "" : "s"}`;
  if (set.options.length === 0 && set.casualties.length === 0) {
    if (set.notices.length > 0) {
      return `${set.notices.join(" ")} No prices are shown rather than invented ones.`;
    }
    return `No flights found for ${route} on ${ctx.departureDate} (${pax}). Try different dates or airports.`;
  }
  const lines: string[] = [];
  const staleNote = set.stale ? " — STALE: these prices are past their freshness window" : "";
  lines.push(
    `Flight options ${route}, departing ${ctx.departureDate}${ctx.returnDate ? `, returning ${ctx.returnDate}` : ""} (${pax}) — ${set.staleness}${staleNote}:`,
  );
  for (const notice of set.notices) lines.push(notice);
  if (set.relaxed) {
    lines.push(
      "Every option breaks at least one of your rules, so here are the closest matches — each labeled with the rule it breaks:",
    );
  }
  lines.push("");
  set.options.slice(0, MAX_VOICED_OPTIONS).forEach((p, i) => lines.push(formatOption(p, i)));
  if (set.options.length > MAX_VOICED_OPTIONS) {
    lines.push(`…and ${set.options.length - MAX_VOICED_OPTIONS} more options.`);
  }
  if (set.casualties.length > 0) {
    lines.push("");
    lines.push("Not shown — excluded by your rules:");
    for (const c of set.casualties) {
      lines.push(`- ${c.option.summary.label} — ${c.violations.map((v) => v.message).join(" ")}`);
    }
  }
  return lines.join("\n");
}

// ─── Tool run ────────────────────────────────────────────────────────────────

async function searchFlights(
  ctx: ToolContext,
  args: z.infer<typeof SearchFlightsInput>,
): Promise<AgentToolResult> {
  logger.info(
    { tool: "options_search_flights", userId: ctx.userId, origin: args.origin, destination: args.destination },
    "[Agent] tool call",
  );
  const search: FlightSearchContext = {
    origin: args.origin.toUpperCase(),
    destination: args.destination.toUpperCase(),
    departureDate: args.departureDate,
    returnDate: args.returnDate,
    passengerCount: args.passengers ?? 1,
    cabinClass: args.cabinClass,
    maxConnections: args.maxConnections,
  };
  try {
    const set = await getDefaultOptionsService().searchFlights(ctx.userId, search, {
      tripScope: args.tripScope,
      refresh: args.refresh,
    });
    return toolOk(formatOptionSetText(set, search), set);
  } catch (err) {
    if (err instanceof OptionsAdapterDisabledError) {
      return toolOk(`${err.message} No prices are shown rather than invented ones.`);
    }
    if (err instanceof DuffelError) {
      logger.warn({ tool: "options_search_flights", userId: ctx.userId, err }, "[Agent] Duffel search failed");
      return toolErr(`Flight search failed: ${err.message} No prices are shown rather than invented ones.`);
    }
    logger.error({ tool: "options_search_flights", userId: ctx.userId, err }, "[Agent] tool error");
    return toolErr("Flight search failed with an internal error. No prices are shown rather than invented ones.");
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

export const OPTIONS_TOOLS: ToolDefinition[] = [
  {
    name: "options_search_flights",
    description:
      "Search LIVE flight prices (Duffel) for a leg: real bookable options with full totals for the whole party, " +
      "already filtered by the traveler's hard rules (e.g. never Basic Economy) and ranked by their tastes. " +
      "Each option carries a 'priced at' age — if the traveler asks to refresh, or dates/party changed, call again " +
      "with refresh: true. Options that break a hard rule are reported as exclusions with the rule they broke; " +
      "if every option breaks a rule, the closest matches come back labeled. This tool only SHOWS options — " +
      "it cannot book anything. If flight search is not configured it says so plainly instead of inventing prices.",
    parameters: {
      type: "object",
      properties: {
        origin: { type: "string", pattern: "^[A-Za-z]{3}$", description: "Departure airport IATA code (e.g. EWR)" },
        destination: { type: "string", pattern: "^[A-Za-z]{3}$", description: "Arrival airport IATA code (e.g. MUC)" },
        departureDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Departure date as YYYY-MM-DD" },
        returnDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Return date as YYYY-MM-DD for a round trip (optional)" },
        passengers: { type: "integer", minimum: 1, maximum: 9, description: "Number of adults (default 1)" },
        cabinClass: { type: "string", enum: ["economy", "premium_economy", "business", "first"], description: "Cabin to search (optional)" },
        maxConnections: { type: "integer", minimum: 0, maximum: 2, description: "Maximum connections per slice (optional; 0 = nonstop only)" },
        tripScope: { type: "string", enum: ["work", "personal"], description: "Whether this leg is for a work or personal trip — decides which scoped rules apply (optional)" },
        refresh: { type: "boolean", description: "True to bypass the price cache and re-price live (traveler asked, or details changed)" },
      },
      required: ["origin", "destination", "departureDate"],
      additionalProperties: false,
    },
    input: SearchFlightsInput,
    run: searchFlights as ToolDefinition["run"],
  },
];

export function getOptionsToolDefinition(name: string): ToolDefinition | undefined {
  return OPTIONS_TOOLS.find((t) => t.name === name);
}
