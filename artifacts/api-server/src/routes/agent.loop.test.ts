/**
 * Marco agent — unit tests for the loop's pure helpers.
 *
 * These cover canonicalToolSignature (the duplicate detector's notion of
 * "same call") and isUsableFinalText (what counts as a completed answer).
 * No Express server, no fetch stubbing: importing ./agent.js only needs the
 * @workspace/db mock because module load pulls in agentTools.
 */

import { describe, it, expect, vi } from "vitest";
import {
  canonicalToolSignature,
  isUsableFinalText,
  applyChatDelta,
  createChatDeltaAccumulator,
  readSseDataLines,
} from "./agent.js";

const dbMock = vi.hoisted(() => {
  const resultQueue: unknown[] = [];
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {
      then: (res: (v: unknown) => unknown) => Promise.resolve(resultQueue.shift() ?? []).then(res),
    };
    for (const m of ["from", "where", "innerJoin", "leftJoin", "orderBy"]) {
      chain[m] = () => chain;
    }
    return chain;
  }
  const fakeTable = new Proxy({}, { get: (_t, p) => p });
  return { resultQueue, makeChain, fakeTable };
});

vi.mock("@workspace/db", () => ({
  db: { select: vi.fn(() => dbMock.makeChain()) },
  tripsTable: dbMock.fakeTable,
  tripParticipantsTable: dbMock.fakeTable,
  itineraryDaysTable: dbMock.fakeTable,
  reservationsTable: dbMock.fakeTable,
  flightsTable: dbMock.fakeTable,
  accommodationsTable: dbMock.fakeTable,
  activitiesTable: dbMock.fakeTable,
  carRentalsTable: dbMock.fakeTable,
}));

describe("canonicalToolSignature", () => {
  it("treats reordered object keys as the same call", () => {
    expect(canonicalToolSignature("get_reservations", '{"tripId":7,"type":"restaurant"}')).toBe(
      canonicalToolSignature("get_reservations", '{"type":"restaurant","tripId":7}'),
    );
  });

  it("treats whitespace-varied JSON as the same call", () => {
    expect(canonicalToolSignature("get_reservations", '{"tripId":7}')).toBe(
      canonicalToolSignature("get_reservations", '{ "tripId" : 7 }'),
    );
  });

  it("sorts nested object keys recursively", () => {
    const a = canonicalToolSignature("t", '{"b":{"y":1,"x":2},"a":0}');
    const b = canonicalToolSignature("t", '{"a":0,"b":{"x":2,"y":1}}');
    expect(a).toBe(b);
  });

  it("keeps array order significant", () => {
    expect(canonicalToolSignature("t", '{"ids":[1,2]}')).not.toBe(
      canonicalToolSignature("t", '{"ids":[2,1]}'),
    );
  });

  it("normalizes numeric forms", () => {
    expect(canonicalToolSignature("t", '{"tripId":7}')).toBe(
      canonicalToolSignature("t", '{"tripId":7.0}'),
    );
  });

  it("distinguishes different tools and different args", () => {
    expect(canonicalToolSignature("get_flights", '{"tripId":7}')).not.toBe(
      canonicalToolSignature("get_stays", '{"tripId":7}'),
    );
    expect(canonicalToolSignature("get_flights", '{"tripId":7}')).not.toBe(
      canonicalToolSignature("get_flights", '{"tripId":8}'),
    );
  });

  it("handles missing args as an empty object", () => {
    expect(canonicalToolSignature("get_flights", undefined)).toBe(
      canonicalToolSignature("get_flights", null),
    );
    expect(canonicalToolSignature("get_flights", "")).toBe('get_flights({})');
  });

  it("falls back to the raw string for malformed JSON", () => {
    const sig = canonicalToolSignature("t", "{not json");
    expect(sig).toContain("raw:{not json");
    // …and does not collide with a parsed signature.
    expect(sig).not.toBe(canonicalToolSignature("t", '{"a":1}'));
  });
});

describe("isUsableFinalText", () => {
  it("rejects null, undefined, empty, and blank content", () => {
    expect(isUsableFinalText(null)).toBe(false);
    expect(isUsableFinalText(undefined)).toBe(false);
    expect(isUsableFinalText("")).toBe(false);
    expect(isUsableFinalText("   \n  ")).toBe(false);
  });

  it("rejects bare deferral fragments", () => {
    for (const fragment of [
      "Let me check.",
      "Let me check",
      "I'll check.",
      "I'll check",
      "I will check.",
      "Checking now",
      "Checking now…",
      "One moment.",
      "Hold on.",
      "Give me a sec.",
      "Just a second",
      "Looking it up.",
    ]) {
      expect(isUsableFinalText(fragment)).toBe(false);
    }
  });

  it("accepts real sentences that merely start with a deferral phrase", () => {
    expect(isUsableFinalText("I'll check the reservations for Saturday.")).toBe(true);
    expect(isUsableFinalText("Let me check the schedule and get back to you.")).toBe(true);
  });

  it("accepts short genuine answers", () => {
    expect(isUsableFinalText("Yes.")).toBe(true);
    expect(isUsableFinalText("8:30 PM.")).toBe(true);
    expect(isUsableFinalText("Dinner is at 7:30 PM at Schneider Bräuhaus.")).toBe(true);
  });
});

describe("applyChatDelta", () => {
  it("accumulates content deltas", () => {
    const acc = createChatDeltaAccumulator();
    applyChatDelta(acc, { content: "Hello, " });
    applyChatDelta(acc, { content: "world." });
    expect(acc.content).toBe("Hello, world.");
    expect(acc.sawToolCalls).toBe(false);
    expect(acc.toolCalls).toHaveLength(0);
  });

  it("merges tool-call fragments by index", () => {
    const acc = createChatDeltaAccumulator();
    applyChatDelta(acc, {
      tool_calls: [{ index: 0, id: "call_1", function: { name: "get_reser", arguments: '{"trip' } }],
    });
    applyChatDelta(acc, {
      tool_calls: [{ index: 0, function: { name: "vations", arguments: 'Id":7}' } }],
    });
    expect(acc.sawToolCalls).toBe(true);
    expect(acc.toolCalls).toHaveLength(1);
    expect(acc.toolCalls[0]).toEqual({
      id: "call_1",
      name: "get_reservations",
      arguments: '{"tripId":7}',
    });
  });

  it("handles multiple tool calls in one batch", () => {
    const acc = createChatDeltaAccumulator();
    applyChatDelta(acc, {
      tool_calls: [
        { index: 0, id: "call_1", function: { name: "get_flights", arguments: "{}" } },
        { index: 1, id: "call_2", function: { name: "get_stays", arguments: "{}" } },
      ],
    });
    expect(acc.toolCalls.map((t) => t.name)).toEqual(["get_flights", "get_stays"]);
  });

  it("ignores null/undefined deltas", () => {
    const acc = createChatDeltaAccumulator();
    applyChatDelta(acc, null);
    applyChatDelta(acc, undefined);
    expect(acc.content).toBe("");
    expect(acc.sawToolCalls).toBe(false);
  });
});

describe("readSseDataLines", () => {
  function fakeStream(chunks: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let i = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) controller.enqueue(encoder.encode(chunks[i++]));
        else controller.close();
      },
    });
  }

  async function collect(chunks: string[]): Promise<string[]> {
    const out: string[] = [];
    for await (const line of readSseDataLines(fakeStream(chunks))) out.push(line);
    return out;
  }

  it("yields data payloads and skips comments and [DONE]", async () => {
    const lines = await collect([
      ': ping\n\n',
      'data: {"a":1}\n\n',
      'data: [DONE]\n\n',
      'data: {"b":2}\n\n',
    ]);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("reassembles frames split across TCP chunks", async () => {
    const lines = await collect([
      'data: {"choices":[{"delta":{"cont',
      'ent":"Hel',
      'lo"}}]}\n\n',
    ]);
    expect(lines).toEqual(['{"choices":[{"delta":{"content":"Hello"}}]}']);
  });

  it("handles a chunk boundary inside the frame separator", async () => {
    const lines = await collect(['data: {"a":1}\n', '\ndata: {"b":2}\n\n']);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("yields multiple data lines within one frame", async () => {
    const lines = await collect(['data: {"a":1}\ndata: {"b":2}\n\n']);
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });
});
