import { describe, it, expect } from "vitest";
import { computeUnpaidShares } from "./expenses.js";

// Helper: sum all shares (paid + new unpaid) and assert they equal the total
function assertSplitInvariant(
  totalAmount: number,
  paidSplits: Array<{ userId: number; shareAmount: string }>,
  newShares: Array<{ userId: number; shareAmount: number }>,
) {
  const paidTotal = paidSplits.reduce((s, p) => s + parseFloat(p.shareAmount), 0);
  const unpaidTotal = newShares.reduce((s, p) => s + p.shareAmount, 0);
  expect(Math.round((paidTotal + unpaidTotal) * 100) / 100).toBeCloseTo(totalAmount, 2);
}

describe("computeUnpaidShares", () => {
  // ── (a) Only the payer has a paid split ────────────────────────────────────
  describe("only payer paid", () => {
    it("3-way split: $30, payer paid $10, two others unpaid", () => {
      const total = 30;
      const paidSplits = [{ userId: 1, shareAmount: "10" }];
      const participants = [1, 2, 3];
      const result = computeUnpaidShares(total, paidSplits, participants);
      expect(result).toHaveLength(2);
      expect(result.find(r => r.userId === 2)?.shareAmount).toBe(10);
      expect(result.find(r => r.userId === 3)?.shareAmount).toBe(10);
      assertSplitInvariant(total, paidSplits, result);
    });

    it("new participant added → payer paid $10, three others split remaining $20 (invariant holds)", () => {
      // $30 total; payer already paid $10. Remaining = $20, 3 unpaid participants.
      // Floor division: 2000¢ / 3 = 666¢ each + 2¢ remainder → first gets $6.68, rest get $6.66
      const total = 30;
      const paidSplits = [{ userId: 1, shareAmount: "10" }];
      const participants = [1, 2, 3, 4];
      const result = computeUnpaidShares(total, paidSplits, participants);
      expect(result).toHaveLength(3);
      // All splits must sum to the total
      assertSplitInvariant(total, paidSplits, result);
      // Each share is within ±$0.01 of the ideal ($6.67)
      for (const { shareAmount } of result) {
        expect(shareAmount).toBeGreaterThanOrEqual(6.66);
        expect(shareAmount).toBeLessThanOrEqual(6.68);
      }
    });

    it("participant removed → payer paid $10, one other owes $20", () => {
      // Was 3-way ($10 each); one removed → 2 remain, payer paid $10, remaining = $20
      const total = 30;
      const paidSplits = [{ userId: 1, shareAmount: "10" }];
      const participants = [1, 2]; // participant 3 removed
      const result = computeUnpaidShares(total, paidSplits, participants);
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe(2);
      expect(result[0].shareAmount).toBe(20);
      assertSplitInvariant(total, paidSplits, result);
    });
  });

  // ── (b) Some non-payers have reimbursed ───────────────────────────────────
  describe("some non-payers reimbursed", () => {
    it("2 of 4 paid; new participant added — only unpaid remainder is split among unpaid", () => {
      const total = 40;
      // payer paid $10, user 2 reimbursed $10 → remaining $20 across 3 (new + old unpaid)
      const paidSplits = [
        { userId: 1, shareAmount: "10" },
        { userId: 2, shareAmount: "10" },
      ];
      const participants = [1, 2, 3, 4, 5]; // user 5 is new
      const result = computeUnpaidShares(total, paidSplits, participants);
      // unpaid: 3, 4, 5 — remaining = $20 → floor: 666¢ each + 2¢ remainder to first
      expect(result).toHaveLength(3);
      assertSplitInvariant(total, paidSplits, result);
      for (const { shareAmount } of result) {
        expect(shareAmount).toBeGreaterThanOrEqual(6.66);
        expect(shareAmount).toBeLessThanOrEqual(6.68);
      }
    });

    it("all remaining participants already paid → returns empty array", () => {
      const total = 30;
      const paidSplits = [
        { userId: 1, shareAmount: "10" },
        { userId: 2, shareAmount: "10" },
        { userId: 3, shareAmount: "10" },
      ];
      const participants = [1, 2, 3];
      const result = computeUnpaidShares(total, paidSplits, participants);
      expect(result).toHaveLength(0);
      assertSplitInvariant(total, paidSplits, result);
    });
  });

  // ── (c) Participant removed/added after reimbursements ────────────────────
  describe("roster changes after partial reimbursements", () => {
    it("removed participant had unpaid split; payer + 1 reimbursed; 1 now owes full remainder", () => {
      const total = 60;
      // Originally 4 people ($15 each); user 3 reimbursed; user 4 removed (their unpaid split deleted).
      // Now participants = [1, 2, 3]; paid = [1=$15, 3=$15]; user 2 owes remainder = $30
      const paidSplits = [
        { userId: 1, shareAmount: "15" },
        { userId: 3, shareAmount: "15" },
      ];
      const participants = [1, 2, 3];
      const result = computeUnpaidShares(total, paidSplits, participants);
      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe(2);
      expect(result[0].shareAmount).toBe(30);
      assertSplitInvariant(total, paidSplits, result);
    });

    it("new participant joins after some reimbursements; total splits still sum to expense amount", () => {
      const total = 100;
      // 3 original participants; payer ($33.34) + user 2 ($33.33) paid; user 3 unpaid.
      // New participant (user 4) joins → user 3 & 4 split remaining $33.33
      const paidSplits = [
        { userId: 1, shareAmount: "33.34" },
        { userId: 2, shareAmount: "33.33" },
      ];
      const participants = [1, 2, 3, 4];
      const result = computeUnpaidShares(total, paidSplits, participants);
      expect(result).toHaveLength(2);
      assertSplitInvariant(total, paidSplits, result);
    });

    it("no current participants → returns empty array", () => {
      const result = computeUnpaidShares(50, [{ userId: 1, shareAmount: "50" }], []);
      expect(result).toHaveLength(0);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("single participant with unpaid split", () => {
      const total = 25;
      const paidSplits: Array<{ userId: number; shareAmount: string }> = [];
      const participants = [1];
      const result = computeUnpaidShares(total, paidSplits, participants);
      expect(result).toHaveLength(1);
      expect(result[0].shareAmount).toBe(25);
      assertSplitInvariant(total, paidSplits, result);
    });

    it("cent rounding: $10 / 3 people → amounts sum to exactly $10", () => {
      const total = 10;
      const paidSplits: Array<{ userId: number; shareAmount: string }> = [];
      const participants = [1, 2, 3];
      const result = computeUnpaidShares(total, paidSplits, participants);
      expect(result).toHaveLength(3);
      assertSplitInvariant(total, paidSplits, result);
    });
  });
});
