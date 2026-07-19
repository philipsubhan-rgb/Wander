import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, tripExpensesTable, expenseSplitsTable, tripParticipantsTable, usersTable } from "@workspace/db";
import {
  CreateExpenseParams,
  CreateExpenseBody,
  UpdateExpenseParams,
  UpdateExpenseBody,
  DeleteExpenseParams,
  GetExpenseBalanceParams,
  ReimburseExpenseSplitParams,
} from "@workspace/api-zod";
import { requireTripParticipant } from "../middlewares/auth";

const router: IRouter = Router();

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fetch all expenses for a trip, joined with payer name and splits+user names. */
async function fetchExpensesWithSplits(tripId: number) {
  const expenses = await db
    .select({ expense: tripExpensesTable, payerName: usersTable.name })
    .from(tripExpensesTable)
    .innerJoin(usersTable, eq(usersTable.id, tripExpensesTable.paidByUserId))
    .where(eq(tripExpensesTable.tripId, tripId))
    .orderBy(tripExpensesTable.date, tripExpensesTable.createdAt);

  const expenseIds = expenses.map(e => e.expense.id);
  let splitsWithNames: Array<{ split: typeof expenseSplitsTable.$inferSelect; userName: string }> = [];

  if (expenseIds.length > 0) {
    splitsWithNames = await db
      .select({ split: expenseSplitsTable, userName: usersTable.name })
      .from(expenseSplitsTable)
      .innerJoin(usersTable, eq(usersTable.id, expenseSplitsTable.userId))
      .where(sql`${expenseSplitsTable.expenseId} = ANY(ARRAY[${sql.join(expenseIds.map(id => sql`${id}`), sql`, `)}]::int[])`);
  }

  const splitsByExpense = new Map<number, typeof splitsWithNames>();
  for (const s of splitsWithNames) {
    const arr = splitsByExpense.get(s.split.expenseId) ?? [];
    arr.push(s);
    splitsByExpense.set(s.split.expenseId, arr);
  }

  return expenses.map(({ expense, payerName }) => ({
    ...expense,
    payerName,
    createdAt: expense.createdAt.toISOString(),
    splits: (splitsByExpense.get(expense.id) ?? []).map(({ split, userName }) => ({
      ...split,
      userName,
      paidAt: split.paidAt?.toISOString() ?? null,
    })),
  }));
}

/**
 * Delete all existing splits for an expense and create fresh ones.
 * The payer's own split is always isPaid=true.
 * Rounding cents are added to the payer's share.
 */
async function recreateSplits(
  expenseId: number,
  paidByUserId: number,
  totalAmount: number,
  tripId: number,
) {
  // Remove old splits
  await db.delete(expenseSplitsTable).where(eq(expenseSplitsTable.expenseId, expenseId));

  const participants = await db
    .select({ userId: tripParticipantsTable.userId })
    .from(tripParticipantsTable)
    .where(eq(tripParticipantsTable.tripId, tripId));

  if (participants.length === 0) return;

  const n        = participants.length;
  const share    = Math.round((totalAmount / n) * 100) / 100;
  const remainder = Math.round((totalAmount - share * n) * 100) / 100;

  const values = participants.map(p => {
    const isPayer   = p.userId === paidByUserId;
    const thisShare = isPayer ? Math.round((share + remainder) * 100) / 100 : share;
    return {
      expenseId,
      userId:      p.userId,
      shareAmount: String(thisShare),
      isPaid:      isPayer,              // payer already covered their own share
      paidAt:      isPayer ? new Date() : null,
    };
  });

  await db.insert(expenseSplitsTable).values(values);
}

/**
 * Greedy debt-minimization: return the minimal set of transfers that settles
 * all outstanding net balances.
 *
 * Inputs: map of userId -> { name, net }
 *   net > 0 means others still owe this person
 *   net < 0 means this person still owes others
 *
 * The sum of all nets must be 0 for the algorithm to be exact.
 */
function minimizeDebts(
  balances: Record<number, { name: string; net: number }>,
): Array<{ fromUserId: number; fromName: string; toUserId: number; toName: string; amount: number }> {
  const creditors: Array<{ id: number; name: string; amount: number }> = [];
  const debtors:   Array<{ id: number; name: string; amount: number }> = [];

  for (const [idStr, { name, net }] of Object.entries(balances)) {
    const id    = Number(idStr);
    const cents = Math.round(net * 100);
    if (cents > 0) creditors.push({ id, name, amount: cents });
    if (cents < 0) debtors.push({ id, name, amount: -cents });
  }

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort((a, b)   => b.amount - a.amount);

  const settlements: ReturnType<typeof minimizeDebts> = [];
  let ci = 0, di = 0;

  while (ci < creditors.length && di < debtors.length) {
    const c      = creditors[ci];
    const d      = debtors[di];
    const settle = Math.min(c.amount, d.amount);
    settlements.push({
      fromUserId: d.id, fromName: d.name,
      toUserId:   c.id, toName:   c.name,
      amount: Math.round(settle) / 100,
    });
    c.amount -= settle;
    d.amount -= settle;
    if (c.amount === 0) ci++;
    if (d.amount === 0) di++;
  }

  return settlements;
}

// ── GET /trips/:tripId/expenses ───────────────────────────────────────────────
// Protected: must be a trip participant

router.get("/trips/:tripId/expenses", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = CreateExpenseParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  res.json(await fetchExpensesWithSplits(params.data.tripId));
});

// ── POST /trips/:tripId/expenses ──────────────────────────────────────────────

router.post("/trips/:tripId/expenses", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = CreateExpenseParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const { tripId } = params.data;

  const parsed = CreateExpenseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // Validate that paidByUserId is actually a participant of this trip
  const participants = await db
    .select({ userId: tripParticipantsTable.userId })
    .from(tripParticipantsTable)
    .where(eq(tripParticipantsTable.tripId, tripId));

  if (participants.length === 0) {
    res.status(400).json({ error: "Trip has no participants" });
    return;
  }
  const participantIds = new Set(participants.map(p => p.userId));
  if (!participantIds.has(parsed.data.paidByUserId)) {
    res.status(400).json({ error: "paidByUserId must be a participant of this trip" });
    return;
  }

  const [expense] = await db
    .insert(tripExpensesTable)
    .values({
      tripId,
      paidByUserId: parsed.data.paidByUserId,
      amount:       parsed.data.amount,
      currency:     parsed.data.currency ?? "USD",
      description:  parsed.data.description,
      category:     parsed.data.category ?? "other",
      date:         parsed.data.date,
      notes:        parsed.data.notes ?? null,
    })
    .returning();

  await recreateSplits(expense.id, expense.paidByUserId, parseFloat(expense.amount), tripId);

  const [result] = (await fetchExpensesWithSplits(tripId)).filter(e => e.id === expense.id);
  res.status(201).json(result);
});

// ── PATCH /trips/:tripId/expenses/:expenseId ──────────────────────────────────

router.patch("/trips/:tripId/expenses/:expenseId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = UpdateExpenseParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const { tripId, expenseId } = params.data;

  const parsed = UpdateExpenseBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  // If changing the payer, validate the new payer is a trip participant
  if (parsed.data.paidByUserId !== undefined) {
    const tripParticipants = await db
      .select({ userId: tripParticipantsTable.userId })
      .from(tripParticipantsTable)
      .where(eq(tripParticipantsTable.tripId, tripId));
    const participantIds = new Set(tripParticipants.map(p => p.userId));
    if (!participantIds.has(parsed.data.paidByUserId)) {
      res.status(400).json({ error: "paidByUserId must be a participant of this trip" });
      return;
    }
  }

  const updateData: Partial<typeof tripExpensesTable.$inferInsert> = {};
  if (parsed.data.description  !== undefined) updateData.description  = parsed.data.description;
  if (parsed.data.category     !== undefined) updateData.category     = parsed.data.category;
  if (parsed.data.date         !== undefined) updateData.date         = parsed.data.date;
  if (parsed.data.notes        !== undefined) updateData.notes        = parsed.data.notes;
  if (parsed.data.currency     !== undefined) updateData.currency     = parsed.data.currency;
  if (parsed.data.paidByUserId !== undefined) updateData.paidByUserId = parsed.data.paidByUserId;
  if (parsed.data.amount       !== undefined) updateData.amount       = parsed.data.amount;

  const [expense] = await db
    .update(tripExpensesTable)
    .set(updateData)
    .where(and(eq(tripExpensesTable.id, expenseId), eq(tripExpensesTable.tripId, tripId)))
    .returning();

  if (!expense) { res.status(404).json({ error: "Expense not found" }); return; }

  // Rebuild splits whenever the amount OR payer changes — either invalidates existing splits
  const payerChanged  = parsed.data.paidByUserId !== undefined;
  const amountChanged = parsed.data.amount       !== undefined;
  if (payerChanged || amountChanged) {
    await recreateSplits(expense.id, expense.paidByUserId, parseFloat(expense.amount), tripId);
  }

  const [result] = (await fetchExpensesWithSplits(tripId)).filter(e => e.id === expense.id);
  res.json(result);
});

// ── DELETE /trips/:tripId/expenses/:expenseId ─────────────────────────────────

router.delete("/trips/:tripId/expenses/:expenseId", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = DeleteExpenseParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
  const { tripId, expenseId } = params.data;

  const [expense] = await db
    .delete(tripExpensesTable)
    .where(and(eq(tripExpensesTable.id, expenseId), eq(tripExpensesTable.tripId, tripId)))
    .returning();

  if (!expense) { res.status(404).json({ error: "Expense not found" }); return; }
  res.json({ success: true });
});

// ── GET /trips/:tripId/expenses/balance ───────────────────────────────────────
// NOTE: must be declared BEFORE /:expenseId routes to avoid Express matching
// "balance" as an expenseId parameter.
// Protected: must be a trip participant.

router.get("/trips/:tripId/expenses/balance", requireTripParticipant(), async (req, res): Promise<void> => {
  const params = GetExpenseBalanceParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Invalid tripId" }); return; }
  const { tripId } = params.data;

  const participants = await db
    .select({ userId: tripParticipantsTable.userId, name: usersTable.name })
    .from(tripParticipantsTable)
    .innerJoin(usersTable, eq(usersTable.id, tripParticipantsTable.userId))
    .where(eq(tripParticipantsTable.tripId, tripId));

  if (participants.length === 0) {
    res.json({ balances: [], settlements: [], totalSpent: 0, currency: "USD" });
    return;
  }

  // Initialise balance entries keyed by userId
  const balances: Record<
    number,
    { userId: number; name: string; totalPaid: number; totalOwed: number; net: number }
  > = {};
  for (const p of participants) {
    balances[p.userId] = { userId: p.userId, name: p.name, totalPaid: 0, totalOwed: 0, net: 0 };
  }

  // All expenses for the trip (we need paidByUserId)
  const expenses = await db
    .select()
    .from(tripExpensesTable)
    .where(eq(tripExpensesTable.tripId, tripId));

  // Total amount paid out by each person (face value, regardless of reimbursement state)
  for (const e of expenses) {
    if (balances[e.paidByUserId]) {
      balances[e.paidByUserId].totalPaid += parseFloat(e.amount);
    }
  }

  // Fetch all splits for these expenses
  const expenseIds = expenses.map(e => e.id);
  let allSplits: Array<typeof expenseSplitsTable.$inferSelect> = [];
  if (expenseIds.length > 0) {
    allSplits = await db
      .select()
      .from(expenseSplitsTable)
      .where(sql`${expenseSplitsTable.expenseId} = ANY(ARRAY[${sql.join(expenseIds.map(id => sql`${id}`), sql`, `)}]::int[])`);
  }

  // Build a lookup: expenseId → paidByUserId
  const expensePayer = new Map<number, number>(expenses.map(e => [e.id, e.paidByUserId]));

  /*
   * Balance model (cash-flow, survives reimbursement):
   *
   * For each split:
   *   • If the split belongs to user U (split.userId === U) AND isPaid = false:
   *       → U still owes the payer → add to U.totalOwed
   *   • If the split belongs to user V (V ≠ payer) AND the payer is U AND isPaid = false:
   *       → V still owes U → adds to U's "owed-to-me" amount (tracked via net)
   *
   * net = (total others still owe me) − (total I still owe others)
   *
   * The payer's own split is always isPaid=true so it never affects either side.
   * This formulation guarantees sum(nets) = 0 at all times.
   */
  const owedToUser = new Map<number, number>(); // userId → Σ unpaid splits owed TO this user
  for (const p of participants) owedToUser.set(p.userId, 0);

  for (const split of allSplits) {
    const payerOfExpense = expensePayer.get(split.expenseId);
    if (payerOfExpense === undefined) continue;

    if (!split.isPaid) {
      // This split is still outstanding
      if (split.userId !== payerOfExpense) {
        // Non-payer split: split.userId owes the expense payer
        if (balances[split.userId]) {
          balances[split.userId].totalOwed += parseFloat(split.shareAmount);
        }
        // The expense payer is owed this amount
        if (balances[payerOfExpense]) {
          owedToUser.set(payerOfExpense, (owedToUser.get(payerOfExpense) ?? 0) + parseFloat(split.shareAmount));
        }
      }
      // Payer's own split (split.userId === payerOfExpense) is always isPaid=true, so skipped
    }
  }

  let totalSpent = 0;
  for (const b of Object.values(balances)) {
    const owedToMe = owedToUser.get(b.userId) ?? 0;
    b.net       = Math.round((owedToMe - b.totalOwed) * 100) / 100;
    b.totalPaid = Math.round(b.totalPaid * 100) / 100;
    b.totalOwed = Math.round(b.totalOwed * 100) / 100;
    totalSpent += b.totalPaid;
  }

  res.json({
    balances:    Object.values(balances),
    settlements: minimizeDebts(
      Object.fromEntries(Object.values(balances).map(b => [b.userId, { name: b.name, net: b.net }]))
    ),
    totalSpent:  Math.round(totalSpent * 100) / 100,
    currency:    expenses[0]?.currency ?? "USD",
  });
});

// ── POST .../splits/:userId/reimburse ─────────────────────────────────────────

router.post(
  "/trips/:tripId/expenses/:expenseId/splits/:userId/reimburse",
  requireTripParticipant(),
  async (req, res): Promise<void> => {
    const params = ReimburseExpenseSplitParams.safeParse(req.params);
    if (!params.success) { res.status(400).json({ error: "Invalid params" }); return; }
    const { tripId, expenseId, userId } = params.data;

    // Confirm the expense belongs to this trip
    const [expense] = await db
      .select()
      .from(tripExpensesTable)
      .where(and(eq(tripExpensesTable.id, expenseId), eq(tripExpensesTable.tripId, tripId)));
    if (!expense) { res.status(404).json({ error: "Expense not found" }); return; }

    // Authorization: the debtor themselves OR a trip/global admin may mark as reimbursed
    const requestingUserId = req.session!.userId!;
    const isGlobalAdmin    = req.session!.role === "admin";

    if (!isGlobalAdmin && requestingUserId !== userId) {
      const [tripAdmin] = await db
        .select()
        .from(tripParticipantsTable)
        .where(and(
          eq(tripParticipantsTable.tripId, tripId),
          eq(tripParticipantsTable.userId, requestingUserId),
          eq(tripParticipantsTable.isTripAdmin, true),
        ));
      if (!tripAdmin) {
        res.status(403).json({ error: "Only the debtor or a trip admin can mark this as reimbursed" });
        return;
      }
    }

    const [split] = await db
      .update(expenseSplitsTable)
      .set({ isPaid: true, paidAt: new Date() })
      .where(and(eq(expenseSplitsTable.expenseId, expenseId), eq(expenseSplitsTable.userId, userId)))
      .returning();

    if (!split) { res.status(404).json({ error: "Split not found" }); return; }
    res.json({ ...split, paidAt: split.paidAt?.toISOString() ?? null });
  },
);

export default router;
