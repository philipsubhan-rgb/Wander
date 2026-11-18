/**
 * Marco agent — concierge call tools (`call_*`).
 *
 * The Concierge-Call Service's conversational surface (architecture
 * §6.5): Marco can prepare a call brief, present it for the
 * traveler's confirmation, place the call, and report its status and
 * outcome. The discipline mirrors the booking tools exactly:
 *
 * - Identity comes from the ToolContext (auth-derived); traveler
 *   names come from the profile vault inside the service — never
 *   from tool arguments.
 * - There is NO tool that dials without a confirmed brief: call_place
 *   reaches the service only with a brief id, and the service refuses
 *   an unconfirmed brief. The tools are thin façades and cannot widen
 *   that.
 * - Virtual-card details NEVER appear in a tool result: the service
 *   returns them once to the live call session; this façade strips
 *   them and reports only that a card was issued for the call.
 */

import { z } from "zod";
import { formatMoney, money } from "@workspace/money";
import type { AgentToolResult, ToolContext, ToolDefinition } from "./agentTools";
import {
  CallAccessDenied,
  CallNotFound,
  CallRefused,
  getDefaultConciergeCallService,
} from "./conciergeCalls";
import { formatBriefText } from "./conciergeCallLogic";
import { logger } from "./logger";

function toolOk(text: string, data?: unknown): AgentToolResult {
  return { ok: true, text, data };
}

function toolErr(text: string, data?: unknown): AgentToolResult {
  return { ok: false, text, data };
}

// ─── Input ───────────────────────────────────────────────────────────────────

const PrepareBriefInput = z.object({
  tripId: z.number().int().positive(),
  kind: z.enum(["book", "change", "cancel", "special_request", "info"]),
  calleeName: z.string().min(1).max(200),
  calleePhone: z.string().min(5).max(40),
  ask: z.string().min(1).max(2000),
  category: z.string().min(1).max(60).optional(),
  partySize: z.number().int().positive().max(100).optional(),
  serviceDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  serviceTimeWindow: z.string().min(1).max(120).optional(),
  fallbacks: z.array(z.string().min(1).max(500)).max(6).optional(),
  mayNotAgree: z.array(z.string().min(1).max(500)).max(6).optional(),
  /** The approved total cap — required unless infoOnly is set. */
  authorityAmountMinor: z.number().int().positive().optional(),
  authorityCurrency: z.string().length(3).optional(),
  infoOnly: z.boolean().optional(),
  toleranceAmountMinor: z.number().int().nonnegative().optional(),
  paymentMayBeRequired: z.boolean().optional(),
  durationCapSeconds: z.number().int().positive().max(3600).optional(),
  callbackNumber: z.string().min(5).max(40).optional(),
  travelerUserId: z.number().int().positive().optional(),
  coveredUserIds: z.array(z.number().int().positive()).min(1).max(9).optional(),
  reservationRefs: z.array(z.string().min(1).max(80)).max(6).optional(),
  bookingAttemptId: z.number().int().positive().optional(),
  bookingId: z.number().int().positive().optional(),
  extrasSuggestionId: z.number().int().positive().optional(),
});

const BriefIdInput = z.object({
  briefId: z.number().int().positive(),
});

const CallStatusInput = z.object({
  briefId: z.number().int().positive().optional(),
  taskId: z.number().int().positive().optional(),
});

// ─── Tool runs ───────────────────────────────────────────────────────────────

function callErrorText(err: unknown): string {
  if (err instanceof CallAccessDenied || err instanceof CallNotFound || err instanceof CallRefused) {
    return err.message;
  }
  return "Something went wrong in the call service. Nothing was called or booked.";
}

async function prepareBrief(
  ctx: ToolContext,
  args: z.infer<typeof PrepareBriefInput>,
): Promise<AgentToolResult> {
  logger.info({ tool: "call_prepare_brief", userId: ctx.userId, tripId: args.tripId }, "[Agent] tool call");
  try {
    const service = getDefaultConciergeCallService();
    const authorityLimit =
      args.authorityAmountMinor != null && args.authorityCurrency
        ? money(args.authorityAmountMinor, args.authorityCurrency)
        : null;
    if (!args.infoOnly && args.kind !== "info" && !authorityLimit && !args.bookingAttemptId) {
      return toolErr(
        "A spend brief needs its approved total cap (authorityAmountMinor + authorityCurrency) — the call may commit only within it. For an information-only call, set infoOnly instead.",
      );
    }
    const brief = await service.prepareBrief(
      {
        tripId: args.tripId,
        kind: args.kind,
        calleeName: args.calleeName,
        calleePhone: args.calleePhone,
        ask: args.ask,
        category: args.category ?? null,
        partySize: args.partySize ?? null,
        serviceDate: args.serviceDate ?? null,
        serviceTimeWindow: args.serviceTimeWindow ?? null,
        fallbacks: args.fallbacks ?? [],
        mayNotAgree: args.mayNotAgree ?? [],
        authorityKind: args.infoOnly || args.kind === "info" ? "info_only" : "spend",
        authorityLimit,
        toleranceAmountMinor: args.toleranceAmountMinor,
        paymentMayBeRequired: args.paymentMayBeRequired,
        durationCapSeconds: args.durationCapSeconds,
        callbackNumber: args.callbackNumber ?? null,
        travelerUserId: args.travelerUserId,
        coveredUserIds: args.coveredUserIds,
        reservationRefs: args.reservationRefs ?? [],
        bookingAttemptId: args.bookingAttemptId ?? null,
        bookingId: args.bookingId ?? null,
        extrasSuggestionId: args.extrasSuggestionId ?? null,
      },
      { userId: ctx.userId, role: ctx.role },
    );
    const { problems } = await service.getBriefView(brief.id, {
      userId: ctx.userId,
      role: ctx.role,
    });
    const text = formatBriefText({
      id: brief.id,
      version: brief.version,
      kind: brief.kind,
      state: brief.state,
      calleeName: brief.calleeName,
      calleePhone: brief.calleePhone,
      ask: brief.ask,
      travelerNameOnReservation: brief.travelerNameOnReservation,
      partySize: brief.partySize,
      serviceDate: brief.serviceDate,
      serviceTimeWindow: brief.serviceTimeWindow,
      fallbacks: brief.fallbacks,
      mayNotAgree: brief.mayNotAgree,
      authorityKind: brief.authorityKind,
      authorityLimit:
        brief.authorityLimitAmountMinor != null && brief.authorityLimitCurrency
          ? money(brief.authorityLimitAmountMinor, brief.authorityLimitCurrency)
          : null,
      durationCapSeconds: brief.durationCapSeconds,
      callbackNumber: brief.callbackNumber,
      visibility: brief.visibility,
      category: brief.category,
      reservationRefs: brief.reservationRefs,
    });
    return toolOk(
      problems.length > 0
        ? `${text}\n\nBefore this brief can be confirmed and called, it still needs: ${problems.join("; ")}.`
        : text,
      { brief, problems },
    );
  } catch (err) {
    logger.warn({ tool: "call_prepare_brief", userId: ctx.userId, err }, "[Agent] call tool error");
    return toolErr(callErrorText(err));
  }
}

async function presentBrief(
  ctx: ToolContext,
  args: z.infer<typeof BriefIdInput>,
): Promise<AgentToolResult> {
  logger.info({ tool: "call_present_brief", userId: ctx.userId, briefId: args.briefId }, "[Agent] tool call");
  try {
    const service = getDefaultConciergeCallService();
    const { brief, tasks, problems } = await service.getBriefView(args.briefId, {
      userId: ctx.userId,
      role: ctx.role,
    });
    const text = formatBriefText({
      id: brief.id,
      version: brief.version,
      kind: brief.kind,
      state: brief.state,
      calleeName: brief.calleeName,
      calleePhone: brief.calleePhone,
      ask: brief.ask,
      travelerNameOnReservation: brief.travelerNameOnReservation,
      partySize: brief.partySize,
      serviceDate: brief.serviceDate,
      serviceTimeWindow: brief.serviceTimeWindow,
      fallbacks: brief.fallbacks,
      mayNotAgree: brief.mayNotAgree,
      authorityKind: brief.authorityKind,
      authorityLimit:
        brief.authorityLimitAmountMinor != null && brief.authorityLimitCurrency
          ? money(brief.authorityLimitAmountMinor, brief.authorityLimitCurrency)
          : null,
      durationCapSeconds: brief.durationCapSeconds,
      callbackNumber: brief.callbackNumber,
      visibility: brief.visibility,
      category: brief.category,
      reservationRefs: brief.reservationRefs,
    });
    const lines = [text];
    if (brief.state === "confirmed") {
      lines.push("");
      lines.push("This brief is confirmed — the call can be placed with call_place.");
    }
    if (problems.length > 0) {
      lines.push("");
      lines.push(`Still missing before a call can be placed: ${problems.join("; ")}.`);
    }
    if (tasks.length > 0) {
      lines.push("");
      lines.push(`Call attempts so far: ${tasks.map((t) => `#${t.id} ${t.state}`).join(", ")}.`);
    }
    return toolOk(lines.join("\n"), { brief, tasks, problems });
  } catch (err) {
    logger.warn({ tool: "call_present_brief", userId: ctx.userId, err }, "[Agent] call tool error");
    return toolErr(callErrorText(err));
  }
}

async function confirmBrief(
  ctx: ToolContext,
  args: z.infer<typeof BriefIdInput>,
): Promise<AgentToolResult> {
  logger.info({ tool: "call_confirm_brief", userId: ctx.userId, briefId: args.briefId }, "[Agent] tool call");
  try {
    const service = getDefaultConciergeCallService();
    const result = await service.confirmBrief(args.briefId, {
      userId: ctx.userId,
      role: ctx.role,
      // The channel rides along so the service can enforce
      // voice-proposes / screen-confirms for spend briefs (§2.4).
      channel: ctx.channel,
    });
    if (!result.confirmed) {
      return toolOk(
        `Not confirmed: ${result.reason} No call will be placed against this brief.`,
        result,
      );
    }
    const cap =
      result.brief.authorityLimitAmountMinor != null && result.brief.authorityLimitCurrency
        ? ` at up to ${formatMoney(money(result.brief.authorityLimitAmountMinor, result.brief.authorityLimitCurrency), "en-US")}`
        : "";
    return toolOk(
      `Confirmed — call brief #${result.brief.id} is confirmed${cap}. Say the word and I'll place the call (call_place).`,
      result,
    );
  } catch (err) {
    logger.warn({ tool: "call_confirm_brief", userId: ctx.userId, err }, "[Agent] call tool error");
    return toolErr(callErrorText(err));
  }
}

async function placeCall(
  ctx: ToolContext,
  args: z.infer<typeof BriefIdInput>,
): Promise<AgentToolResult> {
  logger.info({ tool: "call_place", userId: ctx.userId, briefId: args.briefId }, "[Agent] tool call");
  try {
    const service = getDefaultConciergeCallService();
    const result = await service.placeCall(args.briefId, {
      userId: ctx.userId,
      role: ctx.role,
    });
    if (!result.placed) {
      return toolOk(result.reason ?? "The call wasn't placed.", {
        placed: false,
        reason: result.reason,
        task: result.task,
      });
    }
    // ⚠ result.cardDetails is deliberately NOT surfaced: the virtual
    // card's details belong to the live call session only — never to
    // chat, tool results, transcripts, or logs.
    const cardNote = result.cardDetails
      ? " A single-use virtual card, capped at the brief's approved total, was issued for the call."
      : "";
    return toolOk(
      `Calling now — call task #${result.task!.id} (attempt ${result.task!.attemptNumber}) against brief #${args.briefId}.${cardNote} I'll report the outcome here when the call completes.`,
      { placed: true, task: result.task },
    );
  } catch (err) {
    logger.warn({ tool: "call_place", userId: ctx.userId, err }, "[Agent] call tool error");
    return toolErr(callErrorText(err));
  }
}

async function callStatus(
  ctx: ToolContext,
  args: z.infer<typeof CallStatusInput>,
): Promise<AgentToolResult> {
  logger.info({ tool: "call_status", userId: ctx.userId }, "[Agent] tool call");
  try {
    const service = getDefaultConciergeCallService();
    if (args.taskId) {
      const { task, brief } = await service.getTaskView(args.taskId, {
        userId: ctx.userId,
        role: ctx.role,
      });
      const lines = [
        `Call task #${task.id} (brief #${brief.id}, attempt ${task.attemptNumber}) — ${task.state}.`,
      ];
      if (task.outcomeText) lines.push(task.outcomeText);
      if (task.failureReason && task.failureReason !== task.outcomeText) {
        lines.push(`Reason: ${task.failureReason}`);
      }
      if (task.bookingId) lines.push(`Ledger booking: #${task.bookingId}.`);
      return toolOk(lines.join("\n"), { task, brief });
    }
    if (args.briefId) {
      const { brief, tasks } = await service.getBriefView(args.briefId, {
        userId: ctx.userId,
        role: ctx.role,
      });
      if (tasks.length === 0) {
        return toolOk(
          `Brief #${brief.id} is ${brief.state} — no call has been placed against it yet.`,
          { brief, tasks },
        );
      }
      const latest = tasks[tasks.length - 1]!;
      const lines = [
        `Brief #${brief.id} (${brief.state}) — latest call task #${latest.id}: ${latest.state}.`,
      ];
      if (latest.outcomeText) lines.push(latest.outcomeText);
      if (latest.bookingId) lines.push(`Ledger booking: #${latest.bookingId}.`);
      return toolOk(lines.join("\n"), { brief, tasks });
    }
    return toolErr("Give me a briefId or a taskId and I'll look up the call.");
  } catch (err) {
    logger.warn({ tool: "call_status", userId: ctx.userId, err }, "[Agent] call tool error");
    return toolErr(callErrorText(err));
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

export const CALL_TOOLS: ToolDefinition[] = [
  {
    name: "call_prepare_brief",
    description:
      "Prepare a concierge call brief — the finalized instruction set a phone call is placed against (Stories 4.1–4.5). " +
      "The brief states who is being called, the exact ask, ranked fallbacks, what the agent may NOT agree to, the " +
      "party/date, and either an approved total cap (the call may commit only within it) or infoOnly (the call may " +
      "gather information and commit NOTHING). Use for venues with no booking rail: restaurants that only take phone " +
      "bookings, boutique properties, charter operators, changes/cancels a supplier handles only by phone, and " +
      "special requests. Preparing a brief calls NOBODY — the traveler reviews it (call_present_brief), confirms it " +
      "(call_confirm_brief), and only then can the call be placed (call_place). The traveler's name for the " +
      "reservation comes from their profile — never ask them to dictate personal details into chat.",
    parameters: {
      type: "object",
      properties: {
        tripId: { type: "integer", description: "The trip this call belongs to" },
        kind: { type: "string", enum: ["book", "change", "cancel", "special_request", "info"], description: "What the call is for" },
        calleeName: { type: "string", description: "The venue/supplier being called" },
        calleePhone: { type: "string", description: "The venue's phone number" },
        ask: { type: "string", description: "The specific ask, in plain language" },
        category: { type: "string", description: "Concierge category (nightlife, spa, private_tour, skip_the_line…) — those default to private visibility" },
        partySize: { type: "integer", description: "Party size (required for book briefs)" },
        serviceDate: { type: "string", description: "YYYY-MM-DD (required for book briefs)" },
        serviceTimeWindow: { type: "string", description: "Acceptable time window, e.g. '19:00–20:30'" },
        fallbacks: { type: "array", items: { type: "string" }, description: "Acceptable alternatives, in priority order" },
        mayNotAgree: { type: "array", items: { type: "string" }, description: "What the agent may NOT agree to" },
        authorityAmountMinor: { type: "integer", description: "Approved total cap in minor units (e.g. cents) — the call may commit only within this" },
        authorityCurrency: { type: "string", description: "ISO currency of the cap, e.g. USD" },
        infoOnly: { type: "boolean", description: "True for an information-gathering call that may commit nothing" },
        toleranceAmountMinor: { type: "integer", description: "Stated tolerance above the cap applied only to the virtual card's limit (taxes/fees)" },
        paymentMayBeRequired: { type: "boolean", description: "True when the venue may need a card read on the call (a capped single-use virtual card is issued)" },
        durationCapSeconds: { type: "integer", description: "Hard cap on call length in seconds (default 600)" },
        callbackNumber: { type: "string", description: "Callback number stated in the brief" },
        travelerUserId: { type: "integer", description: "The traveler the call acts for (default: the caller)" },
        coveredUserIds: { type: "array", items: { type: "integer" }, description: "User ids the resulting booking covers (default: the traveler alone)" },
        reservationRefs: { type: "array", items: { type: "string" }, description: "Existing confirmation/reference numbers the call may need" },
        bookingAttemptId: { type: "integer", description: "A gate attempt this call executes for — its reviewed total becomes the cap" },
        bookingId: { type: "integer", description: "The existing ledger booking a change/cancel call acts on" },
        extrasSuggestionId: { type: "integer", description: "An ACCEPTED extras suggestion this call arranges" },
      },
      required: ["tripId", "kind", "calleeName", "calleePhone", "ask"],
      additionalProperties: false,
    },
    input: PrepareBriefInput,
    run: prepareBrief as ToolDefinition["run"],
  },
  {
    name: "call_present_brief",
    description:
      "Show a call brief exactly as the traveler reviews it before confirming: the ask, fallbacks, may-not list, " +
      "the spending authority, the duration cap, plus any completeness problems and the call attempts so far. " +
      "Presenting calls NOBODY.",
    parameters: {
      type: "object",
      properties: {
        briefId: { type: "integer", description: "The call brief id from call_prepare_brief" },
      },
      required: ["briefId"],
      additionalProperties: false,
    },
    input: BriefIdInput,
    run: presentBrief as ToolDefinition["run"],
  },
  {
    name: "call_confirm_brief",
    description:
      "Record the traveler's EXPLICIT confirmation of a call brief. This is the binding act for a phone call: " +
      "a spend-authorizing brief can only be confirmed on screen (a spoken 'yes' on the voice channel is refused, " +
      "exactly as for bookings), and no call can be placed against an unconfirmed brief. Confirming dials NOTHING " +
      "— placing the call is a separate step.",
    parameters: {
      type: "object",
      properties: {
        briefId: { type: "integer", description: "The call brief id to confirm" },
      },
      required: ["briefId"],
      additionalProperties: false,
    },
    input: BriefIdInput,
    run: confirmBrief as ToolDefinition["run"],
  },
  {
    name: "call_place",
    description:
      "Place the phone call against a CONFIRMED call brief. Refuses plainly when the brief isn't confirmed, isn't " +
      "complete, or telephony isn't configured — and never dials any other way. The agent on the call works only " +
      "within the brief: the ask, the fallbacks, the may-not list, and the spending cap. The outcome is reported " +
      "back on the call task (call_status) and, when the call books, written to the trip's bookings like any " +
      "other booking.",
    parameters: {
      type: "object",
      properties: {
        briefId: { type: "integer", description: "The CONFIRMED call brief id to place the call against" },
      },
      required: ["briefId"],
      additionalProperties: false,
    },
    input: BriefIdInput,
    run: placeCall as ToolDefinition["run"],
  },
  {
    name: "call_status",
    description:
      "Report a call's state and outcome: by taskId for one call attempt, or by briefId for the brief's latest " +
      "attempt. The outcome report states what was asked, what was agreed, what it costs, and any follow-ups — " +
      "including, for failures, the reason and the next step (Story 4.5).",
    parameters: {
      type: "object",
      properties: {
        briefId: { type: "integer", description: "Look up by brief id (latest attempt)" },
        taskId: { type: "integer", description: "Look up one call task directly" },
      },
      additionalProperties: false,
    },
    input: CallStatusInput,
    run: callStatus as ToolDefinition["run"],
  },
];

export function getCallToolDefinition(name: string): ToolDefinition | undefined {
  return CALL_TOOLS.find((t) => t.name === name);
}
