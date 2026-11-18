/**
 * Marco agent — intake tools (`intake_*`).
 *
 * Thin, typed façades over the Intake Service (architecture §1/§2): the
 * model conducts the conversation, these tools read and advance the
 * server-side state machine. Every write returns the recomputed state
 * and the machine's single next ask, so the model's next question comes
 * from the machine — not from improvisation.
 *
 * Same conventions as agentTools.ts: zod input + hand-written JSON
 * Schema parameters kept in sync manually, structured [Agent] logs, and
 * a plain { ok, text, data? } result shape. Session identity comes from
 * the ToolContext (auth-derived), never from tool arguments.
 */

import { z } from "zod";
import type { AgentToolResult, ToolContext, ToolDefinition } from "./agentTools";
import {
  applyIntakePartyFromGroup,
  applyIntakeSkip,
  applyIntakeSlotWrite,
  assertIntakeAccess,
  confirmIntakeSlot,
  materializeIntake,
  IntakeAccessDenied,
  IntakeGroupNotFound,
  IntakeMaterializationError,
  type IntakeSessionView,
} from "./intake";
import {
  IntakeValidationError,
  type SlotName,
  type SlotProvenance,
  type SlotWriteSource,
} from "./intakeLogic";
import { checkFreeBusyForDates } from "./calendarFreeBusy";
import { logger } from "./logger";

/**
 * The write source for the §2.4 ASR read-back rule: the channel this
 * conversation runs on, plus the STT confidence of the traveler's
 * current utterance when the voice provider reported one.
 */
function writeSource(ctx: ToolContext): SlotWriteSource {
  return {
    channel: ctx.channel ?? "text",
    ...(ctx.asrConfidence !== undefined ? { asrConfidence: ctx.asrConfidence } : {}),
  };
}

function toolOk(text: string, data?: unknown): AgentToolResult {
  return { ok: true, text, data };
}

function toolErr(text: string, data?: unknown): AgentToolResult {
  return { ok: false, text, data };
}

const ProvenanceSchema = z
  .enum(["asked", "stated", "from_context", "inferred"])
  .describe(
    "Where this value came from: 'stated' = volunteered unprompted by the traveler (incl. inside the opening intent), " +
      "'asked' = the answer to your current question, 'from_context' = already known from the traveler's profile, " +
      "'inferred' = your best guess from context",
  );

const provenanceParam = {
  type: "string",
  enum: ["asked", "stated", "from_context", "inferred"],
  description: "Provenance of the value (see tool description)",
} as const;

/** The state digest every intake tool result carries back to the model. */
function viewText(view: IntakeSessionView, headline: string): string {
  const lines = [headline, `Intake state: ${view.state}`, ...view.reviewSummary];
  if (view.nextAsk) {
    lines.push(`Next ask (one question only): "${view.nextAsk.question}"`);
  }
  return lines.join("\n");
}

async function withSession(
  tool: string,
  ctx: ToolContext,
  run: (sessionId: number) => Promise<AgentToolResult>,
): Promise<AgentToolResult> {
  if (ctx.intakeSessionId === undefined) {
    return toolErr("No intake session is active in this conversation.");
  }
  logger.info({ tool, userId: ctx.userId, intakeSessionId: ctx.intakeSessionId }, "[Agent] tool call");
  try {
    return await run(ctx.intakeSessionId);
  } catch (err) {
    if (err instanceof IntakeValidationError) return toolErr(err.message);
    if (err instanceof IntakeAccessDenied) return toolErr(err.message);
    if (err instanceof IntakeMaterializationError) return toolErr(err.message);
    if (err instanceof IntakeGroupNotFound) return toolErr(err.message);
    logger.error({ tool, userId: ctx.userId, intakeSessionId: ctx.intakeSessionId, err }, "[Agent] tool error");
    return toolErr(`Tool ${tool} failed: internal error.`);
  }
}

// ─── intake_get_state ────────────────────────────────────────────────────────

const GetStateInput = z.object({});

async function getState(ctx: ToolContext): Promise<AgentToolResult> {
  return withSession("intake_get_state", ctx, async (sessionId) => {
    const view = await assertIntakeAccess(ctx.userId, ctx.role, sessionId);
    return toolOk(viewText(view, "Current intake state:"), view);
  });
}

// ─── intake_set_destination ──────────────────────────────────────────────────

const SetDestinationInput = z.object({
  text: z.string().min(1).describe("The destination as the traveler said it (place, region, or vibe)"),
  kind: z
    .enum(["place", "region", "vibe", "unknown"])
    .describe("'place' for a specific place, 'region' for an area, 'vibe' for a feel ('somewhere warm'), 'unknown' for an explicit don't-know"),
  provenance: ProvenanceSchema,
});

async function setDestination(
  ctx: ToolContext,
  args: z.infer<typeof SetDestinationInput>,
): Promise<AgentToolResult> {
  return withSession("intake_set_destination", ctx, async (sessionId) => {
    const view = await applyIntakeSlotWrite(sessionId, ctx.userId, ctx.role, {
      slot: "destination",
      value: { kind: args.kind, text: args.text },
      provenance: args.provenance as SlotProvenance,
    }, writeSource(ctx));
    return toolOk(viewText(view, `Destination recorded: ${args.text}.`), view);
  });
}

// ─── intake_set_party ────────────────────────────────────────────────────────

const SetPartyInput = z.object({
  solo: z.boolean().describe("True when the traveler is going alone"),
  travelers: z
    .array(
      z.object({
        name: z.string().min(1).describe("Traveler's name"),
        email: z.string().optional().describe("Traveler's email address, if given"),
      }),
    )
    .describe("Every named traveler (empty when solo). Send the FULL corrected list on a correction."),
  provenance: ProvenanceSchema,
});

async function setParty(ctx: ToolContext, args: z.infer<typeof SetPartyInput>): Promise<AgentToolResult> {
  return withSession("intake_set_party", ctx, async (sessionId) => {
    const view = await applyIntakeSlotWrite(sessionId, ctx.userId, ctx.role, {
      slot: "party",
      value: { solo: args.solo, travelers: args.travelers },
      provenance: args.provenance as SlotProvenance,
    }, writeSource(ctx));
    const headline = args.solo
      ? "Party recorded: solo trip."
      : `Party recorded: ${args.travelers.map((t) => t.name).join(", ")}.`;
    return toolOk(viewText(view, headline), view);
  });
}

// ─── intake_set_party_from_group ─────────────────────────────────────────────

const SetPartyFromGroupInput = z.object({
  groupId: z
    .number()
    .int()
    .positive()
    .describe("The saved group id (from the planner snapshot or context_list_groups)"),
});

async function setPartyFromGroup(
  ctx: ToolContext,
  args: z.infer<typeof SetPartyFromGroupInput>,
): Promise<AgentToolResult> {
  return withSession("intake_set_party_from_group", ctx, async (sessionId) => {
    const view = await applyIntakePartyFromGroup(sessionId, ctx.userId, ctx.role, args.groupId);
    const names = view.slots.party?.value.travelers.map((t) => t.name).join(", ") ?? "";
    return toolOk(
      viewText(
        view,
        `Party filled from the saved group: ${names}. (From the traveler's profile — state it as an assumption and accept correction.)`,
      ),
      view,
    );
  });
}

// ─── intake_set_dates ────────────────────────────────────────────────────────

const SetDatesInput = z.object({
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional()
    .describe("Start date (YYYY-MM-DD)"),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD")
    .optional()
    .describe("End date (YYYY-MM-DD)"),
  windowText: z
    .string()
    .min(1)
    .optional()
    .describe("A fuzzy window when exact dates aren't known ('late September', 'the week of the 14th')"),
  provenance: ProvenanceSchema,
});

async function setDates(ctx: ToolContext, args: z.infer<typeof SetDatesInput>): Promise<AgentToolResult> {
  return withSession("intake_set_dates", ctx, async (sessionId) => {
    const view = await applyIntakeSlotWrite(sessionId, ctx.userId, ctx.role, {
      slot: "dates",
      value: { startDate: args.startDate, endDate: args.endDate, windowText: args.windowText },
      provenance: args.provenance as SlotProvenance,
    }, writeSource(ctx));
    let text = viewText(view, "Dates recorded.");
    // Free/busy (context rung 2, §4.1): with exact dates and a
    // connected calendar, flag a collision in plain terms — the fact
    // only, never what the events are (the free/busy API returns busy
    // intervals only, and this surface adds nothing beyond the fact).
    const dates = view.slots.dates?.value;
    if (dates?.startDate && dates?.endDate) {
      const fb = await checkFreeBusyForDates(ctx.userId, dates.startDate, dates.endDate);
      if (fb.connected && fb.conflict) {
        text +=
          "\nCalendar check: the traveler has something on those dates (from their connected calendar) — " +
          "say exactly that, in plain terms, and ask whether they want to shift the window. " +
          "You do not know what the events are; never guess or ask what they are.";
      }
    }
    return toolOk(text, view);
  });
}

// ─── intake_confirm_slot (§2.4 read-back) ────────────────────────────────────

const ConfirmSlotInput = z.object({
  slot: z
    .enum(["destination", "party", "dates", "style"])
    .describe("The slot whose read-back the traveler just confirmed"),
});

async function confirmSlot(
  ctx: ToolContext,
  args: z.infer<typeof ConfirmSlotInput>,
): Promise<AgentToolResult> {
  return withSession("intake_confirm_slot", ctx, async (sessionId) => {
    const view = await confirmIntakeSlot(sessionId, ctx.userId, ctx.role, args.slot as SlotName);
    return toolOk(viewText(view, `Confirmed — ${args.slot} stands as heard.`), view);
  });
}

// ─── intake_set_style ────────────────────────────────────────────────────────

const SetStyleInput = z.object({
  text: z.string().min(1).describe("The kind of trip, in the traveler's words ('guys' trip', 'family getaway', 'golf weekend')"),
  tier: z
    .enum(["white_glove", "premium", "family_budget"])
    .optional()
    .describe("Service tier, when known or stated"),
  budgetCapMinor: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Budget cap in minor units (e.g. cents) — required at the family_budget tier"),
  budgetCurrency: z.string().length(3).optional().describe("ISO 4217 currency of the budget cap"),
  provenance: ProvenanceSchema,
});

async function setStyle(ctx: ToolContext, args: z.infer<typeof SetStyleInput>): Promise<AgentToolResult> {
  return withSession("intake_set_style", ctx, async (sessionId) => {
    const view = await applyIntakeSlotWrite(sessionId, ctx.userId, ctx.role, {
      slot: "style",
      value: {
        text: args.text,
        tier: args.tier,
        budgetCapMinor: args.budgetCapMinor,
        budgetCurrency: args.budgetCurrency,
      },
      provenance: args.provenance as SlotProvenance,
    }, writeSource(ctx));
    return toolOk(viewText(view, `Trip style recorded: ${args.text}.`), view);
  });
}

// ─── intake_skip ─────────────────────────────────────────────────────────────

const SkipInput = z.object({
  item: z
    .string()
    .min(1)
    .describe(
      "What the traveler declined: a slot name ('destination', 'party', 'dates', 'style'), " +
        "'party_email:<name>' for one traveler's email, or 'style_budget' for the budget cap",
    ),
});

async function skip(ctx: ToolContext, args: z.infer<typeof SkipInput>): Promise<AgentToolResult> {
  return withSession("intake_skip", ctx, async (sessionId) => {
    const view = await applyIntakeSkip(sessionId, ctx.userId, ctx.role, args.item);
    return toolOk(viewText(view, `Marked open: ${args.item}. Moving on.`), view);
  });
}

// ─── intake_get_review ───────────────────────────────────────────────────────

const GetReviewInput = z.object({});

async function getReview(ctx: ToolContext): Promise<AgentToolResult> {
  return withSession("intake_get_review", ctx, async (sessionId) => {
    const view = await assertIntakeAccess(ctx.userId, ctx.role, sessionId);
    if (view.state !== "REVIEW") {
      return toolOk(
        viewText(view, `Intake is not ready for review yet (state: ${view.state}). Keep going with the next ask.`),
        view,
      );
    }
    return toolOk(
      [
        "Intake summary — read this back to the traveler and ask for explicit confirmation before calling intake_confirm:",
        ...view.reviewSummary,
      ].join("\n"),
      view,
    );
  });
}

// ─── intake_confirm ──────────────────────────────────────────────────────────

const ConfirmInput = z.object({});

async function confirm(ctx: ToolContext): Promise<AgentToolResult> {
  return withSession("intake_confirm", ctx, async (sessionId) => {
    const { tripId, view } = await materializeIntake(sessionId, ctx.userId, ctx.role);
    // Extras pass (§7 / TC-8): a freshly materialized trip whose
    // character matches a pack (golf, family…) gets its suggestions
    // unprompted. Best-effort and deferred to a macrotask — the pass
    // is a side effect of materialization, never part of this
    // response, and it must not interleave with the request's own
    // reads (the route reads the session snapshot after this tool
    // returns). Idempotent, so a late or repeated run is harmless.
    setTimeout(() => {
      void import("./extras.js")
        .then((m) => m.runExtrasPassBestEffort(tripId, "intake_materialization"))
        .catch(() => undefined);
    }, 0);
    return toolOk(
      `Trip created: draft trip ${tripId} is set up and this conversation now continues on that trip. ` +
        `Tell the traveler the trip is created and what happens next (planning continues here).`,
      { tripId, view },
    );
  });
}

// ─── Registration ────────────────────────────────────────────────────────────

export const INTAKE_TOOLS: ToolDefinition[] = [
  {
    name: "intake_get_state",
    description:
      "Get the current intake state: what has been captured (with provenance), what is still open, " +
      "and the state machine's one next question. Call this whenever you are unsure where the intake stands.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    input: GetStateInput,
    run: getState as ToolDefinition["run"],
  },
  {
    name: "intake_set_destination",
    description:
      "Record the destination the traveler named. Call this the moment a destination is known — including " +
      "when it arrives inside the opening intent message (provenance 'stated'), so it is never re-asked. " +
      "A place, a region, a vibe ('somewhere warm'), or an explicit 'don't know' are all valid.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The destination as the traveler said it" },
        kind: { type: "string", enum: ["place", "region", "vibe", "unknown"] },
        provenance: provenanceParam,
      },
      required: ["text", "kind", "provenance"],
      additionalProperties: false,
    },
    input: SetDestinationInput,
    run: setDestination as ToolDefinition["run"],
  },
  {
    name: "intake_set_party",
    description:
      "Record who's going: solo, or the full list of named travelers with email addresses (Story 3.1). " +
      "The organizer is always implicitly included — never list them. On a correction ('actually, add Manish'), " +
      "send the FULL corrected list. A traveler may be listed without an email; the machine will ask for it next.",
    parameters: {
      type: "object",
      properties: {
        solo: { type: "boolean", description: "True when the traveler is going alone" },
        travelers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              email: { type: "string" },
            },
            required: ["name"],
            additionalProperties: false,
          },
        },
        provenance: provenanceParam,
      },
      required: ["solo", "travelers", "provenance"],
      additionalProperties: false,
    },
    input: SetPartyInput,
    run: setParty as ToolDefinition["run"],
  },
  {
    name: "intake_set_party_from_group",
    description:
      "Fill the party from one of the traveler's saved groups (context layer, Story 6.3) in one step — " +
      "use this when the traveler names a saved group ('the Munich guys') or accepts your offer of one. " +
      "The slot is recorded with provenance 'from_context': state the party as an assumption from their " +
      "profile and accept correction. Never call this speculatively — the traveler must name or accept the group.",
    parameters: {
      type: "object",
      properties: {
        groupId: { type: "integer", minimum: 1, description: "The saved group id" },
      },
      required: ["groupId"],
      additionalProperties: false,
    },
    input: SetPartyFromGroupInput,
    run: setPartyFromGroup as ToolDefinition["run"],
  },
  {
    name: "intake_confirm_slot",
    description:
      "Settle a voice read-back (§2.4): when a slot was heard with low speech-recognition confidence, the " +
      "state's next ask reads the value back ('I heard … — is that right?'). Call this ONLY when the " +
      "traveler confirms the read-back. If they correct it instead, record the corrected value with the " +
      "matching intake_set_* tool — never confirm a value the traveler disputed.",
    parameters: {
      type: "object",
      properties: {
        slot: { type: "string", enum: ["destination", "party", "dates", "style"] },
      },
      required: ["slot"],
      additionalProperties: false,
    },
    input: ConfirmSlotInput,
    run: confirmSlot as ToolDefinition["run"],
  },
  {
    name: "intake_set_dates",
    description:
      "Record the trip dates: exact start/end dates (YYYY-MM-DD) when known, or a fuzzy windowText " +
      "('late September') when they aren't. Exact dates are required before the trip can be created. " +
      "When the traveler has a connected calendar, the result flags plainly if they have something on " +
      "those dates — relay that fact as-is; you never learn what the events are.",
    parameters: {
      type: "object",
      properties: {
        startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        endDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        windowText: { type: "string", description: "A fuzzy window when exact dates aren't known" },
        provenance: provenanceParam,
      },
      required: ["provenance"],
      additionalProperties: false,
    },
    input: SetDatesInput,
    run: setDates as ToolDefinition["run"],
  },
  {
    name: "intake_set_style",
    description:
      "Record what kind of trip this is, in the traveler's words — it keys the extras and the planning style. " +
      "Include the tier when known, and the budget cap (minor units + currency) when the traveler gives one; " +
      "at the family_budget tier the cap is required before intake can complete.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The kind of trip, in the traveler's words" },
        tier: { type: "string", enum: ["white_glove", "premium", "family_budget"] },
        budgetCapMinor: { type: "integer", minimum: 1, description: "Budget cap in minor units (e.g. cents)" },
        budgetCurrency: { type: "string", minLength: 3, maxLength: 3, description: "ISO 4217 currency" },
        provenance: provenanceParam,
      },
      required: ["text", "provenance"],
      additionalProperties: false,
    },
    input: SetStyleInput,
    run: setStyle as ToolDefinition["run"],
  },
  {
    name: "intake_skip",
    description:
      "Record that the traveler declined to answer something right now ('not sure about dates yet'). " +
      "The item is marked open and intake moves on — it never blocks. Use a slot name ('dates'), " +
      "'party_email:<name>' for one traveler's email, or 'style_budget' for the budget cap.",
    parameters: {
      type: "object",
      properties: {
        item: { type: "string", description: "The slot or sub-item being skipped" },
      },
      required: ["item"],
      additionalProperties: false,
    },
    input: SkipInput,
    run: skip as ToolDefinition["run"],
  },
  {
    name: "intake_get_review",
    description:
      "Get the assembled intake summary to read back to the traveler at REVIEW. Only call intake_confirm " +
      "after the traveler explicitly confirms this summary.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    input: GetReviewInput,
    run: getReview as ToolDefinition["run"],
  },
  {
    name: "intake_confirm",
    description:
      "Create the draft trip from the confirmed intake: the trip row, the organizer as trip admin, and one " +
      "roster entry per named traveler. Call ONLY after the traveler has explicitly confirmed the review summary. " +
      "Fails (with the reason) if exact dates are still missing.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    input: ConfirmInput,
    run: confirm as ToolDefinition["run"],
  },
];

export function getIntakeToolDefinition(name: string): ToolDefinition | undefined {
  return INTAKE_TOOLS.find((t) => t.name === name);
}
