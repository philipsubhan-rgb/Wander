/**
 * Voice providers — the speech seam behind the Voice Gateway
 * (architecture-north-star §2.4; api-ecosystem-map §10).
 *
 * Speech-to-text is Deepgram-shaped and text-to-speech is
 * ElevenLabs-shaped, each behind a small interface so tests inject
 * fakes and no live call exists in this build: there are no provider
 * keys in any environment the build can run in, so both clients are
 * exercised only against mocked fetch responses shaped from the
 * providers' documented APIs. Live verification awaits the keys
 * (Packet #1 territory, alongside Duffel/FlightAware).
 *
 * Configuration is env-keyed and fails plainly: a provider whose key
 * is unset is simply absent (null), and the voice channel says so —
 * it never fabricates a transcript or silent audio.
 */

import { logger } from "./logger";

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface SttResult {
  text: string;
  /** Provider confidence 0..1 when the provider reports one. */
  confidence?: number;
  /** Language the provider detected/used, when reported. */
  language?: string;
}

export interface SpeechToTextProvider {
  readonly id: string;
  transcribe(
    audio: Buffer,
    opts: { language?: string; contentType?: string },
  ): Promise<SttResult>;
}

export interface TtsResult {
  audio: Buffer;
  contentType: string;
}

export interface TextToSpeechProvider {
  readonly id: string;
  synthesize(text: string, opts: { language?: string }): Promise<TtsResult>;
}

export interface VoiceProviders {
  stt: SpeechToTextProvider | null;
  tts: TextToSpeechProvider | null;
}

export class VoiceProviderError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const DEFAULT_FETCH: FetchFn = (input, init) => fetch(input, init);

/** Bound each provider call: a hung speech API must not hang a turn. */
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
      throw new VoiceProviderError(provider, `${provider} request timed out after ${PROVIDER_TIMEOUT_MS / 1000}s`);
    }
    throw new VoiceProviderError(
      provider,
      `${provider} request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timeout);
  }
}

// ─── Deepgram (speech-to-text) ───────────────────────────────────────────────

export interface DeepgramSttOptions {
  key: string;
  fetchFn?: FetchFn;
  baseUrl?: string;
  /** Deepgram model id; nova-3 is the current general model. */
  model?: string;
}

/**
 * Deepgram prerecorded transcription (POST /v1/listen). The spike
 * sends one complete utterance per call — push-to-talk shape. (True
 * streaming ASR over a media socket is a transport upgrade for the
 * Capacitor client task; the turn contract does not change.)
 */
export class DeepgramSttProvider implements SpeechToTextProvider {
  readonly id = "deepgram";
  private readonly key: string;
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(opts: DeepgramSttOptions) {
    this.key = opts.key;
    this.fetchFn = opts.fetchFn ?? DEFAULT_FETCH;
    this.baseUrl = opts.baseUrl ?? "https://api.deepgram.com";
    this.model = opts.model ?? "nova-3";
  }

  async transcribe(
    audio: Buffer,
    opts: { language?: string; contentType?: string },
  ): Promise<SttResult> {
    const params = new URLSearchParams({
      model: this.model,
      smart_format: "true",
      punctuate: "true",
    });
    // The session's conversation_language flows straight through:
    // Deepgram accepts BCP 47 tags ("en", "en-US", "es", "de", …).
    // Absent a session language, Deepgram language detection is left
    // to the provider default — no language is invented here.
    if (opts.language) params.set("language", opts.language);

    const res = await fetchWithTimeout(
      this.fetchFn,
      `${this.baseUrl}/v1/listen?${params.toString()}`,
      {
        method: "POST",
        headers: {
          Authorization: `Token ${this.key}`,
          "Content-Type": opts.contentType ?? "audio/webm",
        },
        body: new Uint8Array(audio),
      },
      this.id,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new VoiceProviderError(this.id, `Deepgram error (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      results?: {
        channels?: Array<{
          detected_language?: string;
          alternatives?: Array<{ transcript?: string; confidence?: number }>;
        }>;
      };
    };
    const channel = data.results?.channels?.[0];
    const alt = channel?.alternatives?.[0];
    return {
      text: (alt?.transcript ?? "").trim(),
      confidence: typeof alt?.confidence === "number" ? alt.confidence : undefined,
      language: channel?.detected_language,
    };
  }
}

// ─── ElevenLabs (text-to-speech) ─────────────────────────────────────────────

export interface ElevenLabsTtsOptions {
  key: string;
  fetchFn?: FetchFn;
  baseUrl?: string;
  /** Voice id; defaults to ElevenLabs' documented sample voice. */
  voiceId?: string;
  modelId?: string;
}

/** BCP 47 → ISO 639-1 primary subtag ("es-ES" → "es", "de" → "de"). */
export function primaryLanguageSubtag(tag: string): string {
  return tag.split("-")[0].toLowerCase();
}

export class ElevenLabsTtsProvider implements TextToSpeechProvider {
  readonly id = "elevenlabs";
  private readonly key: string;
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;
  private readonly voiceId: string;
  private readonly modelId: string;

  constructor(opts: ElevenLabsTtsOptions) {
    this.key = opts.key;
    this.fetchFn = opts.fetchFn ?? DEFAULT_FETCH;
    this.baseUrl = opts.baseUrl ?? "https://api.elevenlabs.io";
    // "Rachel" — the voice id used throughout ElevenLabs' own API docs.
    this.voiceId = opts.voiceId ?? "21m00Tcm4TlvDq8ikWAM";
    this.modelId = opts.modelId ?? "eleven_multilingual_v2";
  }

  async synthesize(text: string, opts: { language?: string }): Promise<TtsResult> {
    const body: Record<string, unknown> = {
      text,
      model_id: this.modelId,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
    };
    // ElevenLabs takes an ISO 639-1 language_code; the session's
    // BCP 47 conversation_language is reduced to its primary subtag.
    if (opts.language) body.language_code = primaryLanguageSubtag(opts.language);

    const res = await fetchWithTimeout(
      this.fetchFn,
      `${this.baseUrl}/v1/text-to-speech/${this.voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": this.key,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify(body),
      },
      this.id,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new VoiceProviderError(this.id, `ElevenLabs error (HTTP ${res.status}): ${text.slice(0, 200)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      audio: buf,
      contentType: res.headers.get("content-type") ?? "audio/mpeg",
    };
  }
}

// ─── Env wiring + test seam ──────────────────────────────────────────────────

/**
 * Build the provider set from the environment. A missing key yields a
 * null provider — the channel reports that plainly (see voiceSession);
 * nothing here invents a fallback provider.
 */
export function voiceProvidersFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceProviders {
  const deepgramKey = env.DEEPGRAM_API_KEY;
  const elevenLabsKey = env.ELEVENLABS_API_KEY;
  return {
    stt: deepgramKey
      ? new DeepgramSttProvider({
          key: deepgramKey,
          ...(env.DEEPGRAM_MODEL ? { model: env.DEEPGRAM_MODEL } : {}),
        })
      : null,
    tts: elevenLabsKey
      ? new ElevenLabsTtsProvider({
          key: elevenLabsKey,
          ...(env.ELEVENLABS_VOICE_ID ? { voiceId: env.ELEVENLABS_VOICE_ID } : {}),
          ...(env.ELEVENLABS_MODEL_ID ? { modelId: env.ELEVENLABS_MODEL_ID } : {}),
        })
      : null,
  };
}

let cachedProviders: VoiceProviders | null = null;
let testProviders: VoiceProviders | null | undefined;

/** The process-wide provider set (env-built, cached). */
export function getVoiceProviders(): VoiceProviders {
  if (testProviders !== undefined) return testProviders ?? { stt: null, tts: null };
  if (!cachedProviders) {
    cachedProviders = voiceProvidersFromEnv();
    logger.info(
      {
        stt: cachedProviders.stt?.id ?? null,
        tts: cachedProviders.tts?.id ?? null,
      },
      "[Voice] providers resolved",
    );
  }
  return cachedProviders;
}

/** Test seam (same pattern as the booking gate's): replace the
 * provider set, or pass null to restore env resolution. */
export function setVoiceProvidersForTests(providers: VoiceProviders | null): void {
  testProviders = providers === null ? undefined : providers;
}
