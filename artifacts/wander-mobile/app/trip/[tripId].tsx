import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  Alert,
  RefreshControl,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useGetTrip,
  useListExpenses,
  useGetExpenseBalance,
  useDeleteExpense,
  getListExpensesQueryKey,
  getGetExpenseBalanceQueryKey,
} from '@workspace/api-client-react';
import type { TripExpense, ExpenseBalanceEntry, ExpenseSettlement } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/context/AuthContext';

// ── Category helpers ────────────────────────────────────────────────────────

type Category = 'travel' | 'activity' | 'restaurant' | 'car_rental' | 'accommodation' | 'other';

const CAT_ICONS: Record<Category, keyof typeof Feather.glyphMap> = {
  travel: 'navigation',
  activity: 'zap',
  restaurant: 'coffee',
  car_rental: 'truck',
  accommodation: 'home',
  other: 'tag',
};

const CAT_COLORS: Record<Category, string> = {
  travel: '#2F7CE0',
  activity: '#10B981',
  restaurant: '#F59E0B',
  car_rental: '#8B5CF6',
  accommodation: '#EC4899',
  other: '#6B7FA3',
};

function catIcon(cat: string) {
  return CAT_ICONS[(cat as Category)] ?? 'tag';
}
function catColor(cat: string) {
  return CAT_COLORS[(cat as Category)] ?? '#6B7FA3';
}

// ── Expenses list ───────────────────────────────────────────────────────────

function ExpenseRow({
  expense,
  colors,
  onDelete,
}: {
  expense: TripExpense;
  colors: ReturnType<typeof useColors>;
  onDelete: (id: number) => void;
}) {
  const color = catColor(expense.category);
  const icon = catIcon(expense.category);
  const amount = parseFloat(expense.amount);
  const date = new Date(expense.date);

  function confirmDelete() {
    Alert.alert('Delete Expense', `Remove "${expense.description}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onDelete(expense.id);
        },
      },
    ]);
  }

  return (
    <View style={[expenseStyles.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[expenseStyles.catIcon, { backgroundColor: color + '18' }]}>
        <Feather name={icon} size={16} color={color} />
      </View>
      <View style={expenseStyles.body}>
        <Text style={[expenseStyles.desc, { color: colors.foreground }]} numberOfLines={1}>
          {expense.description}
        </Text>
        <View style={expenseStyles.meta}>
          <Text style={[expenseStyles.payer, { color: colors.mutedForeground }]}>
            {expense.payerName ?? 'Unknown'}
          </Text>
          <View style={expenseStyles.dot} />
          <Text style={[expenseStyles.date, { color: colors.mutedForeground }]}>
            {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </Text>
        </View>
      </View>
      <View style={expenseStyles.right}>
        <Text style={[expenseStyles.amount, { color: colors.foreground }]}>
          {expense.currency} {amount.toFixed(2)}
        </Text>
        <TouchableOpacity onPress={confirmDelete} hitSlop={8} style={{ marginTop: 4 }}>
          <Feather name="trash-2" size={13} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const expenseStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 12,
  },
  catIcon: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  body: { flex: 1, gap: 3 },
  desc: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payer: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  dot: {
    width: 3,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#6B7FA3',
  },
  date: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  right: { alignItems: 'flex-end', gap: 2 },
  amount: { fontSize: 15, fontFamily: 'Inter_700Bold' },
});

// ── Balance card ────────────────────────────────────────────────────────────

function BalanceCard({
  entry,
  colors,
}: {
  entry: ExpenseBalanceEntry;
  colors: ReturnType<typeof useColors>;
}) {
  const net = entry.net;
  const isPositive = net > 0;
  const isNeutral = Math.abs(net) < 0.005;
  const color = isNeutral ? colors.mutedForeground : isPositive ? '#10B981' : colors.destructive;

  const initials = entry.name
    .split(' ')
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

  return (
    <View
      style={[balanceStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
    >
      <View style={[balanceStyles.avatar, { backgroundColor: colors.primary + '20' }]}>
        <Text style={[balanceStyles.avatarText, { color: colors.primary }]}>{initials}</Text>
      </View>
      <View style={balanceStyles.info}>
        <Text style={[balanceStyles.name, { color: colors.foreground }]}>{entry.name}</Text>
        <Text style={[balanceStyles.sub, { color: colors.mutedForeground }]}>
          Paid {entry.totalPaid.toFixed(2)} · Owes {entry.totalOwed.toFixed(2)}
        </Text>
      </View>
      <View style={[balanceStyles.netBadge, { backgroundColor: color + '18' }]}>
        <Text style={[balanceStyles.netText, { color }]}>
          {isNeutral ? 'Settled' : `${isPositive ? '+' : ''}${net.toFixed(2)}`}
        </Text>
      </View>
    </View>
  );
}

const balanceStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    gap: 12,
  },
  avatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  info: { flex: 1, gap: 2 },
  name: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  sub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  netBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 8,
  },
  netText: { fontSize: 13, fontFamily: 'Inter_700Bold' },
});

function SettlementRow({
  s,
  colors,
}: {
  s: ExpenseSettlement;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View
      style={[settlementStyles.row, { backgroundColor: colors.muted + '80', borderRadius: 10, padding: 10 }]}
    >
      <Text style={[settlementStyles.text, { color: colors.foreground }]}>
        <Text style={{ fontFamily: 'Inter_600SemiBold' }}>{s.fromName}</Text>
        {' owes '}
        <Text style={{ fontFamily: 'Inter_600SemiBold' }}>{s.toName}</Text>
      </Text>
      <Text style={[settlementStyles.amount, { color: colors.primary }]}>
        {s.amount.toFixed(2)}
      </Text>
    </View>
  );
}

const settlementStyles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  text: { fontSize: 13, fontFamily: 'Inter_400Regular', flex: 1 },
  amount: { fontSize: 13, fontFamily: 'Inter_700Bold' },
});

// ── Main screen ─────────────────────────────────────────────────────────────

type Tab = 'expenses' | 'balance';

export default function TripDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { tripId: tripIdParam } = useLocalSearchParams<{ tripId: string }>();
  const tripId = Number(tripIdParam);
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isWeb = Platform.OS === 'web';
  const [activeTab, setActiveTab] = useState<Tab>('expenses');

  const { data: trip } = useGetTrip(tripId);

  const {
    data: expenses,
    isLoading: expLoading,
    isError: expError,
    refetch: refetchExp,
    isRefetching: expRefetching,
  } = useListExpenses(tripId, { query: { enabled: !!tripId } });

  const {
    data: balance,
    isLoading: balLoading,
    isError: balError,
    refetch: refetchBal,
    isRefetching: balRefetching,
  } = useGetExpenseBalance(tripId, { query: { enabled: !!tripId } });

  const { mutate: deleteExpense } = useDeleteExpense({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetExpenseBalanceQueryKey(tripId) });
      },
    },
  });

  function handleDelete(expenseId: number) {
    deleteExpense({ tripId, expenseId });
  }

  function openAddExpense() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push(`/add-expense/${tripId}`);
  }

  const bottomPad = isWeb ? insets.bottom + 34 : insets.bottom;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Trip title section */}
      <View style={[styles.tripHeader, { borderBottomColor: colors.border }]}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.tripTitle, { color: colors.foreground }]} numberOfLines={1}>
            {trip?.title ?? '…'}
          </Text>
          {trip?.destination ? (
            <View style={styles.destRow}>
              <Feather name="map-pin" size={12} color={colors.mutedForeground} />
              <Text style={[styles.tripDest, { color: colors.mutedForeground }]}>{trip.destination}</Text>
            </View>
          ) : null}
        </View>
        <TouchableOpacity
          style={[styles.addBtn, { backgroundColor: colors.primary }]}
          onPress={openAddExpense}
          testID="add-expense-button"
          activeOpacity={0.85}
        >
          <Feather name="plus" size={18} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Segment tabs */}
      <View style={[styles.tabRow, { backgroundColor: colors.muted, borderColor: colors.border }]}>
        {(['expenses', 'balance'] as Tab[]).map((tab) => (
          <TouchableOpacity
            key={tab}
            style={[
              styles.tabBtn,
              activeTab === tab && { backgroundColor: colors.card },
            ]}
            onPress={() => {
              setActiveTab(tab);
              Haptics.selectionAsync();
            }}
          >
            <Feather
              name={tab === 'expenses' ? 'credit-card' : 'bar-chart-2'}
              size={14}
              color={activeTab === tab ? colors.primary : colors.mutedForeground}
            />
            <Text
              style={[
                styles.tabLabel,
                { color: activeTab === tab ? colors.primary : colors.mutedForeground },
                activeTab === tab && { fontFamily: 'Inter_600SemiBold' },
              ]}
            >
              {tab === 'expenses' ? 'Expenses' : 'Balance'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Content */}
      {activeTab === 'expenses' ? (
        expLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.primary} size="large" />
          </View>
        ) : expError ? (
          <View style={styles.center}>
            <Feather name="alert-circle" size={28} color={colors.mutedForeground} />
            <Text style={[styles.errText, { color: colors.foreground }]}>Failed to load</Text>
            <TouchableOpacity
              onPress={() => refetchExp()}
              style={[styles.retryBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <FlatList
            data={expenses ?? []}
            keyExtractor={(e) => String(e.id)}
            renderItem={({ item }) => (
              <ExpenseRow expense={item} colors={colors} onDelete={handleDelete} />
            )}
            contentContainerStyle={[styles.list, { paddingBottom: bottomPad + 16 }]}
            scrollEnabled={!!(expenses && expenses.length > 0)}
            showsVerticalScrollIndicator={false}
            refreshControl={
              <RefreshControl
                refreshing={expRefetching}
                onRefresh={refetchExp}
                tintColor={colors.primary}
              />
            }
            ListHeaderComponent={
              expenses && expenses.length > 0 ? (
                <Text style={[styles.listHeader, { color: colors.mutedForeground }]}>
                  {expenses.length} expense{expenses.length !== 1 ? 's' : ''}
                </Text>
              ) : null
            }
            ListEmptyComponent={
              <View style={styles.empty}>
                <Feather name="credit-card" size={36} color={colors.mutedForeground} />
                <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No expenses yet</Text>
                <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
                  Tap + to add the first expense for this trip.
                </Text>
              </View>
            }
          />
        )
      ) : balLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : balError ? (
        <View style={styles.center}>
          <Feather name="alert-circle" size={28} color={colors.mutedForeground} />
          <Text style={[styles.errText, { color: colors.foreground }]}>Failed to load</Text>
          <TouchableOpacity
            onPress={() => refetchBal()}
            style={[styles.retryBtn, { backgroundColor: colors.primary }]}
          >
            <Text style={styles.retryText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={[1]}
          keyExtractor={() => 'balance'}
          renderItem={() => (
            <View style={styles.balanceContent}>
              {/* Total */}
              <View style={[styles.totalCard, { backgroundColor: colors.primary }]}>
                <Text style={styles.totalLabel}>Total Spent</Text>
                <Text style={styles.totalAmount}>
                  {balance?.currency ?? 'USD'} {(balance?.totalSpent ?? 0).toFixed(2)}
                </Text>
              </View>

              {/* Per-person balances */}
              {balance && balance.balances.length > 0 ? (
                <>
                  <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
                    PER PERSON
                  </Text>
                  <View style={styles.balanceList}>
                    {balance.balances.map((entry) => (
                      <BalanceCard key={entry.userId} entry={entry} colors={colors} />
                    ))}
                  </View>
                </>
              ) : null}

              {/* Settlements */}
              {balance && balance.settlements.length > 0 ? (
                <>
                  <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>
                    WHO PAYS WHOM
                  </Text>
                  <View style={[styles.settlementCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                    {balance.settlements.map((s, i) => (
                      <React.Fragment key={`${s.fromUserId}-${s.toUserId}`}>
                        {i > 0 ? (
                          <View style={[styles.settleDivider, { backgroundColor: colors.border }]} />
                        ) : null}
                        <SettlementRow s={s} colors={colors} />
                      </React.Fragment>
                    ))}
                  </View>
                </>
              ) : balance && balance.totalSpent > 0 ? (
                <View style={[styles.settledBanner, { backgroundColor: '#10B98118' }]}>
                  <Feather name="check-circle" size={16} color="#10B981" />
                  <Text style={[styles.settledText, { color: '#10B981' }]}>
                    All settled up!
                  </Text>
                </View>
              ) : null}
            </View>
          )}
          contentContainerStyle={{ paddingBottom: bottomPad + 16 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={balRefetching}
              onRefresh={refetchBal}
              tintColor={colors.primary}
            />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  tripHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  tripTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
  },
  destRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  tripDest: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  addBtn: {
    width: 40,
    height: 40,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabRow: {
    flexDirection: 'row',
    margin: 12,
    borderRadius: 10,
    padding: 3,
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    paddingVertical: 8,
    borderRadius: 8,
  },
  tabLabel: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  list: { padding: 12, gap: 8 },
  listHeader: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    paddingHorizontal: 4,
    paddingBottom: 8,
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  empty: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: { fontSize: 18, fontFamily: 'Inter_600SemiBold', marginTop: 12 },
  emptySub: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  errText: { fontSize: 16, fontFamily: 'Inter_500Medium' },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20 },
  retryText: { color: '#fff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },

  // Balance styles
  balanceContent: { padding: 12, gap: 12 },
  totalCard: {
    borderRadius: 16,
    padding: 20,
    alignItems: 'center',
    gap: 4,
  },
  totalLabel: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    color: 'rgba(255,255,255,0.8)',
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  totalAmount: {
    fontSize: 32,
    fontFamily: 'Inter_700Bold',
    color: '#fff',
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    paddingHorizontal: 4,
  },
  balanceList: { gap: 8 },
  settlementCard: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    padding: 12,
    gap: 10,
  },
  settleDivider: { height: StyleSheet.hairlineWidth },
  settledBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    padding: 14,
    borderRadius: 12,
  },
  settledText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});
