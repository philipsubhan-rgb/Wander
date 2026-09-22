/**
 * Marco conversation memory — unit tests for the pure merge helpers.
 *
 * findHistoryOverlap / mergeHistories decide what the model sees and what
 * gets persisted. No Express server, no DB: importing ../lib/marcoMemory
 * only needs the @workspace/db mock at module load.
 */

import { describe, it, expect, vi } from "vitest";
import {
  findHistoryOverlap,
  mergeHistories,
  type MemoryMessage,
} from "./marcoMemory.js";

vi.mock("@workspace/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), delete: vi.fn() },
  marcoMessagesTable: new Proxy({}, { get: (_t, p) => p }),
}));

const u = (content: string): MemoryMessage => ({ role: "user", content });
const a = (content: string): MemoryMessage => ({ role: "assistant", content });

describe("findHistoryOverlap", () => {
  it("returns 0 when nothing is persisted yet", () => {
    expect(findHistoryOverlap([], [u("hello")])).toBe(0);
  });

  it("returns 0 when the client sent nothing", () => {
    expect(findHistoryOverlap([u("hi"), a("hey")], [])).toBe(0);
  });

  it("detects a full overlap (client history == persisted tail)", () => {
    const p = [u("hi"), a("hey")];
    expect(findHistoryOverlap(p, [...p])).toBe(2);
  });

  it("detects a continuing session: overlap is everything but the new message", () => {
    const p = [u("hi"), a("hey")];
    expect(findHistoryOverlap(p, [u("hi"), a("hey"), u("and Sunday?")])).toBe(2);
  });

  it("returns 0 for a fresh session after a reload", () => {
    const p = [u("hi"), a("hey")];
    expect(findHistoryOverlap(p, [u("what about dinner?")])).toBe(0);
  });

  it("ignores leading/trailing whitespace when matching turns", () => {
    const p = [u("hi"), a("hey")];
    expect(findHistoryOverlap(p, [u("  hi "), a("hey\n"), u("next")])).toBe(2);
  });

  it("returns 0 when the overlapping turns differ in content", () => {
    const p = [u("hi"), a("hey")];
    expect(findHistoryOverlap(p, [u("hi"), a("different answer")])).toBe(0);
  });

  it("matches only the longest consistent run from the seam", () => {
    // Last persisted turn equals the first client turn, but nothing more.
    const p = [u("old question"), a("shared answer")];
    expect(findHistoryOverlap(p, [a("shared answer"), u("new question")])).toBe(1);
  });
});

describe("mergeHistories", () => {
  it("continuing session: history = persisted + new, fresh = new message only", () => {
    const p = [u("hi"), a("hey")];
    const c = [u("hi"), a("hey"), u("and Sunday?")];
    const { history, fresh } = mergeHistories(p, c, 30);
    expect(history).toEqual([u("hi"), a("hey"), u("and Sunday?")]);
    expect(fresh).toEqual([u("and Sunday?")]);
  });

  it("fresh session: persisted log supplies the past, client message is fresh", () => {
    const p = [u("hi"), a("hey")];
    const { history, fresh } = mergeHistories(p, [u("what about dinner?")], 30);
    expect(history).toEqual([u("hi"), a("hey"), u("what about dinner?")]);
    expect(fresh).toEqual([u("what about dinner?")]);
  });

  it("never re-persists turns the server already stored", () => {
    const p = [u("hi"), a("hey")];
    const { fresh } = mergeHistories(p, [u("hi"), a("hey")], 30);
    expect(fresh).toEqual([]);
  });

  it("tail-caps the model history at the limit", () => {
    const p = [u("one"), a("two"), u("three"), a("four")];
    const { history, fresh } = mergeHistories(p, [u("five")], 3);
    expect(history).toEqual([u("three"), a("four"), u("five")]);
    expect(fresh).toEqual([u("five")]);
  });

  it("keeps system messages in history but they are the caller's to filter on persist", () => {
    const p: MemoryMessage[] = [{ role: "system", content: "sys" }, u("hi")];
    const { history } = mergeHistories(p, [u("hi"), u("again")], 30);
    expect(history.map((m) => m.role)).toEqual(["system", "user", "user"]);
  });
});
