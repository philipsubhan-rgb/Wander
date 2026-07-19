import React from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useGetExpenseBalance } from '@workspace/api-client-react';
import type { ExpenseBalanceEntry, ExpenseSettlement } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

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

function SettlementRow({ s, colors }: { s: ExpenseSettlement; colors: ReturnType<typeof useColors> }) {
  return (
    <View style={[sr.row, { backgroundColor: colors.muted + '80', borderRadius: 10, padding: 10 }]}>
      <Text style={[sr.text, { color: colors.foreground }]}>
        <Text style={{ fontFamily: 'Inter_600SemiBold' }}>{s.fromName}</Text>
        {' owes '}
        <Text style={{ fontFamily: 'Inter_600SemiBold' }}>{s.toName}</Text>
      </Text>
      <Text style={[sr.amount, { color: colors.primary }]}>{s.amount.toFixed(2)}</Text>
    </View>
  );
}

const sr = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  text: { fontSize: 13, fontFamily: 'Inter_400Regular', flex: 1 },
  amount: { fontSize: 13, fontFamily: 'Inter_700Bold' },
});

export function TripBalanceSection({ tripId, bottomPad = 16 }: { tripId: number; bottomPad?: number }) {
  const colors = useColors();
  const { data: balance, isLoading, isError, refetch, isRefetching } = useGetExpenseBalance(tripId, { query: { enabled: !!tripId } });

  if (isLoading) return <View style={bs.center}><ActivityIndicator color={colors.primary} size="large" /></View>;
  if (isError) return (
    <View style={bs.center}>
      <Feather name="alert-circle" size={28} color={colors.mutedForeground} />
      <TouchableOpacity onPress={() => refetch()} style={[bs.retryBtn, { backgroundColor: colors.primary }]}>
        <Text style={bs.retryText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <FlatList
      data={[1]}
      keyExtractor={() => 'balance'}
      renderItem={() => (
        <View style={bs.content}>
          {/* Total */}
          <View style={[bs.totalCard, { backgroundColor: colors.primary }]}>
            <Text style={bs.totalLabel}>Total Spent</Text>
            <Text style={bs.totalAmount}>{balance?.currency ?? 'USD'} {(balance?.totalSpent ?? 0).toFixed(2)}</Text>
          </View>

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

          {balance && balance.settlements.length > 0 ? (
            <>
              <Text style={[bs.sectionTitle, { color: colors.mutedForeground }]}>WHO PAYS WHOM</Text>
              <View style={[bs.settlementCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                {balance.settlements.map((s, i) => (
                  <React.Fragment key={`${s.fromUserId}-${s.toUserId}`}>
                    {i > 0 ? <View style={[bs.divider, { backgroundColor: colors.border }]} /> : null}
                    <SettlementRow s={s} colors={colors} />
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
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}
    />
  );
}

const bs = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  content: { padding: 12, gap: 12 },
  totalCard: { borderRadius: 16, padding: 20, alignItems: 'center', gap: 4 },
  totalLabel: { fontSize: 12, fontFamily: 'Inter_500Medium', color: 'rgba(255,255,255,0.8)', textTransform: 'uppercase', letterSpacing: 0.8 },
  totalAmount: { fontSize: 32, fontFamily: 'Inter_700Bold', color: '#fff' },
  sectionTitle: { fontSize: 11, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, paddingHorizontal: 4 },
  balList: { gap: 8 },
  settlementCard: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', padding: 12, gap: 10 },
  divider: { height: StyleSheet.hairlineWidth },
  settledBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 14, borderRadius: 12 },
  settledText: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20 },
  retryText: { color: '#fff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
