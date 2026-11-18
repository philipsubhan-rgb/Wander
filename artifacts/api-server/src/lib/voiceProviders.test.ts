/**
 * Voice providers — client contract tests against mocked fetch
 * (payloads shaped from the providers' documented APIs; no live call
 * exists or is possible — no keys in this environment).
 *
 * What's asserted: the Deepgram request carries the session language
 * and token auth, and its transcript/confidence parse; the ElevenLabs
 * request carries the text + model + ISO-639-1 language_code derived
 * from the session's BCP 47 tag, and returns audio bytes; provider
 * HTTP errors surface as VoiceProviderError (never a fake result);
 * the env builder yields null providers — plainly unconfigured —
 * when keys are absent.
 */

import { describe, it, expect, vi } from "vitest";
import {
  DeepgramSttProvider,
  ElevenLabsTtsProvider,
  VoiceProviderError,
  primaryLanguageSubtag,
  voiceProvidersFromEnv,
} from "./voiceProviders";

interface CapturedCall {
  url: string;
  init?: RequestInit;
}

function fakeFetch(response: () => Response) {
  const calls: CapturedCall[] = [];
  const fetchFn = vi.fn(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init });
    return response();
  });
  return { calls, fetchFn };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => null },
  } as unknown as Response;
}

const DEEPGRAM_PAYLOAD = {
  results: {
    channels: [
      {
        detected_language: "en",
        alternatives: [{ transcript: "I want to plan a trip to Munich.", confidence: 0.98 }],
      },
    ],
  },
};

describe("DeepgramSttProvider", () => {
  it("posts the audio to /v1/listen with token auth, model, and the session language", async () => {
    const { calls, fetchFn } = fakeFetch(() => jsonResponse(DEEPGRAM_PAYLOAD));
    const stt = new DeepgramSttProvider({ key: "dg-test", fetchFn });
    const audio = Buffer.from("fake-audio-bytes");
    const result = await stt.transcribe(audio, { language: "en-US", contentType: "audio/webm" });

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0].url);
    expect(url.origin + url.pathname).toBe("https://api.deepgram.com/v1/listen");
    expect(url.searchParams.get("model")).toBe("nova-3");
    expect(url.searchParams.get("language")).toBe("en-US");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Token dg-test");
    expect(headers["Content-Type"]).toBe("audio/webm");
    expect(result.text).toBe("I want to plan a trip to Munich.");
    expect(result.confidence).toBe(0.98);
    expect(result.language).toBe("en");
  });

  it("omits the language param when the session has no language (no invented default)", async () => {
    const { calls, fetchFn } = fakeFetch(() => jsonResponse(DEEPGRAM_PAYLOAD));
    const stt = new DeepgramSttProvider({ key: "dg-test", fetchFn });
    await stt.transcribe(Buffer.from("x"), {});
    const url = new URL(calls[0].url);
    expect(url.searchParams.has("language")).toBe(false);
  });

  it("returns an empty transcript as empty text (the session turns that into a retry)", async () => {
    const { fetchFn } = fakeFetch(() =>
      jsonResponse({ results: { channels: [{ alternatives: [{ transcript: "  ", confidence: 0.1 }] }] } }),
    );
    const stt = new DeepgramSttProvider({ key: "dg-test", fetchFn });
    const result = await stt.transcribe(Buffer.from("x"), {});
    expect(result.text).toBe("");
  });

  it("surfaces an HTTP error as VoiceProviderError — never a fabricated transcript", async () => {
    const { fetchFn } = fakeFetch(() => jsonResponse({ error: "bad key" }, 401));
    const stt = new DeepgramSttProvider({ key: "dg-test", fetchFn });
    await expect(stt.transcribe(Buffer.from("x"), {})).rejects.toBeInstanceOf(VoiceProviderError);
  });
});

describe("ElevenLabsTtsProvider", () => {
  it("posts text + model and derives language_code from the BCP 47 session language", async () => {
    const audioBytes = new Uint8Array([1, 2, 3, 4]);
    const { calls, fetchFn } = fakeFetch(
      () =>
        ({
          ok: true,
          status: 200,
          arrayBuffer: async () => audioBytes.buffer,
          text: async () => "",
          headers: { get: (n: string) => (n === "content-type" ? "audio/mpeg" : null) },
        }) as unknown as Response,
    );
    const tts = new ElevenLabsTtsProvider({ key: "el-test", fetchFn });
    const result = await tts.synthesize("Total: $612.00", { language: "es-ES" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM");
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers["xi-api-key"]).toBe("el-test");
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(body.text).toBe("Total: $612.00");
    expect(body.model_id).toBe("eleven_multilingual_v2");
    expect(body.language_code).toBe("es");
    expect(Buffer.isBuffer(result.audio)).toBe(true);
    expect(result.audio.length).toBe(4);
    expect(result.contentType).toBe("audio/mpeg");
  });

  it("omits language_code when the session has no language", async () => {
    const { calls, fetchFn } = fakeFetch(
      () =>
        ({
          ok: true,
          status: 200,
          arrayBuffer: async () => new Uint8Array([9]).buffer,
          text: async () => "",
          headers: { get: () => null },
        }) as unknown as Response,
    );
    const tts = new ElevenLabsTtsProvider({ key: "el-test", fetchFn });
    await tts.synthesize("Hello", {});
    const body = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect("language_code" in body).toBe(false);
  });

  it("surfaces an HTTP error as VoiceProviderError", async () => {
    const { fetchFn } = fakeFetch(() => jsonResponse({ detail: "quota" }, 429));
    const tts = new ElevenLabsTtsProvider({ key: "el-test", fetchFn });
    await expect(tts.synthesize("Hello", {})).rejects.toBeInstanceOf(VoiceProviderError);
  });
});

describe("primaryLanguageSubtag", () => {
  it("reduces BCP 47 tags to their primary subtag", () => {
    expect(primaryLanguageSubtag("es-ES")).toBe("es");
    expect(primaryLanguageSubtag("en-US")).toBe("en");
    expect(primaryLanguageSubtag("de")).toBe("de");
    expect(primaryLanguageSubtag("PT-br")).toBe("pt");
  });
});

describe("voiceProvidersFromEnv", () => {
  it("yields null providers when no keys are set (plainly unconfigured)", () => {
    const providers = voiceProvidersFromEnv({});
    expect(providers.stt).toBeNull();
    expect(providers.tts).toBeNull();
  });

  it("builds each provider independently from its own key", () => {
    const onlyStt = voiceProvidersFromEnv({ DEEPGRAM_API_KEY: "dg" });
    expect(onlyStt.stt?.id).toBe("deepgram");
    expect(onlyStt.tts).toBeNull();
    const onlyTts = voiceProvidersFromEnv({ ELEVENLABS_API_KEY: "el" });
    expect(onlyTts.stt).toBeNull();
    expect(onlyTts.tts?.id).toBe("elevenlabs");
  });
});
