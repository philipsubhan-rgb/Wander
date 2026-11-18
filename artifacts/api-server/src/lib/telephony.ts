/**
 * Telephony provider seam — the dialer behind the Concierge-Call
 * Service (architecture-north-star §6.5; api-ecosystem-map §10).
 *
 * The provider is Twilio-shaped (Programmable Voice), behind a small
 * interface so tests inject fakes and NO live call exists in this
 * build: there are no Twilio keys in any environment the build can
 * run in, so the client is exercised only against mocked fetch
 * responses shaped from Twilio's documented REST API. Configuration
 * is env-keyed and fails plainly: with no keys the provider is simply
 * absent (null) and the call service says so — it never pretends to
 * have dialed.
 *
 * ── The ConversationRelay contract (how a live call is driven) ──
 *
 * `createCall` points Twilio at Wander's call URL. When the venue
 * answers, Twilio fetches that URL and expects TwiML that hands the
 * audio to the conversation relay:
 *
 *   <Response>
 *     <Connect>
 *       <ConversationRelay url="wss://<wander-host>/calls/relay"
 *                          welcomeGreeting="Hello, I'm calling on behalf of …"
 *                          language="en-US" />
 *     </Connect>
 *   </Response>
 *
 * Over that socket the relay session exchanges the documented
 * ConversationRelay messages: `setup` (session metadata incl. the
 * brief/task ids in customParameters), `prompt` (the venue's speech,
 * transcribed — Deepgram-class STT), `interrupt`, `dtmf`, `error`.
 * The call driver replies with `text` messages (the agent's next
 * utterance — ElevenLabs-class TTS), token-streamed, `last: true` at
 * utterance end. The speech stack is the SAME provider seam as the
 * in-app Voice Gateway (lib/voiceProviders.ts) — one stack, two
 * transports, per the ecosystem map.
 *
 * The driver conducts the call strictly from the stored brief
 * (conciergeCalls.ts): the ask, the ranked fallbacks, the may-not
 * list, the authority cap. When payment is needed it reads the
 * single-use virtual card's details (virtualCards.ts) from the live
 * session only — and per international-foundation §3.4 the driver
 * MUST pause/redact the recording and the transcript around any card
 * digits it speaks: card details never enter the transcript, the
 * recording, or any log. At session end the driver calls
 * `ConciergeCallService.recordOutcome` with the structured outcome +
 * transcript; provider status callbacks land in
 * `handleStatusCallback`. Recording: calls are recorded
 * (Record=true) for the brief/outcome audit trail, and the recording
 * reference lands on the task — the consent/recording policy per
 * jurisdiction is Phil's Packet #1 decision and gates any live use.
 */

import { logger } from "./logger";

// ─── Interface ───────────────────────────────────────────────────────────────

export interface CreateCallInput {
  /** Destination number, E.164. */
  to: string;
  /** Wander's caller number, E.164. */
  from: string;
  /** URL Twilio fetches for TwiML when the call is answered (the
   * ConversationRelay connect document — see the header contract). */
  callUrl: string;
  /** URL for provider status callbacks. */
  statusCallbackUrl?: string;
  /** Hard call-length cap in seconds — Twilio's TimeLimit enforces
   * the brief's duration cap at the provider, not by goodwill. */
  timeLimitSeconds: number;
  /** Record the call for the brief/outcome audit trail. */
  record?: boolean;
  /** Answering-machine detection (the outcome evaluator distinguishes
   * voicemail from a person; AMD is how the driver knows). */
  machineDetection?: boolean;
}

export interface CreatedCall {
  providerCallId: string;
  status: string;
}

export interface TelephonyProvider {
  readonly id: string;
  createCall(input: CreateCallInput): Promise<CreatedCall>;
}

export class TelephonyError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "TelephonyError";
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_FETCH: FetchFn = (input, init) => fetch(input, init);
const PROVIDER_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  provider: string,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new TelephonyError(provider, `${provider} request timed out after ${PROVIDER_TIMEOUT_MS / 1000}s`);
    }
    throw new TelephonyError(
      provider,
      `${provider} request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Twilio (Programmable Voice) ─────────────────────────────────────────────

export interface TwilioTelephonyOptions {
  accountSid: string;
  authToken: string;
  /** Default caller number (E.164) — Wander's branded outbound line. */
  fromNumber: string;
  fetchFn?: FetchFn;
  baseUrl?: string;
}

/**
 * Twilio Calls resource (POST /2010-04-01/Accounts/{Sid}/Calls.json,
 * form-encoded, HTTP Basic auth with Sid:Token). One create per dial
 * — a call is a real-world act; the service, not the client, owns any
 * retry decision (the stated attempt pattern, Story 4.5).
 */
export class TwilioTelephonyProvider implements TelephonyProvider {
  readonly id = "twilio";
  private readonly accountSid: string;
  private readonly authToken: string;
  readonly fromNumber: string;
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;

  constructor(opts: TwilioTelephonyOptions) {
    this.accountSid = opts.accountSid;
    this.authToken = opts.authToken;
    this.fromNumber = opts.fromNumber;
    this.fetchFn = opts.fetchFn ?? DEFAULT_FETCH;
    this.baseUrl = opts.baseUrl ?? "https://api.twilio.com";
  }

  async createCall(input: CreateCallInput): Promise<CreatedCall> {
    const form = new URLSearchParams({
      To: input.to,
      From: input.from,
      Url: input.callUrl,
      TimeLimit: String(input.timeLimitSeconds),
      Record: input.record === false ? "false" : "true",
    });
    if (input.statusCallbackUrl) {
      form.set("StatusCallback", input.statusCallbackUrl);
      form.set("StatusCallbackMethod", "POST");
    }
    if (input.machineDetection !== false) {
      form.set("MachineDetection", "Enable");
    }
    const auth = Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64");
    const res = await fetchWithTimeout(
      this.fetchFn,
      `${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Calls.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
      this.id,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new TelephonyError(this.id, `Twilio error (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { sid?: string; status?: string };
    if (!data.sid) {
      throw new TelephonyError(this.id, "Twilio accepted the request but returned no call id.");
    }
    return { providerCallId: data.sid, status: data.status ?? "queued" };
  }
}

// ─── Env wiring + test seam ──────────────────────────────────────────────────

export interface TelephonyConfig {
  provider: TelephonyProvider | null;
  /** Wander's outbound caller number (also the brief's default callback). */
  fromNumber: string | null;
  /** The call URL Twilio fetches for the ConversationRelay TwiML. */
  callUrl: string | null;
  statusCallbackUrl: string | null;
}

/**
 * Build the telephony config from the environment. Missing keys yield
 * a null provider — the service reports "telephony isn't configured"
 * plainly rather than simulating a dial.
 */
export function telephonyFromEnv(env: NodeJS.ProcessEnv = process.env): TelephonyConfig {
  const sid = env.TWILIO_ACCOUNT_SID;
  const token = env.TWILIO_AUTH_TOKEN;
  const fromNumber = env.TWILIO_FROM_NUMBER ?? null;
  const callUrl = env.TWILIO_CALL_URL ?? null;
  const statusCallbackUrl = env.TWILIO_STATUS_CALLBACK_URL ?? null;
  if (!sid || !token || !fromNumber) {
    return { provider: null, fromNumber, callUrl, statusCallbackUrl };
  }
  return {
    provider: new TwilioTelephonyProvider({
      accountSid: sid,
      authToken: token,
      fromNumber,
    }),
    fromNumber,
    callUrl,
    statusCallbackUrl,
  };
}

let cachedConfig: TelephonyConfig | null = null;
let testConfig: TelephonyConfig | null | undefined;

/** The process-wide telephony config (env-built, cached). */
export function getTelephonyConfig(): TelephonyConfig {
  if (testConfig !== undefined) {
    return testConfig ?? { provider: null, fromNumber: null, callUrl: null, statusCallbackUrl: null };
  }
  if (!cachedConfig) {
    cachedConfig = telephonyFromEnv();
    logger.info(
      { provider: cachedConfig.provider?.id ?? null },
      "[Telephony] provider resolved",
    );
  }
  return cachedConfig;
}

/** Test seam (same pattern as the voice providers'): replace the
 * config, or pass null to restore env resolution. */
export function setTelephonyConfigForTests(config: TelephonyConfig | null): void {
  testConfig = config === null ? undefined : config;
}
