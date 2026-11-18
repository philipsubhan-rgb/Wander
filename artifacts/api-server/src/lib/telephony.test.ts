/**
 * Telephony seam — the Twilio-shaped provider behind its interface.
 * No live calls: the fetch is mocked and the request SHAPE is what is
 * asserted (endpoint, auth, form fields, the brief's duration cap as
 * the provider TimeLimit), plus the env wiring that leaves the
 * provider null — plainly unconfigured — when keys are absent.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TelephonyError,
  TwilioTelephonyProvider,
  setTelephonyConfigForTests,
  telephonyFromEnv,
} from "./telephony";

const ENV_KEYS = [
  "TWILIO_ACCOUNT_SID",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_FROM_NUMBER",
  "TWILIO_CALL_URL",
  "TWILIO_STATUS_CALLBACK_URL",
] as const;

function clearTwilioEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

afterEach(() => {
  clearTwilioEnv();
  setTelephonyConfigForTests(null);
  vi.unstubAllGlobals();
});

describe("telephonyFromEnv", () => {
  it("has no provider — plainly unconfigured — with no keys", () => {
    clearTwilioEnv();
    const config = telephonyFromEnv();
    expect(config.provider).toBeNull();
    expect(config.fromNumber).toBeNull();
    expect(config.callUrl).toBeNull();
  });

  it("has no provider with only some keys (a partial config is no config)", () => {
    clearTwilioEnv();
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "secret";
    expect(telephonyFromEnv().provider).toBeNull();
  });

  it("wires the provider, from-number, and URLs when fully keyed", () => {
    process.env.TWILIO_ACCOUNT_SID = "AC123";
    process.env.TWILIO_AUTH_TOKEN = "secret";
    process.env.TWILIO_FROM_NUMBER = "+15550100";
    process.env.TWILIO_CALL_URL = "https://example.test/voice";
    const config = telephonyFromEnv();
    expect(config?.provider?.id).toBe("twilio");
    expect(config?.fromNumber).toBe("+15550100");
    expect(config?.callUrl).toBe("https://example.test/voice");
  });
});

describe("TwilioTelephonyProvider.createCall", () => {
  function providerWithFetch(fetchFn: (url: string, init?: RequestInit) => Promise<Response>) {
    return new TwilioTelephonyProvider({
      accountSid: "AC123",
      authToken: "secret-token",
      fromNumber: "+15550100",
      fetchFn,
    });
  }

  it("POSTs the Twilio call-create shape with the brief's duration cap as TimeLimit", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      seenUrl = url;
      seenInit = init;
      return new Response(JSON.stringify({ sid: "CA999", status: "queued" }), { status: 201 });
    }) as unknown as typeof fetch;

    const result = await providerWithFetch(fetchImpl).createCall({
      to: "+33142000000",
      from: "+15550100",
      callUrl: "https://example.test/voice",
      statusCallbackUrl: "https://example.test/status",
      timeLimitSeconds: 600,
      record: true,
      machineDetection: true,
    });

    expect(result).toEqual({ providerCallId: "CA999", status: "queued" });
    expect(seenUrl).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json");
    const headers = seenInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(
      `Basic ${Buffer.from("AC123:secret-token").toString("base64")}`,
    );
    const body = new URLSearchParams(String(seenInit?.body));
    expect(body.get("To")).toBe("+33142000000");
    expect(body.get("From")).toBe("+15550100");
    expect(body.get("Url")).toBe("https://example.test/voice");
    expect(body.get("StatusCallback")).toBe("https://example.test/status");
    expect(body.get("TimeLimit")).toBe("600");
    expect(body.get("Record")).toBe("true");
    expect(body.get("MachineDetection")).toBe("Enable");
  });

  it("a provider rejection surfaces as a TelephonyError with the status", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ message: "bad number" }), { status: 400 }),
    ) as unknown as typeof fetch;
    await expect(
      providerWithFetch(fetchImpl).createCall({
        to: "+1000",
        from: "+15550100",
        callUrl: "https://example.test/voice",
        timeLimitSeconds: 60,
      }),
    ).rejects.toBeInstanceOf(TelephonyError);
  });

  it("a 2xx without a call sid is an error, never a phantom call", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ status: "queued" }), { status: 201 }),
    ) as unknown as typeof fetch;
    await expect(
      providerWithFetch(fetchImpl).createCall({
        to: "+33142000000",
        from: "+15550100",
        callUrl: "https://example.test/voice",
        timeLimitSeconds: 60,
      }),
    ).rejects.toThrow(/no call id/);
  });
});
