import React, { useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, Alert, LayoutAnimation, Platform, UIManager,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import {
  useGetExpenseBalance,
  useListExpenses,
  useReimburseExpenseSplit,
  getGetExpenseBalanceQueryKey,
  getListExpensesQueryKey,
} from '@workspace/api-client-react';
import type { ExpenseBalanceEntry, ExpenseSettlement, TripExpense } from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { useColors } from '@/hooks/useColors';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

// ── Balance card (per-person net) ─────────────────────────────────────────────

function BalanceCard({ entry, colors }: { entry: ExpenseBalanceEntry; colors: ReturnType<typeof useColors> }) {
  const net = entry.net;
  const isPositive = net > 0;
  const isNeutral = Math.abs(net) < 0.005;
  const color = isNeutral ? colors.mutedForeground : isPositive ? '#10B981' : colors.destructive;
  const initials = entry.name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <View style={[bc.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[bc.avatar, { backgroundColor: colors.primary + '20' }]}>
        <Text style={[bc.avatarText, { color: colors.primary }]}>{initials}</Text>
      </View>
      <View style={bc.info}>
        <Text style={[bc.name, { color: colors.foreground }]}>{entry.name}</Text>
        <Text style={[bc.sub, { color: colors.mutedForeground }]}>
          Paid {entry.totalPaid.toFixed(2)} · Owes {entry.totalOwed.toFixed(2)}
        </Text>
      </View>
      <View style={[bc.netBadge, { backgroundColor: color + '18' }]}>
        <Text style={[bc.netText, { color }]}>
          {isNeutral ? 'Settled' : `${isPositive ? '+' : ''}${net.toFixed(2)}`}
        </Text>
      </View>
    </View>
  );
}

const bc = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 12 },
  avatar: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  info: { flex: 1, gap: 2 },
  name: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  sub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  netBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  netText: { fontSize: 13, fontFamily: 'Inter_700Bold' },
});

// ── Individual split row with "Mark as paid" ──────────────────────────────────

interface SplitDebt {
  fromUserId: number;
  fromName: string;
  toUserId: number;
  toName: string;
  expenseId: number;
  expenseDescription: string;
  amount: number;
}

interface SplitRowProps {
  debt: SplitDebt;
  tripId: number;
  colors: ReturnType<typeof useColors>;
  onSettled: () => void;
}

function SplitRow({ debt, tripId, colors, onSettled }: SplitRowProps) {
  const [settling, setSettling] = useState(false);
  const { mutateAsync: reimburse } = useReimburseExpenseSplit();

  async function handleSettle() {
    setSettling(true);
    try {
      await reimburse({ tripId, expenseId: debt.expenseId, userId: debt.fromUserId });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onSettled();
    } catch {
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert('Could not mark as paid', 'Something went wrong. Please try again.');
    } finally {
      setSettling(false);
    }
  }

  return (
    <View style={[sp.row, { backgroundColor: colors.muted + '80' }]}>
      <View style={sp.left}>
        <View style={sp.nameRow}>
          <Text style={[sp.fromName, { color: colors.foreground }]}>{debt.fromName}</Text>
          <Feather name="arrow-right" size={11} color={colors.mutedForeground} />
          <Text style={[sp.toName, { color: colors.foreground }]}>{debt.toName}</Text>
        </View>
        <Text style={[sp.desc, { color: colors.mutedForeground }]} numberOfLines={1}>
          {debt.expenseDescription}
        </Text>
      </View>
      <View style={sp.right}>
        <Text style={[sp.amount, { color: colors.primary }]}>{debt.amount.toFixed(2)}</Text>
        <TouchableOpacity
          style={[sp.btn, { backgroundColor: colors.primary }]}
          onPress={handleSettle}
          disabled={settling}
          activeOpacity={0.75}
          hitSlop={6}
        >
          {settling ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Text style={sp.btnText}>Paid</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const sp = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 10,
    padding: 10,
    gap: 8,
  },
  left: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, flexWrap: 'wrap' },
  fromName: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  toName: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  desc: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  right: { alignItems: 'flex-end', gap: 4 },
  amount: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  btn: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    minWidth: 48,
    alignItems: 'center',
  },
  btnText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', color: '#fff' },
});

// ── Settlement breakdown types & algorithm ────────────────────────────────────

interface SettlementSplitLine {
  expenseId: number;
  description: string;
  date: string;
  shareAmount: number; // dollars (may be a partial slice of the original split)
}

/**
 * Replicate the server's greedy debt-minimization algorithm while tracking
 * which raw unpaid expense splits fund each minimized transfer.
 *
 * Returns a map keyed by `"${fromUserId}-${toUserId}"` → split lines.
 *
 * Because minimization can create *indirect* transfers (Alice→Bob + Bob→Carol
 * nets into Alice→Carol with no direct payer/split relationship), we model
 * each debtor's raw splits as a FIFO queue and consume from it in greedy order.
 * The allocated share shown in the breakdown may be a fraction of the original
 * split amount when one split spans multiple settlements.
 */
function buildAllSettlementBreakdowns(
  expenses: TripExpense[],
): Map<string, SettlementSplitLine[]> {
  // ── 1. Collect raw unpaid splits per debtor (in integer cents) ──────────────
  interface RawItem {
    expenseId: number;
    description: string;
    date: string;
    remaining: number; // cents
  }

  const queues  = new Map<number, RawItem[]>(); // debtorId → FIFO of splits
  const netCents = new Map<number, number>();    // userId   → net in cents

  const addNet = (id: number, delta: number) =>
    netCents.set(id, (netCents.get(id) ?? 0) + delta);

  for (const expense of expenses) {
    for (const split of expense.splits) {
      if (split.isPaid) continue;
      if (split.userId === expense.paidByUserId) continue;

      const from       = split.userId;
      const to         = expense.paidByUserId;
      const amtCents   = Math.round(parseFloat(split.shareAmount) * 100);

      let queue = queues.get(from);
      if (!queue) { queue = []; queues.set(from, queue); }
      queue.push({ expenseId: expense.id, description: expense.description, date: expense.date, remaining: amtCents });

      addNet(from, -amtCents);
      addNet(to,   +amtCents);
    }
  }

  // ── 2. Build creditors / debtors lists (mirrors server logic) ───────────────
  const creditors: Array<{ id: number; amount: number }> = [];
  const debtors:   Array<{ id: number; amount: number }> = [];

  for (const [id, net] of netCents) {
    if (net >  0) creditors.push({ id, amount:  net });
    if (net <  0) debtors.push(  { id, amount: -net });
  }

  creditors.sort((a, b) => b.amount - a.amount);
  debtors.sort(  (a, b) => b.amount - a.amount);

  // ── 3. Greedy matching — consume raw queue to attribute splits ───────────────
  const result = new Map<string, SettlementSplitLine[]>();

  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const c      = creditors[ci];
    const d      = debtors[di];
    const settle = Math.min(c.amount, d.amount);

    const lines: SettlementSplitLine[] = [];
    const queue = queues.get(d.id) ?? [];
    let   remaining = settle;

    for (const item of queue) {
      if (remaining <= 0) break;
      if (item.remaining <= 0) continue;

      const take  = Math.min(item.remaining, remaining);
      item.remaining -= take;
      remaining      -= take;

      lines.push({
        expenseId:   item.expenseId,
        description: item.description,
        date:        item.date,
        shareAmount: take / 100,
      });
    }

    result.set(`${d.id}-${c.id}`, lines);

    c.amount -= settle;
    d.amount -= settle;
    if (c.amount === 0) ci++;
    if (d.amount === 0) di++;
  }

  return result;
}

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

// ── Expandable settlement row ─────────────────────────────────────────────────

interface SettlementRowProps {
  settlement: ExpenseSettlement;
  breakdown: SettlementSplitLine[];
  isLast: boolean;
  colors: ReturnType<typeof useColors>;
}

function SettlementRow({ settlement, breakdown, isLast, colors }: SettlementRowProps) {
  const [expanded, setExpanded] = useState(false);
  const hasBreakdown = breakdown.length > 0;

  function toggle() {
    if (!hasBreakdown) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpanded((v) => !v);
  }

  return (
    <View>
      <TouchableOpacity
        style={sr.header}
        onPress={toggle}
        activeOpacity={hasBreakdown ? 0.7 : 1}
        disabled={!hasBreakdown}
      >
        <View style={sr.headerLeft}>
          <Text style={[sr.summaryText, { color: colors.foreground }]}>
            <Text style={{ fontFamily: 'Inter_600SemiBold' }}>{settlement.fromName}</Text>
            {'  →  '}
            <Text style={{ fontFamily: 'Inter_600SemiBold' }}>{settlement.toName}</Text>
          </Text>
          {hasBreakdown ? (
            <Text style={[sr.expenseCount, { color: colors.mutedForeground }]}>
              {breakdown.length} expense{breakdown.length !== 1 ? 's' : ''}
            </Text>
          ) : null}
        </View>
        <View style={sr.headerRight}>
          <Text style={[sr.summaryAmount, { color: colors.primary }]}>
            {settlement.amount.toFixed(2)}
          </Text>
          {hasBreakdown ? (
            <Feather
              name={expanded ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={colors.mutedForeground}
            />
          ) : null}
        </View>
      </TouchableOpacity>

      {expanded && hasBreakdown ? (
        <View style={[sr.breakdown, { borderTopColor: colors.border }]}>
          {breakdown.map((line, idx) => (
            <View
              key={`${line.expenseId}-${idx}`}
              style={[
                sr.breakdownRow,
                idx < breakdown.length - 1 && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: colors.border,
                },
              ]}
            >
              <View style={sr.breakdownLeft}>
                <Text style={[sr.breakdownDesc, { color: colors.foreground }]} numberOfLines={1}>
                  {line.description}
                </Text>
                <Text style={[sr.breakdownDate, { color: colors.mutedForeground }]}>
                  {formatDate(line.date)}
                </Text>
              </View>
              <Text style={[sr.breakdownAmount, { color: colors.mutedForeground }]}>
                {line.shareAmount.toFixed(2)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {!isLast ? <View style={[sr.divider, { backgroundColor: colors.border }]} /> : null}
    </View>
  );
}

const sr = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 2,
    gap: 8,
  },
  headerLeft: { flex: 1, gap: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  summaryText: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  expenseCount: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  summaryAmount: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  breakdown: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 6,
    paddingBottom: 4,
  },
  breakdownRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 6,
    paddingHorizontal: 4,
    gap: 8,
  },
  breakdownLeft: { flex: 1, gap: 1 },
  breakdownDesc: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  breakdownDate: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  breakdownAmount: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  divider: { height: StyleSheet.hairlineWidth, marginHorizontal: 2 },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSplitDebts(expenses: TripExpense[]): SplitDebt[] {
  const debts: SplitDebt[] = [];

  for (const expense of expenses) {
    const payerName = expense.payerName ?? `User ${expense.paidByUserId}`;
    for (const split of expense.splits) {
      if (split.isPaid) continue;
      if (split.userId === expense.paidByUserId) continue;

      debts.push({
        fromUserId:        split.userId,
        fromName:          split.userName ?? `User ${split.userId}`,
        toUserId:          expense.paidByUserId,
        toName:            payerName,
        expenseId:         expense.id,
        expenseDescription: expense.description,
        amount:            parseFloat(split.shareAmount),
      });
    }
  }

  return debts;
}

// ── Main section ──────────────────────────────────────────────────────────────

export function TripBalanceSection({ tripId, bottomPad = 16 }: { tripId: number; bottomPad?: number }) {
  const colors = useColors();
  const queryClient = useQueryClient();

  const { data: balance, isLoading, isError, refetch, isRefetching } = useGetExpenseBalance(
    tripId,
    { query: { enabled: !!tripId } }
  );
  const { data: expenses = [], isLoading: expensesLoading } = useListExpenses(
    tripId,
    { query: { enabled: !!tripId } }
  );

  function invalidateAll() {
    queryClient.invalidateQueries({ queryKey: getGetExpenseBalanceQueryKey(tripId) });
    queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey(tripId) });
  }

  if (isLoading || expensesLoading) {
    return <View style={bs.center}><ActivityIndicator color={colors.primary} size="large" /></View>;
  }
  if (isError) {
    return (
      <View style={bs.center}>
        <Feather name="alert-circle" size={28} color={colors.mutedForeground} />
        <TouchableOpacity onPress={() => refetch()} style={[bs.retryBtn, { backgroundColor: colors.primary }]}>
          <Text style={bs.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const splitDebts = buildSplitDebts(expenses);
  const hasOutstanding = splitDebts.length > 0;

  // Build breakdown map once — shared across all SettlementRow instances
  const settlementBreakdowns = buildAllSettlementBreakdowns(expenses);

  return (
    <FlatList
      data={[1]}
      keyExtractor={() => 'balance'}
      renderItem={() => (
        <View style={bs.content}>
          {/* Total Spent */}
          <View style={[bs.totalCard, { backgroundColor: colors.primary }]}>
            <Text style={bs.totalLabel}>Total Spent</Text>
            <Text style={bs.totalAmount}>
              {balance?.currency ?? 'USD'} {(balance?.totalSpent ?? 0).toFixed(2)}
            </Text>
          </View>

          {/* Per-person net balance */}
          {balance && balance.balances.length > 0 ? (
            <>
              <Text style={[bs.sectionTitle, { color: colors.mutedForeground }]}>PER PERSON</Text>
              <View style={bs.balList}>
                {balance.balances.map((entry) => (
                  <BalanceCard key={entry.userId} entry={entry} colors={colors} />
                ))}
              </View>
            </>
          ) : null}

          {/* Suggested net settlement — expandable per row */}
          {balance && balance.settlements.length > 0 ? (
            <>
              <Text style={[bs.sectionTitle, { color: colors.mutedForeground }]}>WHO PAYS WHOM</Text>
              <View style={[bs.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {balance.settlements.map((s, i) => (
                  <SettlementRow
                    key={`${s.fromUserId}-${s.toUserId}`}
                    settlement={s}
                    breakdown={settlementBreakdowns.get(`${s.fromUserId}-${s.toUserId}`) ?? []}
                    isLast={i === balance.settlements.length - 1}
                    colors={colors}
                  />
                ))}
                <Text style={[bs.summaryHint, { color: colors.mutedForeground }]}>
                  Tap a row to see which expenses make up the amount
                </Text>
              </View>
            </>
          ) : null}

          {/* Actionable individual splits */}
          {hasOutstanding ? (
            <>
              <Text style={[bs.sectionTitle, { color: colors.mutedForeground }]}>OUTSTANDING SPLITS</Text>
              <View style={[bs.splitList, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {splitDebts.map((debt, i) => (
                  <React.Fragment key={`${debt.expenseId}-${debt.fromUserId}`}>
                    {i > 0 ? <View style={[bs.divider, { backgroundColor: colors.border }]} /> : null}
                    <SplitRow
                      debt={debt}
                      tripId={tripId}
                      colors={colors}
                      onSettled={invalidateAll}
                    />
                  </React.Fragment>
                ))}
              </View>
            </>
          ) : balance && balance.totalSpent > 0 ? (
            <View style={[bs.settledBanner, { backgroundColor: '#10B98118' }]}>
              <Feather name="check-circle" size={16} color="#10B981" />
              <Text style={[bs.settledText, { color: '#10B981' }]}>All settled up!</Text>
            </View>
          ) : null}
        </View>
      )}
      contentContainerStyle={{ paddingBottom: bottomPad + 16 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
      }
    />
  );
}

const bs = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  content: { padding: 12, gap: 12 },
  totalCard: { borderRadius: 16, padding: 20, alignItems: 'center', gap: 4 },
  totalLabel: {
    fontSize: 12, fontFamily: 'Inter_500Medium',
    color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: 0.8,
  },
  totalAmount: { fontSize: 32, fontFamily: 'Inter_700Bold', color: '#fff' },
  sectionTitle: { fontSize: 11, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, paddingHorizontal: 4 },
  balList: { gap: 8 },
  summaryCard: {
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden', paddingHorizontal: 12, paddingTop: 2, paddingBottom: 10,
  },
  summaryHint: { fontSize: 11, fontFamily: 'Inter_400Regular', fontStyle: 'italic', marginTop: 6 },
  splitList: {
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden', padding: 10, gap: 8,
  },
  divider: { height: StyleSheet.hairlineWidth },
  settledBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14, borderRadius: 12 },
  settledText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20 },
  retryText: { color: '#fff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
