/**
 * Marco agent — context tools (`context_*`).
 *
 * Thin, typed façades over the Context/Profile service (architecture
 * §4): this is how a traveler TEACHES Wander conversationally — home
 * base, home airports, hard rules, tastes, companions, saved groups —
 * and how Marco reads that knowledge back. Offered in BOTH chat scopes
 * (intake and trip): what Wander knows about the traveler is not
 * trip-shaped.
 *
 * Same conventions as agentIntakeTools.ts: zod input + hand-written
 * JSON Schema parameters, structured [Agent] logs, { ok, text, data? }
 * results. Identity comes from the ToolContext (auth-derived), never
 * from tool arguments — there is no userId parameter to aim at anyone
 * else's context.
 */

import { z } from "zod";
import type { AgentToolResult, ToolContext, ToolDefinition } from "./agentTools";
import {
  ContextValidationError,
  addCompanion,
  addRule,
  confirmLearnedHome,
  createSavedGroup,
  deactivateRule,
  listCompanions,
  listRules,
  listSavedGroups,
  loadContextDigest,
  ruleRowToInput,
  setHomeAirports,
  setHomeBase,
} from "./travelerContext";
import { RuleValidationError, describeRule } from "./rulesEngine";
import { logger } from "./logger";

function toolOk(text: string, data?: unknown): AgentToolResult {
  return { ok: true, text, data };
}

function toolErr(text: string, data?: unknown): AgentToolResult {
  return { ok: false, text, data };
}

async function withUser(
  tool: string,
  ctx: ToolContext,
  run: () => Promise<AgentToolResult>,
): Promise<AgentToolResult> {
  logger.info({ tool, userId: ctx.userId }, "[Agent] tool call");
  try {
    return await run();
  } catch (err) {
    if (err instanceof ContextValidationError) return toolErr(err.message);
    if (err instanceof RuleValidationError) return toolErr(err.message);
    logger.error({ tool, userId: ctx.userId, err }, "[Agent] tool error");
    return toolErr(`Tool ${tool} failed: internal error.`);
  }
}

// ─── context_get ─────────────────────────────────────────────────────────────

const GetInput = z.object({});

async function getContext(ctx: ToolContext): Promise<AgentToolResult> {
  return withUser("context_get", ctx, async () => {
    const digest = await loadContextDigest(ctx.userId);
    const lines: string[] = ["What Wander knows about this traveler:"];
    lines.push(
      digest.homeBase
        ? `Home base: ${digest.homeBase.text}${digest.homeAirports.length > 0 ? ` — usually flies out of ${digest.homeAirports.join(", ")}` : ""}`
        : "Home base: not known yet",
    );
    if (digest.proposedHomeBase) {
      lines.push(`Proposed (learned, NOT confirmed — do not treat as default): home base ${digest.proposedHomeBase}`);
    }
    if (digest.proposedHomeAirports.length > 0) {
      lines.push(`Proposed (learned, NOT confirmed): airports ${digest.proposedHomeAirports.join(", ")}`);
    }
    lines.push(
      digest.hardRules.length > 0
        ? `Hard rules: ${digest.hardRules.map(describeRule).join("; ")}`
        : "Hard rules: none",
    );
    lines.push(
      digest.preferences.length > 0
        ? `Tastes: ${digest.preferences.map(describeRule).join("; ")}`
        : "Tastes: none recorded",
    );
    lines.push(
      digest.groups.length > 0
        ? `Saved groups: ${digest.groups
            .map((g) => `"${g.name}" (group ${g.id}): ${g.members.map((m) => m.name).join(", ")}`)
            .join("; ")}`
        : "Saved groups: none",
    );
    lines.push(
      digest.companions.length > 0
        ? `Companions: ${digest.companions.map((c) => `${c.name} (companion ${c.id})`).join(", ")}`
        : "Companions: none recorded",
    );
    return toolOk(lines.join("\n"), digest);
  });
}

// ─── context_set_home_base / context_set_home_airports ───────────────────────

const SetHomeBaseInput = z.object({
  text: z.string().min(1).describe("The traveler's home base as they state it ('Lawrenceville, NJ')"),
  lat: z.number().optional().describe("Latitude, when known"),
  lon: z.number().optional().describe("Longitude, when known"),
});

async function setHomeBaseTool(
  ctx: ToolContext,
  args: z.infer<typeof SetHomeBaseInput>,
): Promise<AgentToolResult> {
  return withUser("context_set_home_base", ctx, async () => {
    // A value stated in conversation is explicit — born confirmed.
    const row = await setHomeBase(ctx.userId, {
      text: args.text,
      lat: args.lat ?? null,
      lon: args.lon ?? null,
      source: "explicit",
    });
    return toolOk(`Home base recorded: ${row.homeBase}. It is now the traveler's default starting point.`, row);
  });
}

const SetHomeAirportsInput = z.object({
  airports: z
    .array(z.string().length(3))
    .min(1)
    .describe("Ordered IATA codes, most-preferred departure airport first (e.g. ['EWR', 'PHL'])"),
});

async function setHomeAirportsTool(
  ctx: ToolContext,
  args: z.infer<typeof SetHomeAirportsInput>,
): Promise<AgentToolResult> {
  return withUser("context_set_home_airports", ctx, async () => {
    const row = await setHomeAirports(ctx.userId, args.airports, "explicit");
    return toolOk(`Home airports recorded: ${row.homeAirports.join(", ")} (in preference order).`, row);
  });
}

// ─── context_confirm_learned ─────────────────────────────────────────────────

const ConfirmLearnedInput = z.object({});

async function confirmLearned(ctx: ToolContext): Promise<AgentToolResult> {
  return withUser("context_confirm_learned", ctx, async () => {
    const row = await confirmLearnedHome(ctx.userId);
    if (!row) return toolOk("No learned home values are waiting for confirmation.");
    const confirmed: string[] = [];
    if (row.homeBase && row.homeBaseConfirmed) confirmed.push(`home base ${row.homeBase}`);
    if (row.homeAirports.length > 0 && row.homeAirportsConfirmed) {
      confirmed.push(`airports ${row.homeAirports.join(", ")}`);
    }
    return toolOk(
      confirmed.length > 0
        ? `Confirmed as the traveler's defaults: ${confirmed.join("; ")}.`
        : "No learned home values were pending confirmation.",
      row,
    );
  });
}

// ─── context_add_rule / context_list_rules / context_deactivate_rule ─────────

const AddRuleInput = z.object({
  ruleClass: z.enum(["hard", "preference"]).describe("'hard' = never violated silently; 'preference' = a weighted taste"),
  ruleType: z
    .enum([
      "fare_class_ban",
      "changeability_required",
      "connection_airport_ban",
      "booking_channel_required",
      "rideshare_profile",
      "budget_cap",
      "stay_style",
      "seat_preference",
    ])
    .describe("The typed rule kind"),
  params: z
    .record(z.string(), z.unknown())
    .describe(
      "Type-specific parameters: fare_class_ban {banned: string[]}; changeability_required {}; " +
        "connection_airport_ban {airport: 'MIA'}; booking_channel_required {channel: 'Egencia'}; " +
        "rideshare_profile {profile: 'Business'}; budget_cap {capMinor: number, currency: 'USD'}; " +
        "stay_style {style: 'boutique'}; seat_preference {seat: 'aisle'}",
    ),
  scope: z
    .enum(["all", "work", "personal"])
    .optional()
    .describe("Which trips the rule binds to (default 'all'; work rules like Egencia use 'work')"),
});

async function addRuleTool(ctx: ToolContext, args: z.infer<typeof AddRuleInput>): Promise<AgentToolResult> {
  return withUser("context_add_rule", ctx, async () => {
    const row = await addRule(ctx.userId, {
      ruleClass: args.ruleClass,
      ruleType: args.ruleType,
      params: args.params,
      scope: args.scope ?? "all",
      source: "explicit",
    });
    const input = ruleRowToInput(row);
    return toolOk(
      `Rule recorded (#${row.id}, ${args.ruleClass}, ${args.scope ?? "all"} trips): ${describeRule(input)}.`,
      row,
    );
  });
}

const ListRulesInput = z.object({});

async function listRulesTool(ctx: ToolContext): Promise<AgentToolResult> {
  return withUser("context_list_rules", ctx, async () => {
    const rows = await listRules(ctx.userId);
    if (rows.length === 0) return toolOk("The traveler has no active rules or tastes recorded.");
    const lines = rows.map((r) => {
      const input = ruleRowToInput(r);
      const bits = [`#${r.id}`, r.ruleClass, r.scope !== "all" ? `${r.scope} trips` : null, describeRule(input)];
      return bits.filter(Boolean).join(" — ");
    });
    return toolOk(["Traveler's active rules and tastes:", ...lines].join("\n"), rows);
  });
}

const DeactivateRuleInput = z.object({
  ruleId: z.number().int().positive().describe("The rule id (from context_list_rules)"),
});

async function deactivateRuleTool(
  ctx: ToolContext,
  args: z.infer<typeof DeactivateRuleInput>,
): Promise<AgentToolResult> {
  return withUser("context_deactivate_rule", ctx, async () => {
    const done = await deactivateRule(ctx.userId, args.ruleId);
    if (!done) return toolErr(`Rule #${args.ruleId} was not found among the traveler's rules.`);
    return toolOk(`Rule #${args.ruleId} deactivated — it no longer filters or ranks anything.`);
  });
}

// ─── context_add_companion / context_list_companions ─────────────────────────

const AddCompanionInput = z.object({
  name: z.string().min(1).describe("Companion's name, as the organizer gives it"),
  email: z.string().optional().describe("Companion's email, when the organizer provides it"),
});

async function addCompanionTool(
  ctx: ToolContext,
  args: z.infer<typeof AddCompanionInput>,
): Promise<AgentToolResult> {
  return withUser("context_add_companion", ctx, async () => {
    const row = await addCompanion(ctx.userId, { name: args.name, email: args.email });
    return toolOk(
      `Companion recorded: ${row.name} (companion ${row.id})${row.email ? ` — ${row.email}` : ""}.`,
      row,
    );
  });
}

const ListCompanionsInput = z.object({});

async function listCompanionsTool(ctx: ToolContext): Promise<AgentToolResult> {
  return withUser("context_list_companions", ctx, async () => {
    const rows = await listCompanions(ctx.userId);
    if (rows.length === 0) return toolOk("No companions recorded yet.");
    const lines = rows.map(
      (c) => `${c.name} (companion ${c.id})${c.email ? ` — ${c.email}` : " — no email on file"}`,
    );
    return toolOk(["Companions:", ...lines].join("\n"), rows);
  });
}

// ─── context_save_group / context_list_groups ────────────────────────────────

const SaveGroupInput = z.object({
  name: z.string().min(1).describe("The group's name ('Munich guys')"),
  companionIds: z
    .array(z.number().int().positive())
    .min(1)
    .describe("Companion ids (from context_list_companions) that make up the group"),
});

async function saveGroupTool(ctx: ToolContext, args: z.infer<typeof SaveGroupInput>): Promise<AgentToolResult> {
  return withUser("context_save_group", ctx, async () => {
    const view = await createSavedGroup(ctx.userId, {
      name: args.name,
      companionIds: args.companionIds,
    });
    return toolOk(
      `Saved group "${view.name}" (group ${view.id}): ${view.members.map((m) => m.name).join(", ")}. ` +
        `It can now fill an intake's party in one step.`,
      view,
    );
  });
}

const ListGroupsInput = z.object({});

async function listGroupsTool(ctx: ToolContext): Promise<AgentToolResult> {
  return withUser("context_list_groups", ctx, async () => {
    const groups = await listSavedGroups(ctx.userId);
    if (groups.length === 0) return toolOk("No saved groups yet.");
    const lines = groups.map(
      (g) => `"${g.name}" (group ${g.id}): ${g.members.map((m) => m.name).join(", ")}`,
    );
    return toolOk(["Saved groups:", ...lines].join("\n"), groups);
  });
}

// ─── Registration ────────────────────────────────────────────────────────────

export const CONTEXT_TOOLS: ToolDefinition[] = [
  {
    name: "context_get",
    description:
      "Get everything Wander knows about this traveler: home base and airports (confirmed values, plus any " +
      "unconfirmed learned proposals), hard rules, tastes, companions, and saved groups. Call this when you " +
      "need to state an assumption or check what is already known before asking.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    input: GetInput,
    run: getContext as ToolDefinition["run"],
  },
  {
    name: "context_set_home_base",
    description:
      "Record the traveler's home base as they state it ('I live in Lawrenceville'). Stated values are " +
      "confirmed defaults immediately.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Home base as stated" },
        lat: { type: "number" },
        lon: { type: "number" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    input: SetHomeBaseInput,
    run: setHomeBaseTool as ToolDefinition["run"],
  },
  {
    name: "context_set_home_airports",
    description:
      "Record the traveler's preferred departure airports as an ordered IATA list, most-preferred first.",
    parameters: {
      type: "object",
      properties: {
        airports: {
          type: "array",
          items: { type: "string", minLength: 3, maxLength: 3 },
          description: "Ordered IATA codes",
        },
      },
      required: ["airports"],
      additionalProperties: false,
    },
    input: SetHomeAirportsInput,
    run: setHomeAirportsTool as ToolDefinition["run"],
  },
  {
    name: "context_confirm_learned",
    description:
      "Confirm Wander's learned home base/airport proposals as the traveler's defaults. Only call this " +
      "after the traveler has explicitly agreed to the proposed values shown in context_get.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    input: ConfirmLearnedInput,
    run: confirmLearned as ToolDefinition["run"],
  },
  {
    name: "context_add_rule",
    description:
      "Record a hard rule or a taste for the traveler. Hard rules are never violated silently (no Basic " +
      "Economy, changeable fares only, no Miami connections, work trips book through Egencia); preferences " +
      "are weighted tastes that shape ranking (boutique stays, aisle seat). Use scope 'work' for " +
      "work-only rules (booking_channel_required, business rideshare profile).",
    parameters: {
      type: "object",
      properties: {
        ruleClass: { type: "string", enum: ["hard", "preference"] },
        ruleType: {
          type: "string",
          enum: [
            "fare_class_ban",
            "changeability_required",
            "connection_airport_ban",
            "booking_channel_required",
            "rideshare_profile",
            "budget_cap",
            "stay_style",
            "seat_preference",
          ],
        },
        params: { type: "object", description: "Type-specific parameters (see the tool input description)" },
        scope: { type: "string", enum: ["all", "work", "personal"] },
      },
      required: ["ruleClass", "ruleType", "params"],
      additionalProperties: false,
    },
    input: AddRuleInput,
    run: addRuleTool as ToolDefinition["run"],
  },
  {
    name: "context_list_rules",
    description: "List the traveler's active hard rules and tastes, with their rule ids.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    input: ListRulesInput,
    run: listRulesTool as ToolDefinition["run"],
  },
  {
    name: "context_deactivate_rule",
    description:
      "Deactivate one of the traveler's rules by id (from context_list_rules) — e.g. when they correct a " +
      "taste ('I actually hate resorts'). Deactivated rules stop filtering and ranking immediately.",
    parameters: {
      type: "object",
      properties: { ruleId: { type: "integer", minimum: 1 } },
      required: ["ruleId"],
      additionalProperties: false,
    },
    input: DeactivateRuleInput,
    run: deactivateRuleTool as ToolDefinition["run"],
  },
  {
    name: "context_add_companion",
    description:
      "Remember a person the traveler travels with (name, and email when given). Companions make future " +
      "'Who's going?' answers one step instead of a fresh list.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    input: AddCompanionInput,
    run: addCompanionTool as ToolDefinition["run"],
  },
  {
    name: "context_list_companions",
    description: "List the traveler's remembered companions, with their companion ids.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    input: ListCompanionsInput,
    run: listCompanionsTool as ToolDefinition["run"],
  },
  {
    name: "context_save_group",
    description:
      "Save a named group of companions ('Munich guys') so a future intake's party can be filled in one " +
      "step with intake_set_party_from_group.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        companionIds: { type: "array", items: { type: "integer", minimum: 1 } },
      },
      required: ["name", "companionIds"],
      additionalProperties: false,
    },
    input: SaveGroupInput,
    run: saveGroupTool as ToolDefinition["run"],
  },
  {
    name: "context_list_groups",
    description: "List the traveler's saved groups and their members, with group ids.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    input: ListGroupsInput,
    run: listGroupsTool as ToolDefinition["run"],
  },
];

export function getContextToolDefinition(name: string): ToolDefinition | undefined {
  return CONTEXT_TOOLS.find((t) => t.name === name);
}
