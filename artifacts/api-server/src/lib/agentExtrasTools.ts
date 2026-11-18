/**
 * Marco agent — extras tools (`extras_*`).
 *
 * Thin, typed façades over the Extras Service (architecture §7): this
 * is how Marco surfaces the extras pass — the small things a human
 * planner thinks of (ship the clubs, lift passes, eSIMs, cribs) —
 * as priced suggestions. Presentation + intent only: accepting a
 * suggestion records that the traveler wants it arranged; NOTHING
 * here books, buys, or charges — arranging rides the Booking Gate /
 * Concierge.
 *
 * Same conventions as agentOptionsTools.ts: zod input + hand-written
 * JSON Schema parameters, structured [Agent] logs, { ok, text, data? }
 * results. Access is asserted inside the service against the caller's
 * identity from ToolContext.
 *
 * Family Budget framing (§7 / TC-8): at that tier every suggestion is
 * voiced as a clearly-priced OPT-IN (never as included by default) and
 * the running extras total is reported against the trip's budget cap.
 */

import { z } from "zod";
import { formatMoney } from "@workspace/money";
import type { ExtrasSuggestion } from "@workspace/db";
import type { AgentToolResult, ToolContext, ToolDefinition } from "./agentTools";
import {
  ExtrasAccessDenied,
  ExtrasNotFound,
  listExtrasSuggestions,
  runExtrasPass,
  setExtrasSuggestionState,
  type ExtrasPassResult,
} from "./extras";
import { logger } from "./logger";

function toolOk(text: string, data?: unknown): AgentToolResult {
  return { ok: true, text, data };
}

function toolErr(text: string, data?: unknown): AgentToolResult {
  return { ok: false, text, data };
}

// ─── Input ───────────────────────────────────────────────────────────────────

const GetSuggestionsInput = z.object({
  tripId: z.number().int().positive(),
});

const SetStateInput = z.object({
  suggestionId: z.number().int().positive(),
  state: z.enum(["accepted", "dismissed"]),
});

// ─── Formatting (what Marco voices) ──────────────────────────────────────────

function priceText(s: ExtrasSuggestion): string {
  if (s.priceNature === "quote") return "quote needed — no price until a supplier quotes it";
  if (s.priceAmountMinor !== null && s.priceCurrency) {
    const amount = formatMoney({ amountMinor: s.priceAmountMinor, currency: s.priceCurrency }, "en-US");
    return s.priceNature === "estimate" ? `estimated ${amount}` : amount;
  }
  return "no charge — a check Wander runs";
}

export function formatSuggestionLine(s: ExtrasSuggestion, index: number): string {
  const stateNote = s.state === "accepted" ? " [you said yes — arranging comes next]" : "";
  return `${index + 1}. ${s.title} — ${priceText(s)}${stateNote}\n   ${s.detail}`;
}

export function formatExtrasPassText(result: ExtrasPassResult): string {
  const active = result.suggestions.filter((s) => s.state !== "dismissed");
  if (result.packsMatched.length === 0) {
    return "No extras pass applies to this trip — its character doesn't match a known extras pack (golf, ski, beach, family, international, festival). Nothing was suggested.";
  }
  if (active.length === 0) {
    return `The extras pass ran (${result.packsMatched.join(", ")}) and everything it surfaced has been dismissed. Dismissed items stay dismissed — they won't be suggested again.`;
  }
  const lines: string[] = [];
  const budget = result.tier === "family_budget";
  if (budget) {
    lines.push(
      "Optional extras for this trip — these are opt-ins, NOT included in the plan or the budget unless you say yes:",
    );
  } else {
    lines.push(`Extras worth thinking about (${result.packsMatched.join(", ")}):`);
  }
  if (result.created.length > 0) {
    lines.push(`(${result.created.length} new this pass.)`);
  }
  lines.push("");
  active.forEach((s, i) => lines.push(formatSuggestionLine(s, i)));
  if (result.budgetReport) {
    const r = result.budgetReport;
    const cap = formatMoney({ amountMinor: r.cap.amountMinor, currency: r.cap.currency }, "en-US");
    const total = formatMoney({ amountMinor: r.pricedTotalMinor, currency: r.cap.currency }, "en-US");
    lines.push("");
    lines.push(
      `Extras total so far: ${total} of your ${cap} budget cap` +
        (r.overCap ? " — OVER the cap on priced items alone." : ` (${formatMoney({ amountMinor: r.remainingMinor, currency: r.cap.currency }, "en-US")} of room left).`) +
        (r.unpricedItemCount > 0
          ? ` ${r.unpricedItemCount} item${r.unpricedItemCount === 1 ? "" : "s"} still need${r.unpricedItemCount === 1 ? "s" : ""} a quote and aren't counted in that total.`
          : ""),
    );
  }
  lines.push("");
  lines.push("Nothing here is booked — say yes to an item and Wander arranges it with you; say no and it won't come up again.");
  return lines.join("\n");
}

// ─── Tool runs ───────────────────────────────────────────────────────────────

async function getSuggestions(
  ctx: ToolContext,
  args: z.infer<typeof GetSuggestionsInput>,
): Promise<AgentToolResult> {
  logger.info({ tool: "extras_get_suggestions", userId: ctx.userId, tripId: args.tripId }, "[Agent] tool call");
  try {
    // Access first (list asserts it), then the on-demand pass.
    await listExtrasSuggestions(args.tripId, ctx.userId, ctx.role);
    const result = await runExtrasPass(args.tripId, "on_demand");
    if (!result) return toolErr(`Trip ${args.tripId} not found.`);
    return toolOk(formatExtrasPassText(result), result);
  } catch (err) {
    if (err instanceof ExtrasAccessDenied) return toolErr(err.message);
    logger.error({ tool: "extras_get_suggestions", userId: ctx.userId, err }, "[Agent] tool error");
    return toolErr("The extras pass failed with an internal error. No suggestions were changed.");
  }
}

async function setState(
  ctx: ToolContext,
  args: z.infer<typeof SetStateInput>,
): Promise<AgentToolResult> {
  logger.info(
    { tool: "extras_set_suggestion_state", userId: ctx.userId, suggestionId: args.suggestionId, state: args.state },
    "[Agent] tool call",
  );
  try {
    const row = await setExtrasSuggestionState(args.suggestionId, ctx.userId, ctx.role, args.state);
    return toolOk(
      args.state === "accepted"
        ? `"${row.title}" marked as wanted. It is NOT booked — Wander will arrange it with you through the normal confirm-first flow.`
        : `"${row.title}" dismissed. It won't be suggested again for this trip.`,
      row,
    );
  } catch (err) {
    if (err instanceof ExtrasAccessDenied) return toolErr(err.message);
    if (err instanceof ExtrasNotFound) return toolErr(err.message);
    logger.error({ tool: "extras_set_suggestion_state", userId: ctx.userId, err }, "[Agent] tool error");
    return toolErr("Updating that suggestion failed with an internal error.");
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

export const EXTRAS_TOOLS: ToolDefinition[] = [
  {
    name: "extras_get_suggestions",
    description:
      "Run the extras pass for a trip and show its suggestions: the small things a human planner thinks of, keyed to the trip's character " +
      "(golf: ship your clubs with ship/rent/check math; ski: gear, lift passes, lessons; beach: cabana, boat day, grocery pre-stocking for homes; " +
      "family: crib, car seats, kid pricing; international: entry requirements, eSIM, adapters; festival: skip-the-line, transfers). " +
      "Suggestions are priced honestly — estimates are labeled with their basis, quote-only items show no number. At Family Budget they are framed " +
      "as opt-ins with the running total against the budget cap. Nothing is booked by this tool. Dismissed items never reappear.",
    parameters: {
      type: "object",
      properties: {
        tripId: { type: "integer", minimum: 1, description: "The trip to run the extras pass for" },
      },
      required: ["tripId"],
      additionalProperties: false,
    },
    input: GetSuggestionsInput,
    run: getSuggestions as ToolDefinition["run"],
  },
  {
    name: "extras_set_suggestion_state",
    description:
      "Record the traveler's yes/no on one extras suggestion. 'accepted' means they want it arranged (it is NOT booked by this — arranging follows " +
      "the confirm-first flow); 'dismissed' removes it permanently for this trip — the extras pass will never suggest it again.",
    parameters: {
      type: "object",
      properties: {
        suggestionId: { type: "integer", minimum: 1, description: "The suggestion's id (from extras_get_suggestions data)" },
        state: { type: "string", enum: ["accepted", "dismissed"], description: "The traveler's answer" },
      },
      required: ["suggestionId", "state"],
      additionalProperties: false,
    },
    input: SetStateInput,
    run: setState as ToolDefinition["run"],
  },
];

export function getExtrasToolDefinition(name: string): ToolDefinition | undefined {
  return EXTRAS_TOOLS.find((t) => t.name === name);
}
