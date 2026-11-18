/**
 * Intake state machine — pure logic (architecture-north-star §2, ADR-2).
 *
 * Marco conducts the conversation; this machine decides what is still
 * missing, what may be skipped, and when a draft trip may materialize.
 * The model proposes slot values from the conversation; the machine
 * validates and stores them. State lives server-side (intake_sessions),
 * never in the prompt — which is what makes voice and text identical
 * channels and "asks less over time" measurable (§4.4).
 *
 * No DB, no I/O: the DB-backed service (intake.ts) loads an IntakeData,
 * applies events through these functions, and persists the result.
 */

export type IntakeStateName =
  | "OPENING"
  | "DESTINATION"
  | "PARTY"
  | "DATES"
  | "STYLE"
  | "REVIEW"
  | "MATERIALIZED";

export type SlotName = "destination" | "party" | "dates" | "style";

/** Where a slot value came from (§2.1). `from_context` is filled by the
 *  context layer (a later step); rung 1 records `asked` / `stated`.
 *  `needs_confirm` is the §2.4 ASR read-back state: a voice-sourced
 *  write whose recognition confidence was low — the value is stored,
 *  but the slot does NOT settle until the traveler confirms the
 *  read-back (or corrects it with a fresh write). */
export type SlotProvenance = "asked" | "stated" | "from_context" | "inferred" | "needs_confirm";

/**
 * ASR confidence below this reads back before it settles (§2.4). One
 * config value, deliberately conservative: Deepgram-style confidences
 * cluster near 1.0 for clean speech, so 0.8 catches genuinely muddy
 * audio without interrogating every turn.
 */
export const ASR_CONFIDENCE_THRESHOLD = 0.8;

/** How a slot write arrived — drives the §2.4 read-back rule. */
export interface SlotWriteSource {
  channel: "text" | "voice";
  /** STT confidence in [0, 1] for voice turns; absent when unknown. */
  asrConfidence?: number;
}

/**
 * The read-back rule (§2.4), applied by the service to every slot
 * write: a VOICE write with known-low ASR confidence is stored as
 * `needs_confirm` — whatever provenance the model claimed, a shaky
 * hearing is never presented as settled fact. Text writes, voice
 * writes at/above the threshold, and voice writes with no confidence
 * signal are unaffected.
 */
export function applyAsrProvenance(
  provenance: SlotProvenance,
  source?: SlotWriteSource,
): SlotProvenance {
  if (
    source?.channel === "voice" &&
    source.asrConfidence !== undefined &&
    source.asrConfidence < ASR_CONFIDENCE_THRESHOLD
  ) {
    return "needs_confirm";
  }
  return provenance;
}

export interface DestinationSlot {
  kind: "place" | "region" | "vibe" | "unknown";
  text: string;
}

export interface PartyTraveler {
  name: string;
  email?: string;
}

export interface PartySlot {
  solo: boolean;
  travelers: PartyTraveler[];
}

export interface DatesSlot {
  startDate?: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  windowText?: string; // "late September", "the week of the 14th"
}

export type TierName = "white_glove" | "premium" | "family_budget";

export interface StyleSlot {
  text: string;
  tier?: TierName;
  /** Budget cap in minor units — a first-class intake input at Family Budget. */
  budgetCapMinor?: number;
  budgetCurrency?: string; // ISO 4217
}

export interface SlotValue<T> {
  value: T;
  provenance: SlotProvenance;
}

/**
 * The full machine state persisted in intake_sessions.slots (+ open_items
 * column). `materializedTripId` is NOT persisted here — it lives in the
 * row's draft_trip_id column and is passed in by the service.
 */
export interface IntakeData {
  intentCaptured: boolean;
  destination?: SlotValue<DestinationSlot>;
  party?: SlotValue<PartySlot>;
  dates?: SlotValue<DatesSlot>;
  style?: SlotValue<StyleSlot>;
  openItems: string[];
}

export class IntakeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeValidationError";
  }
}

export function emptyIntakeData(): IntakeData {
  return { intentCaptured: false, openItems: [] };
}

/** The traveler's first message in a session IS the intent statement. */
export function markIntent(data: IntakeData): IntakeData {
  return data.intentCaptured ? data : { ...data, intentCaptured: true };
}

// ─── Validation helpers ──────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email.trim());
}

export function isValidDateString(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function requireProvenance(p: SlotProvenance): SlotProvenance {
  if (!["asked", "stated", "from_context", "inferred", "needs_confirm"].includes(p)) {
    throw new IntakeValidationError(`Unknown slot provenance "${String(p)}".`);
  }
  return p;
}

// ─── Slot completeness ───────────────────────────────────────────────────────

/** Open-item key recording that one traveler's email was explicitly skipped. */
export function partyEmailOpenItem(travelerName: string): string {
  return `party_email:${travelerName.trim().toLowerCase()}`;
}

export const STYLE_BUDGET_OPEN_ITEM = "style_budget";

export function isPartyComplete(data: IntakeData): boolean {
  const party = data.party?.value;
  if (!party) return false;
  if (party.solo) return true;
  if (party.travelers.length === 0) return false;
  // Every named traveler needs an email, or an explicit skip of that email
  // (§2.2: individual emails may be completed during outreach).
  return party.travelers.every(
    (t) => (t.email !== undefined && isValidEmail(t.email)) || data.openItems.includes(partyEmailOpenItem(t.name)),
  );
}

export function isStyleComplete(data: IntakeData): boolean {
  const style = data.style?.value;
  if (!style) return false;
  // The budget cap is a first-class intake input at Family Budget (§2.2):
  // the style slot is not complete until the cap is captured or skipped.
  if (style.tier === "family_budget" && style.budgetCapMinor === undefined) {
    return data.openItems.includes(STYLE_BUDGET_OPEN_ITEM);
  }
  return true;
}

/** A slot is settled when captured (complete) or explicitly skipped.
 *  A `needs_confirm` value (§2.4) is captured but NOT settled: the
 *  read-back must complete first — which also keeps REVIEW (and so
 *  materialization) unreachable while a shaky hearing stands.
 *
 *  The needs_confirm check comes BEFORE the skip shortcut, on purpose:
 *  a skip recorded against a pending read-back must not launder an
 *  unconfirmed hearing into a settled slot. The skip stays on record
 *  (it is not an error, and the conversation is never blocked — the
 *  traveler can confirm or correct the hearing at any point); it takes
 *  effect the moment the read-back completes and the provenance flips
 *  to `stated`, while a correcting write clears it as usual. */
export function isSlotSettled(data: IntakeData, slot: SlotName): boolean {
  if (data[slot]?.provenance === "needs_confirm") return false;
  if (data.openItems.includes(slot)) return true;
  switch (slot) {
    case "destination":
      return data.destination !== undefined;
    case "party":
      return isPartyComplete(data);
    case "dates":
      return data.dates !== undefined;
    case "style":
      return isStyleComplete(data);
  }
}

const SLOT_ORDER: Array<{ slot: SlotName; state: IntakeStateName }> = [
  { slot: "destination", state: "DESTINATION" },
  { slot: "party", state: "PARTY" },
  { slot: "dates", state: "DATES" },
  { slot: "style", state: "STYLE" },
];

/** Derive the machine state from the data. Pure; the service persists it. */
export function deriveState(data: IntakeData, materializedTripId: number | null): IntakeStateName {
  if (materializedTripId !== null) return "MATERIALIZED";
  if (!data.intentCaptured) return "OPENING";
  for (const { slot, state } of SLOT_ORDER) {
    if (!isSlotSettled(data, slot)) return state;
  }
  return "REVIEW";
}

// ─── The next ask ────────────────────────────────────────────────────────────

export interface NextAsk {
  /** Stable identity of this ask (slot, or a sub-ask like a missing email). */
  key: string;
  slot: SlotName | "review";
  question: string;
}

/**
 * The §2.4 read-back question for a slot holding an unconfirmed
 * low-confidence hearing, or null when no slot needs one. The value is
 * read back EXACTLY as stored — the traveler confirms what Wander
 * heard, not a paraphrase.
 */
export function slotReadBackQuestion(data: IntakeData, slot: SlotName): string | null {
  const held = data[slot];
  if (!held || held.provenance !== "needs_confirm") return null;
  switch (slot) {
    case "destination":
      return `I heard "${data.destination!.value.text}" — is that right?`;
    case "party": {
      const p = data.party!.value;
      const heard = p.solo
        ? "just you going"
        : p.travelers
            .map((t) => (t.email ? `${t.name} (${t.email})` : t.name))
            .join(", ");
      return `I heard the party is ${heard} — is that right?`;
    }
    case "dates": {
      const d = data.dates!.value;
      const heard =
        d.startDate && d.endDate
          ? `${d.startDate} to ${d.endDate}`
          : (d.windowText ?? d.startDate ?? d.endDate ?? "");
      return `I heard ${heard} for the dates — is that right?`;
    }
    case "style":
      return `I heard "${data.style!.value.text}" for the kind of trip — is that right?`;
  }
}

/**
 * Exactly one next ask per turn (§2.2). The model voices this question —
 * it does not improvise its own ordering. A pending §2.4 read-back
 * outranks every other ask: the machine is parked on that slot until
 * the traveler confirms or corrects the hearing.
 */
export function nextAsk(data: IntakeData, materializedTripId: number | null): NextAsk | null {
  if (materializedTripId === null && data.intentCaptured) {
    for (const { slot } of SLOT_ORDER) {
      const question = slotReadBackQuestion(data, slot);
      if (question) return { key: `confirm:${slot}`, slot, question };
    }
  }
  const state = deriveState(data, materializedTripId);
  switch (state) {
    case "OPENING":
    case "DESTINATION":
      return { key: "destination", slot: "destination", question: "Ok, where are we going?" };
    case "PARTY": {
      const party = data.party?.value;
      if (!party || (!party.solo && party.travelers.length === 0)) {
        return {
          key: "party",
          slot: "party",
          question:
            "Who's going? Give me a name and email address for each traveler — or just say it's a solo trip.",
        };
      }
      const missing = party.travelers.find(
        (t) => !(t.email !== undefined && isValidEmail(t.email)) && !data.openItems.includes(partyEmailOpenItem(t.name)),
      );
      if (missing) {
        return {
          key: partyEmailOpenItem(missing.name),
          slot: "party",
          question: `What's ${missing.name}'s email address?`,
        };
      }
      // Party is settled but a later slot regressed us here — fall through
      // to the dates ask rather than re-asking the party question.
      return { key: "dates", slot: "dates", question: "When are you thinking of going?" };
    }
    case "DATES":
      return { key: "dates", slot: "dates", question: "When are you thinking of going?" };
    case "STYLE": {
      const style = data.style?.value;
      if (style && style.tier === "family_budget" && style.budgetCapMinor === undefined) {
        return {
          key: STYLE_BUDGET_OPEN_ITEM,
          slot: "style",
          question: "What's the total budget cap for the trip?",
        };
      }
      return { key: "style", slot: "style", question: "What kind of trip is this?" };
    }
    case "REVIEW":
      return { key: "review", slot: "review", question: "Shall I set this trip up?" };
    case "MATERIALIZED":
      return null;
  }
}

// ─── Slot writes & skips (corrections are writes, never restarts) ────────────

function validateDestination(v: DestinationSlot): DestinationSlot {
  const text = (v.text ?? "").trim();
  if (!text) throw new IntakeValidationError("Destination text must not be empty.");
  if (!["place", "region", "vibe", "unknown"].includes(v.kind)) {
    throw new IntakeValidationError(`Unknown destination kind "${String(v.kind)}".`);
  }
  return { kind: v.kind, text };
}

function validateParty(v: PartySlot): PartySlot {
  if (v.solo) return { solo: true, travelers: [] };
  const travelers = (v.travelers ?? []).map((t) => {
    const name = (t.name ?? "").trim();
    if (!name) throw new IntakeValidationError("Every traveler needs a name.");
    const email = t.email?.trim() ? t.email.trim() : undefined;
    if (email !== undefined && !isValidEmail(email)) {
      throw new IntakeValidationError(`"${email}" doesn't look like a valid email address for ${name}.`);
    }
    return email !== undefined ? { name, email } : { name };
  });
  if (travelers.length === 0) {
    throw new IntakeValidationError("Party must be solo or name at least one traveler.");
  }
  return { solo: false, travelers };
}

function validateDates(v: DatesSlot): DatesSlot {
  const out: DatesSlot = {};
  if (v.startDate !== undefined) {
    if (!isValidDateString(v.startDate)) {
      throw new IntakeValidationError(`Start date "${v.startDate}" is not a valid YYYY-MM-DD date.`);
    }
    out.startDate = v.startDate;
  }
  if (v.endDate !== undefined) {
    if (!isValidDateString(v.endDate)) {
      throw new IntakeValidationError(`End date "${v.endDate}" is not a valid YYYY-MM-DD date.`);
    }
    out.endDate = v.endDate;
  }
  if (out.startDate && out.endDate && out.endDate < out.startDate) {
    throw new IntakeValidationError("End date is before the start date.");
  }
  if (v.windowText?.trim()) out.windowText = v.windowText.trim();
  if (!out.startDate && !out.endDate && !out.windowText) {
    throw new IntakeValidationError("Dates need exact dates, a range, or a window description.");
  }
  return out;
}

function validateStyle(v: StyleSlot): StyleSlot {
  const text = (v.text ?? "").trim();
  if (!text) throw new IntakeValidationError("Trip style/purpose must not be empty.");
  const out: StyleSlot = { text };
  if (v.tier !== undefined) {
    if (!["white_glove", "premium", "family_budget"].includes(v.tier)) {
      throw new IntakeValidationError(`Unknown tier "${String(v.tier)}".`);
    }
    out.tier = v.tier;
  }
  if (v.budgetCapMinor !== undefined) {
    if (!Number.isInteger(v.budgetCapMinor) || v.budgetCapMinor <= 0) {
      throw new IntakeValidationError("Budget cap must be a positive integer of minor units.");
    }
    out.budgetCapMinor = v.budgetCapMinor;
    if (v.budgetCurrency !== undefined) {
      if (!/^[A-Z]{3}$/.test(v.budgetCurrency)) {
        throw new IntakeValidationError(`Budget currency "${v.budgetCurrency}" is not an ISO 4217 code.`);
      }
      out.budgetCurrency = v.budgetCurrency;
    }
  }
  return out;
}

export type SlotWrite =
  | { slot: "destination"; value: DestinationSlot; provenance: SlotProvenance }
  | { slot: "party"; value: PartySlot; provenance: SlotProvenance }
  | { slot: "dates"; value: DatesSlot; provenance: SlotProvenance }
  | { slot: "style"; value: StyleSlot; provenance: SlotProvenance };

/**
 * Apply one slot write. Valid from ANY state — a correction ("actually,
 * make it six of us") writes the slot and the machine recomputes where it
 * stands; the conversation never restarts (Story 1.3). Writing a slot
 * clears any skip recorded against it.
 */
export function applySlotWrite(data: IntakeData, write: SlotWrite): IntakeData {
  const provenance = requireProvenance(write.provenance);
  const openItems = data.openItems.filter((i) => i !== write.slot);
  switch (write.slot) {
    case "destination":
      return { ...data, openItems, destination: { value: validateDestination(write.value), provenance } };
    case "party":
      return { ...data, openItems, party: { value: validateParty(write.value), provenance } };
    case "dates":
      return { ...data, openItems, dates: { value: validateDates(write.value), provenance } };
    case "style":
      return { ...data, openItems, style: { value: validateStyle(write.value), provenance } };
  }
}

/**
 * Settle a §2.4 read-back: the traveler confirmed what Wander heard.
 * The value stands; provenance becomes `stated` (the traveler has now
 * plainly stated it). A no-op for slots not awaiting confirmation.
 */
export function applySlotConfirmation(data: IntakeData, slot: SlotName): IntakeData {
  const held = data[slot];
  if (!held || held.provenance !== "needs_confirm") return data;
  return { ...data, [slot]: { value: held.value, provenance: "stated" as SlotProvenance } };
}

/**
 * Record an explicit skip: a whole slot ("not sure about dates yet") or a
 * sub-item (`party_email:<name>`, `style_budget`). A skip marks the item
 * open and lets the machine advance — it never blocks (Story 1.3).
 *
 * §2.4 interaction: skipping a slot that holds a `needs_confirm` value
 * records the skip but does NOT settle the slot and does NOT discard
 * the hearing — `isSlotSettled` ranks the pending read-back above the
 * skip, so the unconfirmed value can never be consumed (least of all
 * by materialization) while it stands. The traveler resolves it by
 * confirming the read-back (the recorded skip then applies) or by
 * correcting it with a fresh write (which clears the skip, as any
 * write does).
 */
export function applySkip(data: IntakeData, item: string): IntakeData {
  const key = item.trim();
  if (!key) throw new IntakeValidationError("Skip item must not be empty.");
  if (data.openItems.includes(key)) return data;
  return { ...data, openItems: [...data.openItems, key] };
}

// ─── Review summary ──────────────────────────────────────────────────────────

function provenanceNote(p: SlotProvenance): string {
  if (p === "from_context") return " (from your profile — say the word to change it)";
  if (p === "inferred") return " (my best guess — correct me if wrong)";
  if (p === "needs_confirm") return " (as heard by voice — awaiting your confirmation)";
  return "";
}

function humanizeOpenItem(item: string): string {
  if (item.startsWith("party_email:")) return `email for ${item.slice("party_email:".length)}`;
  if (item === STYLE_BUDGET_OPEN_ITEM) return "budget cap";
  return item;
}

/** The assembled summary the traveler confirms at REVIEW (Story 1.3/6.5). */
export function buildReviewSummary(data: IntakeData): string[] {
  const lines: string[] = [];
  if (data.destination) {
    lines.push(`Destination: ${data.destination.value.text}${provenanceNote(data.destination.provenance)}`);
  } else {
    lines.push("Destination: not decided yet (open)");
  }
  if (data.party) {
    const p = data.party.value;
    if (p.solo) {
      lines.push(`Who's going: just you${provenanceNote(data.party.provenance)}`);
    } else {
      const names = p.travelers
        .map((t) => (t.email ? `${t.name} (${t.email})` : `${t.name} (email pending)`))
        .join(", ");
      lines.push(`Who's going: you + ${names}${provenanceNote(data.party.provenance)}`);
    }
  } else {
    lines.push("Who's going: not decided yet (open)");
  }
  if (data.dates) {
    const d = data.dates.value;
    const when =
      d.startDate && d.endDate
        ? `${d.startDate} → ${d.endDate}`
        : d.windowText ?? (d.startDate ? `from ${d.startDate}` : `until ${d.endDate}`);
    lines.push(`Dates: ${when}${provenanceNote(data.dates.provenance)}`);
  } else {
    lines.push("Dates: not decided yet (open)");
  }
  if (data.style) {
    const s = data.style.value;
    let line = `Kind of trip: ${s.text}`;
    if (s.tier) line += ` [${s.tier.replace("_", " ")}]`;
    if (s.budgetCapMinor !== undefined) {
      line += ` — budget cap ${s.budgetCapMinor} minor units${s.budgetCurrency ? ` ${s.budgetCurrency}` : ""}`;
    }
    lines.push(line + provenanceNote(data.style.provenance));
  } else {
    lines.push("Kind of trip: not decided yet (open)");
  }
  if (data.openItems.length > 0) {
    lines.push(`Still open: ${data.openItems.map(humanizeOpenItem).join(", ")}`);
  }
  return lines;
}

// ─── Materialization plan (pure; the service executes it in a transaction) ──

export interface MaterializationPlan {
  trip: {
    title: string;
    destination: string;
    startDate: string;
    endDate: string;
    status: "planning";
  };
  roster: Array<{ invitedName: string; invitedEmail: string | null }>;
}

export type MaterializationCheck =
  | { ok: true; plan: MaterializationPlan }
  | { ok: false; reason: string };

/**
 * §2.3: a draft trip materializes only from settled intake with an exact
 * date window. A dateless intent stays an intake session — never a fake
 * trip with invented dates.
 */
export function buildMaterializationPlan(data: IntakeData): MaterializationCheck {
  // §2.4, enforced at the consumption site as well as in isSlotSettled:
  // an unconfirmed hearing never reaches a materialized trip, however
  // the machine state was arrived at.
  for (const { slot } of SLOT_ORDER) {
    if (data[slot]?.provenance === "needs_confirm") {
      return {
        ok: false,
        reason:
          `The ${slot} from your voice answer hasn't been confirmed yet — ` +
          "it needs the read-back confirmation before a trip can be created from it.",
      };
    }
  }
  if (deriveState(data, null) !== "REVIEW") {
    return { ok: false, reason: "Intake is not complete enough to review yet." };
  }
  const destination = data.destination?.value;
  if (!destination) {
    return { ok: false, reason: "No destination captured — a trip needs somewhere to go." };
  }
  const dates = data.dates?.value;
  if (!dates?.startDate || !dates?.endDate) {
    return {
      ok: false,
      reason:
        "Exact start and end dates are needed before the draft trip can be created — " +
        "a date window alone stays an intake session, never a fake trip.",
    };
  }
  const style = data.style?.value;
  const title = style ? `${destination.text} — ${style.text}` : destination.text;
  const roster = (data.party?.value.travelers ?? []).map((t) => ({
    invitedName: t.name,
    invitedEmail: t.email ?? null,
  }));
  return {
    ok: true,
    plan: {
      trip: {
        title,
        destination: destination.text,
        startDate: dates.startDate,
        endDate: dates.endDate,
        status: "planning",
      },
      roster,
    },
  };
}
