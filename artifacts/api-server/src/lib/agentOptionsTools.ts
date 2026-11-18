/**
 * Marco agent — options tools (`options_*`).
 *
 * Thin, typed façades over the Options Service (architecture §5.1):
 * this is how Marco shows REAL priced options — Duffel flights and
 * Duffel Stays today — filtered by the traveler's hard rules and ranked by their tastes,
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
import type {
  FlightSearchContext,
  FlightSummary,
  OptionSet,
  PresentedOption,
  StayOption,
  StaySearchContext,
} from "./options";
import { nightsBetween } from "./options";
import { getDefaultOptionsService } from "./optionsService";
import { DuffelError, OptionsAdapterDisabledError } from "./duffel";
import { geocodeDestination } from "./weather";
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

const SearchStaysInput = z.object({
  location: z.string().min(2, "location is required"),
  checkInDate: z.string().regex(DATE, "checkInDate must be YYYY-MM-DD"),
  checkOutDate: z.string().regex(DATE, "checkOutDate must be YYYY-MM-DD"),
  guests: z.number().int().min(1).max(16).optional(),
  rooms: z.number().int().min(1).max(8).optional(),
  radiusKm: z.number().min(1).max(50).optional(),
  freeCancellationOnly: z.boolean().optional(),
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

function stopsText(s: FlightSummary): string {
  if (s.totalStops === 0) return "nonstop";
  const parts = s.slices.flatMap((slice) =>
    slice.layovers.map((l) => `${l.airport} (${durationText(l.minutes)} layover)`),
  );
  return `${s.totalStops} stop${s.totalStops === 1 ? "" : "s"} via ${parts.join(", ")}`;
}

function formatOption(p: PresentedOption, index: number): string {
  const o = p.option;
  if (o.kind !== "flight") return ""; // flight sets only; stays use formatStayOption
  const s = o.summary;
  const lines: string[] = [];
  const first = s.slices[0];
  const last = s.slices[s.slices.length - 1];
  const roundTrip = s.slices.length > 1 ? " (round trip)" : "";
  lines.push(`${index + 1}. ${s.carrier} — ${stopsText(s)}${roundTrip}`);
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

// ─── Stay formatting (what Marco voices) ─────────────────────────────────────

type PresentedStay = PresentedOption & { option: StayOption };

function isStayPresented(p: PresentedOption): p is PresentedStay {
  return p.option.kind === "stay";
}

function formatStayOption(p: PresentedStay, index: number): string {
  const o = p.option;
  const s = o.summary;
  const lines: string[] = [];
  const typeBits = [
    s.isWholeHome ? "whole home" : s.propertyType,
    s.chainName,
    s.starRating ? `${s.starRating}★` : null,
    s.reviewScore !== null
      ? `guest score ${s.reviewScore}${s.reviewCount !== null ? ` (${s.reviewCount} reviews)` : ""}`
      : null,
  ].filter(Boolean);
  lines.push(`${index + 1}. ${s.propertyName} — ${s.areaLabel}${typeBits.length ? ` · ${typeBits.join(" · ")}` : ""}`);
  const roomBits = [s.roomName, s.beds, s.boardType].filter(Boolean);
  if (roomBits.length > 0) lines.push(`   ${roomBits.join(" · ")}`);
  // THE total: the full stay, for the whole party — never a nightly rate.
  let priceLine = `   Total for ${s.nights} night${s.nights === 1 ? "" : "s"}: ${formatMoney(o.money, "en-US")}`;
  if (o.priceNature !== "firm") priceLine += ` (${o.priceNature} — final price confirmed at quote)`;
  if (o.homeEquivalent) {
    priceLine += ` — ≈ ${formatMoney(o.homeEquivalent.money, "en-US")} in your currency (estimate)`;
  }
  lines.push(priceLine);
  const b = s.breakdown;
  const breakdownBits = [
    b.base ? `rent ${formatMoney(b.base, "en-US")}` : null,
    b.tax ? `taxes ${formatMoney(b.tax, "en-US")}` : null,
    b.fee ? `fees ${formatMoney(b.fee, "en-US")}` : null,
    b.taxesAndFees ? `taxes & fees ${formatMoney(b.taxesAndFees, "en-US")}` : null,
    b.dueAtAccommodation ? `${formatMoney(b.dueAtAccommodation, "en-US")} due at the property` : null,
  ].filter(Boolean);
  if (breakdownBits.length > 0) lines.push(`   ${breakdownBits.join(" · ")}`);
  const derivedBits = [
    s.nightlyRate ? `≈ ${formatMoney(s.nightlyRate, "en-US")} per night` : null,
    s.perPersonPerNight
      ? `≈ ${formatMoney(s.perPersonPerNight, "en-US")} per person per night (${s.guestCount} guests)`
      : null,
  ].filter(Boolean);
  if (derivedBits.length > 0) lines.push(`   ${derivedBits.join(" · ")}`);
  lines.push(
    `   ${s.cancellationTerms ?? "Cancellation terms aren't stated at search time — confirmed when we request the quote."}`,
  );
  if (p.reasons.length > 0) lines.push(`   Why: ${p.reasons.join("; ")}`);
  if (p.against.length > 0) lines.push(`   Trade-offs: ${p.against.join("; ")}`);
  if (p.violations.length > 0) {
    lines.push(`   ⚠ ${p.violations.map((v) => v.message).join(" ")}`);
  }
  if (p.disclosure) lines.push(`   ${p.disclosure}`);
  return lines.join("\n");
}

/**
 * The home-over-hotel SIGNAL (Story 2.3), surfaced honestly at
 * presentation: when the party is a group (≥5 guests) or the stay is
 * long (≥4 nights), whole homes are usually worth comparing against
 * hotel rooms. The note says whether whole-home options actually came
 * back in THIS search — it never pretends a unified cross-type ranking
 * happened; hotels and homes are listed together with full-stay
 * totals, and the judgment call stays visible as a note.
 */
export interface StaySearchSignals {
  /** Group ≥5 or stay ≥4 nights — the signal applies. */
  applies: boolean;
  wholeHomesIncluded: number;
  note: string | null;
}

export function staySearchSignals(ctx: StaySearchContext, set: OptionSet): StaySearchSignals {
  const nights = nightsBetween(ctx.checkInDate, ctx.checkOutDate) ?? 0;
  const applies = ctx.guestCount >= 5 || nights >= 4;
  const wholeHomesIncluded = [...set.options, ...set.casualties].filter(
    (p) => p.option.kind === "stay" && p.option.summary.isWholeHome,
  ).length;
  if (!applies) return { applies, wholeHomesIncluded, note: null };
  const why =
    ctx.guestCount >= 5 && nights >= 4
      ? `a group of ${ctx.guestCount} staying ${nights} nights`
      : ctx.guestCount >= 5
        ? `a group of ${ctx.guestCount}`
        : `a ${nights}-night stay`;
  const note =
    wholeHomesIncluded > 0
      ? `Whole-home note: this list includes ${wholeHomesIncluded} whole-home option${wholeHomesIncluded === 1 ? "" : "s"} — for ${why}, a whole home often beats separate hotel rooms on shared space and per-person cost. Compare the full-stay totals above.`
      : `Whole-home note: no whole-home options came back in this search — for ${why}, a home is often worth comparing. Ask me to widen the search area if you'd like me to look.`;
  return { applies, wholeHomesIncluded, note };
}

export function formatStayOptionSetText(
  set: OptionSet,
  ctx: StaySearchContext,
  locationLabel: string,
): string {
  const guests = `${ctx.guestCount} guest${ctx.guestCount === 1 ? "" : "s"}`;
  const nights = nightsBetween(ctx.checkInDate, ctx.checkOutDate);
  if (set.options.length === 0 && set.casualties.length === 0) {
    if (set.notices.length > 0) {
      return `${set.notices.join(" ")} No prices are shown rather than invented ones.`;
    }
    return `No stays found near ${locationLabel} for ${ctx.checkInDate} → ${ctx.checkOutDate} (${guests}). Try different dates or a wider search area.`;
  }
  const lines: string[] = [];
  const staleNote = set.stale ? " — STALE: these prices are past their freshness window" : "";
  lines.push(
    `Stay options near ${locationLabel}, ${weekday(ctx.checkInDate)} ${ctx.checkInDate} → ${weekday(ctx.checkOutDate)} ${ctx.checkOutDate}` +
      `${nights ? ` (${nights} night${nights === 1 ? "" : "s"})` : ""} (${guests}) — ${set.staleness}${staleNote}:`,
  );
  for (const notice of set.notices) lines.push(notice);
  if (set.relaxed) {
    lines.push(
      "Every option breaks at least one of your rules, so here are the closest matches — each labeled with the rule it breaks:",
    );
  }
  lines.push("");
  set.options
    .filter(isStayPresented)
    .slice(0, MAX_VOICED_OPTIONS)
    .forEach((p, i) => lines.push(formatStayOption(p, i)));
  if (set.options.length > MAX_VOICED_OPTIONS) {
    lines.push(`…and ${set.options.length - MAX_VOICED_OPTIONS} more options.`);
  }
  const signals = staySearchSignals(ctx, set);
  if (signals.note) {
    lines.push("");
    lines.push(signals.note);
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

async function searchStays(
  ctx: ToolContext,
  args: z.infer<typeof SearchStaysInput>,
): Promise<AgentToolResult> {
  logger.info(
    { tool: "options_search_stays", userId: ctx.userId, location: args.location, checkInDate: args.checkInDate },
    "[Agent] tool call",
  );
  if (!nightsBetween(args.checkInDate, args.checkOutDate)) {
    return toolErr(
      `Check-out (${args.checkOutDate}) must be after check-in (${args.checkInDate}). No search was run.`,
    );
  }
  // Duffel searches stays around coordinates; the place name is
  // geocoded with the same Open-Meteo geocoder the weather briefing
  // uses. No geocode → no search → no invented results.
  const geo = await geocodeDestination(args.location);
  if (!geo) {
    return toolOk(
      `I couldn't find a place called "${args.location}" — try a more specific name (for example "Munich, Germany"). No prices are shown rather than invented ones.`,
    );
  }
  const search: StaySearchContext = {
    latitude: geo.lat,
    longitude: geo.lon,
    radiusKm: args.radiusKm ?? 5,
    checkInDate: args.checkInDate,
    checkOutDate: args.checkOutDate,
    guestCount: args.guests ?? 2,
    rooms: args.rooms ?? 1,
    freeCancellationOnly: args.freeCancellationOnly,
  };
  try {
    const set = await getDefaultOptionsService().searchStays(ctx.userId, search, {
      tripScope: args.tripScope,
      refresh: args.refresh,
    });
    return toolOk(formatStayOptionSetText(set, search, args.location), set);
  } catch (err) {
    if (err instanceof OptionsAdapterDisabledError) {
      return toolOk(`${err.message} No prices are shown rather than invented ones.`);
    }
    if (err instanceof DuffelError) {
      logger.warn({ tool: "options_search_stays", userId: ctx.userId, err }, "[Agent] Duffel Stays search failed");
      return toolErr(`Stay search failed: ${err.message} No prices are shown rather than invented ones.`);
    }
    logger.error({ tool: "options_search_stays", userId: ctx.userId, err }, "[Agent] tool error");
    return toolErr("Stay search failed with an internal error. No prices are shown rather than invented ones.");
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
  {
    name: "options_search_stays",
    description:
      "Search LIVE stay prices (Duffel Stays: hotels and whole homes) near a place for dates and a party size: real options " +
      "with FULL-STAY totals (rent + taxes + fees itemized where the supplier states them, any amount due at the property " +
      "flagged), per-night and per-person-per-night figures shown alongside, already filtered by the traveler's hard rules " +
      "(e.g. stay style) and ranked by their tastes. Prices are estimates until a quote confirms them. For a group of 5+ " +
      "or a stay of 4+ nights the output notes whether whole-home options are included, since a home often beats hotel " +
      "rooms there. Each option carries a 'priced at' age — if the traveler asks to refresh, or dates/party changed, call " +
      "again with refresh: true. This tool only SHOWS options — it cannot book anything. If stay search is not configured " +
      "it says so plainly instead of inventing prices.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "Place to stay near — a city or neighborhood name (e.g. \"Munich\", \"Lawrenceville, NJ\")" },
        checkInDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Check-in date as YYYY-MM-DD" },
        checkOutDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Check-out date as YYYY-MM-DD (after check-in)" },
        guests: { type: "integer", minimum: 1, maximum: 16, description: "Number of guests (default 2)" },
        rooms: { type: "integer", minimum: 1, maximum: 8, description: "Number of rooms/units (default 1)" },
        radiusKm: { type: "number", minimum: 1, maximum: 50, description: "Search radius in km around the place (default 5)" },
        freeCancellationOnly: { type: "boolean", description: "Only stays with free cancellation (optional)" },
        tripScope: { type: "string", enum: ["work", "personal"], description: "Whether this stay is for a work or personal trip — decides which scoped rules apply (optional)" },
        refresh: { type: "boolean", description: "True to bypass the price cache and re-price live (traveler asked, or details changed)" },
      },
      required: ["location", "checkInDate", "checkOutDate"],
      additionalProperties: false,
    },
    input: SearchStaysInput,
    run: searchStays as ToolDefinition["run"],
  },
];

export function getOptionsToolDefinition(name: string): ToolDefinition | undefined {
  return OPTIONS_TOOLS.find((t) => t.name === name);
}
