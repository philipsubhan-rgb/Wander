/**
 * Marco agent — booking tools (`booking_*`).
 *
 * The gate's conversational surface (architecture §5.2): Marco can
 * present a priced option for review, record the traveler's explicit
 * confirmation, and execute a CONFIRMED booking. There is deliberately
 * NO tool that books from a search result: execution exists only
 * behind a confirmed attempt, enforced in the Booking Gate service —
 * the tools are thin façades and cannot widen that.
 *
 * Identity comes from the ToolContext (auth-derived). Passenger
 * details are NEVER tool arguments — the gate reads them from the
 * traveler's profile vault at execution time, access-logged. The
 * parameter schemas below carry ids and enums only, by design.
 *
 * Voice proposes, screen confirms (§2.4): the review text these tools
 * return is the confirmation surface — exact charge-currency total,
 * home equivalent with its FX timestamp, plain-language terms, covered
 * travelers, and the why-this-option line.
 */

import { z } from "zod";
import { formatMoney } from "@workspace/money";
import type { BookingAttempt, BookingAttemptTraveler } from "@workspace/db";
import type { AgentToolResult, ToolContext, ToolDefinition } from "./agentTools";
import {
  BookingAccessDenied,
  BookingNotFound,
  BookingRefused,
  getDefaultBookingGate,
  type BeginReviewResult,
  type ConfirmResult,
  type ExecuteResult,
} from "./bookingGate";
import { GateTransitionError } from "./bookingGateLogic";
import { getDefaultOptionsService } from "./optionsService";
import { logger } from "./logger";

function toolOk(text: string, data?: unknown): AgentToolResult {
  return { ok: true, text, data };
}

function toolErr(text: string, data?: unknown): AgentToolResult {
  return { ok: false, text, data };
}

// ─── Input ───────────────────────────────────────────────────────────────────

const PresentOptionInput = z.object({
  tripId: z.number().int().positive(),
  optionId: z.string().min(1, "optionId is required"),
  coveredUserIds: z.array(z.number().int().positive()).min(1).max(9).optional(),
  coveredRosterEntryIds: z.array(z.number().int().positive()).min(1).max(9).optional(),
  payerUserId: z.number().int().positive().optional(),
  whyThisOption: z.enum(["best_price", "best_schedule", "only_option", "traveler_chose"]).optional(),
  category: z.string().min(1).max(60).optional(),
});

const AttemptIdInput = z.object({
  attemptId: z.number().int().positive(),
});

// ─── Formatting (the review surface Marco voices) ────────────────────────────

function totalOf(attempt: BookingAttempt): { amountMinor: number; currency: string } {
  return {
    amountMinor: attempt.reviewedAmountMinor ?? attempt.presentedAmountMinor,
    currency: attempt.reviewedCurrency ?? attempt.presentedCurrency,
  };
}

export function formatReviewText(
  attempt: BookingAttempt,
  coverage: BookingAttemptTraveler[],
  opts: { deltaText?: string } = {},
): string {
  const total = totalOf(attempt);
  const lines: string[] = [];
  if (opts.deltaText) {
    lines.push(opts.deltaText);
    lines.push("");
  }
  lines.push(`Booking review — ${attempt.supplier} (${attempt.kind}), attempt #${attempt.id}:`);
  lines.push(`   Total to be charged: ${formatMoney(total, "en-US")}`);
  if (attempt.homeEquivalentMinor !== null && attempt.homeCurrency) {
    lines.push(
      `   ≈ ${formatMoney({ amountMinor: attempt.homeEquivalentMinor, currency: attempt.homeCurrency }, "en-US")} in your currency (estimate, from a stored FX rate)`,
    );
  }
  if (attempt.changeTerms) lines.push(`   Changes: ${attempt.changeTerms}`);
  if (attempt.cancelTerms) lines.push(`   Cancellation: ${attempt.cancelTerms}`);
  const confirmedCount = coverage.filter((c) => c.confirmedAt).length;
  lines.push(
    `   Covers ${coverage.length} traveler${coverage.length === 1 ? "" : "s"}` +
      (coverage.length > 1 ? ` — ${confirmedCount} of ${coverage.length} have confirmed their part` : ""),
  );
  if (attempt.whyThisOptionText) lines.push(`   Why this one: ${attempt.whyThisOptionText}`);
  if (attempt.visibility === "private") {
    lines.push("   Visibility: private — this won't be broadcast on the shared itinerary.");
  }
  if (attempt.state === "review") {
    lines.push("");
    lines.push(
      "Nothing is booked yet. Confirm only when this exact total and these terms are right — booking happens only after confirmation.",
    );
  }
  return lines.join("\n");
}

export function formatAttemptStatusText(
  attempt: BookingAttempt,
  coverage: BookingAttemptTraveler[],
): string {
  const total = totalOf(attempt);
  const lines = [
    `Booking attempt #${attempt.id} — ${attempt.supplier} (${attempt.kind}): ${attempt.state}.`,
    `   Total: ${formatMoney(total, "en-US")}`,
  ];
  if (attempt.state === "failed" && attempt.failureReason) {
    lines.push(`   Reason: ${attempt.failureReason}`);
  }
  if (attempt.state === "booked" && attempt.bookingId) {
    lines.push(`   Booked — ledger booking #${attempt.bookingId}.`);
  }
  const confirmedCount = coverage.filter((c) => c.confirmedAt).length;
  if (coverage.length > 1) {
    lines.push(`   Traveler confirmations: ${confirmedCount} of ${coverage.length}.`);
  }
  return lines.join("\n");
}

// ─── Tool runs ───────────────────────────────────────────────────────────────

function gateErrorText(err: unknown): string {
  if (err instanceof GateTransitionError) {
    return `That step isn't possible from the booking's current state (${err.from}). Nothing was booked.`;
  }
  if (err instanceof BookingAccessDenied || err instanceof BookingNotFound || err instanceof BookingRefused) {
    return err.message;
  }
  return "Something went wrong in the booking gate. Nothing was booked.";
}

async function presentOption(
  ctx: ToolContext,
  args: z.infer<typeof PresentOptionInput>,
): Promise<AgentToolResult> {
  logger.info({ tool: "booking_present_option", userId: ctx.userId, tripId: args.tripId }, "[Agent] tool call");
  const option = getDefaultOptionsService().findCachedOption(args.optionId);
  if (!option) {
    return toolErr(
      "That option isn't in the current search results anymore — search again so we price it fresh, then present it for review.",
    );
  }
  const coveredTravelers = [
    ...(args.coveredUserIds ?? []).map((userId) => ({
      userId,
      isPayer: args.payerUserId === userId,
    })),
    ...(args.coveredRosterEntryIds ?? []).map((rosterEntryId) => ({ rosterEntryId })),
  ];
  if (coveredTravelers.length === 0) {
    coveredTravelers.push({ userId: ctx.userId, isPayer: true });
  }
  try {
    const gate = getDefaultBookingGate();
    const attempt = await gate.createAttempt({
      userId: ctx.userId,
      role: ctx.role,
      tripId: args.tripId,
      option,
      coveredTravelers,
      category: args.category ?? null,
      whyHint: args.whyThisOption ?? null,
    });
    const review: BeginReviewResult = await gate.beginReview(attempt.id, {
      userId: ctx.userId,
      role: ctx.role,
    });
    const { coverage } = await gate.getAttemptView(review.attempt.id, {
      userId: ctx.userId,
      role: ctx.role,
    });
    if (review.outcome === "unavailable") {
      return toolOk(
        `${review.reason ?? "That option is no longer available."} Ask me to search again for alternatives.`,
        review,
      );
    }
    if (review.outcome === "unverifiable") {
      return toolOk(
        `${review.reason ?? "The price couldn't be re-verified live."} The option is back in your presented list — nothing was booked.`,
        review,
      );
    }
    return toolOk(
      formatReviewText(review.attempt, coverage, { deltaText: review.deltaText }),
      review,
    );
  } catch (err) {
    logger.warn({ tool: "booking_present_option", userId: ctx.userId, err }, "[Agent] booking tool error");
    return toolErr(gateErrorText(err));
  }
}

async function reviewAttempt(
  ctx: ToolContext,
  args: z.infer<typeof AttemptIdInput>,
): Promise<AgentToolResult> {
  logger.info({ tool: "booking_review", userId: ctx.userId, attemptId: args.attemptId }, "[Agent] tool call");
  try {
    const gate = getDefaultBookingGate();
    const { attempt, coverage } = await gate.getAttemptView(args.attemptId, {
      userId: ctx.userId,
      role: ctx.role,
    });
    if (attempt.state === "review") {
      return toolOk(formatReviewText(attempt, coverage), { attempt, coverage });
    }
    return toolOk(formatAttemptStatusText(attempt, coverage), { attempt, coverage });
  } catch (err) {
    logger.warn({ tool: "booking_review", userId: ctx.userId, err }, "[Agent] booking tool error");
    return toolErr(gateErrorText(err));
  }
}

async function confirmAttempt(
  ctx: ToolContext,
  args: z.infer<typeof AttemptIdInput>,
): Promise<AgentToolResult> {
  logger.info({ tool: "booking_confirm", userId: ctx.userId, attemptId: args.attemptId }, "[Agent] tool call");
  try {
    const gate = getDefaultBookingGate();
    const result: ConfirmResult = await gate.confirmAttempt(args.attemptId, {
      userId: ctx.userId,
      role: ctx.role,
      // The channel rides along so the gate can enforce voice-proposes /
      // screen-confirms (§2.4) — a spoken "yes" reaches the gate as a
      // voice-channel confirmation and is refused there.
      channel: ctx.channel,
    });
    if (!result.confirmed) {
      return toolOk(
        `Not confirmed: ${result.reason} The booking stays at review — nothing was booked or charged.`,
        result,
      );
    }
    return toolOk(
      `Confirmed — booking attempt #${result.attempt.id} is confirmed at ${formatMoney(totalOf(result.attempt), "en-US")}. Say the word and I'll execute the booking.`,
      result,
    );
  } catch (err) {
    logger.warn({ tool: "booking_confirm", userId: ctx.userId, err }, "[Agent] booking tool error");
    return toolErr(gateErrorText(err));
  }
}

async function executeAttempt(
  ctx: ToolContext,
  args: z.infer<typeof AttemptIdInput>,
): Promise<AgentToolResult> {
  logger.info({ tool: "booking_execute", userId: ctx.userId, attemptId: args.attemptId }, "[Agent] tool call");
  try {
    const gate = getDefaultBookingGate();
    const result: ExecuteResult = await gate.executeAttempt(args.attemptId, {
      userId: ctx.userId,
      role: ctx.role,
    });
    if (!result.executed) {
      const lines = [result.reason ?? "The booking didn't go through. Nothing was booked."];
      if (result.deltaText) lines.unshift(result.deltaText);
      return toolOk(lines.join("\n"), result);
    }
    const booking = result.booking;
    if (!booking) return toolOk("Booked.", result);
    if (result.alreadyBooked) {
      return toolOk(
        `Already booked — confirmation ${booking.confirmationCode ?? "(pending)"}, total charged ${formatMoney({ amountMinor: booking.chargeAmountMinor, currency: booking.chargeCurrency }, "en-US")}. The booking wasn't sent twice.`,
        result,
      );
    }
    if (result.pendingConfirmation) {
      return toolOk(
        `Booking accepted by ${booking.supplier} and confirming now — total ${formatMoney({ amountMinor: booking.chargeAmountMinor, currency: booking.chargeCurrency }, "en-US")}. It's on the itinerary as pending; the confirmation code lands as soon as the airline confirms.`,
        result,
      );
    }
    return toolOk(
      `Booked! ${booking.supplier} confirmation ${booking.confirmationCode ?? "—"}, total charged ${formatMoney({ amountMinor: booking.amountActuallyChargedMinor ?? booking.chargeAmountMinor, currency: booking.chargeCurrency }, "en-US")}. It's on the itinerary and being watched for changes.`,
      result,
    );
  } catch (err) {
    logger.warn({ tool: "booking_execute", userId: ctx.userId, err }, "[Agent] booking tool error");
    return toolErr(gateErrorText(err));
  }
}

// ─── Registration ────────────────────────────────────────────────────────────

export const BOOKING_TOOLS: ToolDefinition[] = [
  {
    name: "booking_present_option",
    description:
      "Present a priced option (from options_search_flights / options_search_stays) for booking review on a trip. " +
      "The price is RE-VERIFIED live first: if it changed, the traveler sees the new total and must review again — " +
      "the old total is never silently updated. Returns the review surface: exact total to be charged, terms, " +
      "covered travelers, and why this option. Presenting books NOTHING. The option must come from a current " +
      "search — if it has fallen out of the results, search again first.",
    parameters: {
      type: "object",
      properties: {
        tripId: { type: "integer", description: "The trip this booking belongs to" },
        optionId: { type: "string", description: "The option's id from a current options search result" },
        coveredUserIds: { type: "array", items: { type: "integer" }, description: "User ids of the travelers this booking covers (default: the caller alone)" },
        coveredRosterEntryIds: { type: "array", items: { type: "integer" }, description: "Roster entry ids of covered travelers who haven't claimed a profile yet" },
        payerUserId: { type: "integer", description: "Which covered traveler pays (default: the first covered)" },
        whyThisOption: { type: "string", enum: ["best_price", "best_schedule", "only_option", "traveler_chose"], description: "Why this option, from the search's fit reasons (optional)" },
        category: { type: "string", description: "Concierge category for concierge items (optional) — those default to private visibility" },
      },
      required: ["tripId", "optionId"],
      additionalProperties: false,
    },
    input: PresentOptionInput,
    run: presentOption as ToolDefinition["run"],
  },
  {
    name: "booking_review",
    description:
      "Show a booking attempt's current state: the review surface when it's awaiting confirmation (exact total, " +
      "terms, covered travelers, per-traveler confirmation status), or its status when confirmed/booked/failed.",
    parameters: {
      type: "object",
      properties: {
        attemptId: { type: "integer", description: "The booking attempt id from booking_present_option" },
      },
      required: ["attemptId"],
      additionalProperties: false,
    },
    input: AttemptIdInput,
    run: reviewAttempt as ToolDefinition["run"],
  },
  {
    name: "booking_confirm",
    description:
      "Record the traveler's EXPLICIT confirmation of a booking attempt at its reviewed total. This is the " +
      "confirmation act the whole discipline hangs on: it binds the caller to the exact total shown at review. " +
      "A traveler can confirm only a booking that covers themselves; group/shared bookings can't be confirmed " +
      "yet under the current policy (the refusal states why, and the traveler's own confirmation is still " +
      "recorded). Confirming charges NOTHING — execution is a separate step.",
    parameters: {
      type: "object",
      properties: {
        attemptId: { type: "integer", description: "The booking attempt id to confirm" },
      },
      required: ["attemptId"],
      additionalProperties: false,
    },
    input: AttemptIdInput,
    run: confirmAttempt as ToolDefinition["run"],
  },
  {
    name: "booking_execute",
    description:
      "Execute a CONFIRMED booking attempt: re-verifies the price one last time (a change sends it back to " +
      "review — nothing is booked at a different price than confirmed), then creates the booking with the " +
      "supplier exactly once. Passenger details come from the travelers' own profiles — never ask the traveler " +
      "to dictate passport or personal details into chat for a booking. Fails openly with the reason when the " +
      "supplier refuses; never substitutes a different option.",
    parameters: {
      type: "object",
      properties: {
        attemptId: { type: "integer", description: "The CONFIRMED booking attempt id to execute" },
      },
      required: ["attemptId"],
      additionalProperties: false,
    },
    input: AttemptIdInput,
    run: executeAttempt as ToolDefinition["run"],
  },
];

export function getBookingToolDefinition(name: string): ToolDefinition | undefined {
  return BOOKING_TOOLS.find((t) => t.name === name);
}
