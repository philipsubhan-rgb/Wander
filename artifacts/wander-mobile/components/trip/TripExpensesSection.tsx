import React from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  ActivityIndicator, Alert, RefreshControl, Image,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useListExpenses, useDeleteExpense,
  getListExpensesQueryKey, getGetExpenseBalanceQueryKey,
} from '@workspace/api-client-react';
import type { TripExpense } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { getBaseUrl } from '@/lib/api';

type Category = 'travel' | 'activity' | 'restaurant' | 'car_rental' | 'accommodation' | 'other';

const CAT_ICONS: Record<Category, keyof typeof Feather.glyphMap> = {
  travel: 'navigation', activity: 'zap', restaurant: 'coffee',
  car_rental: 'truck', accommodation: 'home', other: 'tag',
};
const CAT_COLORS: Record<Category, string> = {
  travel: '#2F7CE0', activity: '#10B981', restaurant: '#F59E0B',
  car_rental: '#8B5CF6', accommodation: '#EC4899', other: '#6B7FA3',
};

/** Convert a stored objectPath (e.g. /objects/uploads/uuid) to a full serving URL. */
function receiptImageUrl(objectPath: string): string {
  const base = getBaseUrl();
  // objectPath already starts with /objects/…, serving endpoint is /api/storage/objects/…
  const withoutPrefix = objectPath.replace(/^\/objects\//, '');
  return `${base}/api/storage/objects/${withoutPrefix}`;
}

function ExpenseRow({ expense, colors, onDelete, onEdit }: {
  expense: TripExpense; colors: ReturnType<typeof useColors>; onDelete: (id: number) => void; onEdit: (id: number) => void;
}) {
  const color = CAT_COLORS[(expense.category as Category)] ?? '#6B7FA3';
  const icon = CAT_ICONS[(expense.category as Category)] ?? 'tag';
  const amount = parseFloat(expense.amount);
  const date = new Date(expense.date);
  const receiptUrl = expense.receiptUrl ? receiptImageUrl(expense.receiptUrl) : null;

  function confirmDelete() {
    Alert.alert('Delete Expense', `Remove "${expense.description}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onDelete(expense.id); } },
    ]);
  }

  return (
    <View style={[er.row, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {receiptUrl ? (
        <Image source={{ uri: receiptUrl }} style={er.thumbnail} resizeMode="cover" />
      ) : (
        <View style={[er.catIcon, { backgroundColor: color + '18' }]}>
          <Feather name={icon} size={16} color={color} />
        </View>
      )}
      <View style={er.body}>
        <Text style={[er.desc, { color: colors.foreground }]} numberOfLines={1}>{expense.description}</Text>
        <View style={er.meta}>
          <Text style={[er.payer, { color: colors.mutedForeground }]}>{expense.payerName ?? 'Unknown'}</Text>
          <View style={er.dot} />
          <Text style={[er.date, { color: colors.mutedForeground }]}>
            {date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </Text>
          {receiptUrl && (
            <>
              <View style={er.dot} />
              <Feather name="camera" size={10} color={colors.mutedForeground} />
            </>
          )}
        </View>
      </View>
      <View style={er.right}>
        <Text style={[er.amount, { color: colors.foreground }]}>{expense.currency} {amount.toFixed(2)}</Text>
        <View style={er.rowActions}>
          <TouchableOpacity onPress={() => onEdit(expense.id)} hitSlop={8}>
            <Feather name="edit-2" size={13} color={colors.mutedForeground} />
          </TouchableOpacity>
          <TouchableOpacity onPress={confirmDelete} hitSlop={8}>
            <Feather name="trash-2" size={13} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const er = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 12, gap: 12 },
  catIcon: { width: 38, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  thumbnail: { width: 38, height: 38, borderRadius: 10 },
  body: { flex: 1, gap: 3 },
  desc: { fontSize: 14, fontFamily: 'Inter_500Medium' },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  payer: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  dot: { width: 3, height: 3, borderRadius: 1.5, backgroundColor: '#6B7FA3' },
  date: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  right: { alignItems: 'flex-end', gap: 4 },
  rowActions: { flexDirection: 'row', gap: 10 },
  amount: { fontSize: 15, fontFamily: 'Inter_700Bold' },
});

export function TripExpensesSection({ tripId, bottomPad = 16 }: { tripId: number; bottomPad?: number }) {
  const colors = useColors();
  const queryClient = useQueryClient();

  const { data: expenses, isLoading, isError, refetch, isRefetching } = useListExpenses(tripId, { query: { enabled: !!tripId } });
  const { mutate: deleteExpense } = useDeleteExpense({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetExpenseBalanceQueryKey(tripId) });
      },
    },
  });

  if (isLoading) return <View style={es.center}><ActivityIndicator color={colors.primary} size="large" /></View>;
  if (isError) return (
    <View style={es.center}>
      <Feather name="alert-circle" size={28} color={colors.mutedForeground} />
      <TouchableOpacity onPress={() => refetch()} style={[es.retryBtn, { backgroundColor: colors.primary }]}>
        <Text style={es.retryText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <FlatList
      data={expenses ?? []}
      keyExtractor={(e) => String(e.id)}
      renderItem={({ item }) => (
        <ExpenseRow
          expense={item}
          colors={colors}
          onDelete={(id) => deleteExpense({ tripId, expenseId: id })}
          onEdit={(id) => router.push(`/edit-expense/${tripId}/${id}` as never)}
        />
      )}
      contentContainerStyle={[es.list, { paddingBottom: bottomPad + 16 }]}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}
      ListHeaderComponent={
        expenses && expenses.length > 0 ? (
          <Text style={[es.listHeader, { color: colors.mutedForeground }]}>
            {expenses.length} expense{expenses.length !== 1 ? 's' : ''}
          </Text>
        ) : null
      }
      ListFooterComponent={
        <TouchableOpacity
          style={[es.addBtn, { backgroundColor: colors.primary }]}
          onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.push(`/add-expense/${tripId}`); }}
          testID="add-expense-button"
          activeOpacity={0.85}
        >
          <Feather name="plus" size={16} color="#fff" />
          <Text style={es.addBtnText}>Add Expense</Text>
        </TouchableOpacity>
      }
      ListEmptyComponent={
        <View style={es.empty}>
          <Feather name="credit-card" size={36} color={colors.mutedForeground} />
          <Text style={[es.emptyTitle, { color: colors.foreground }]}>No expenses yet</Text>
          <Text style={[es.emptySub, { color: colors.mutedForeground }]}>Tap Add Expense below to log the first expense.</Text>
        </View>
      }
    />
  );
}

const es = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  list: { padding: 12, gap: 8 },
  listHeader: { fontSize: 11, fontFamily: 'Inter_600SemiBold', paddingHorizontal: 4, paddingBottom: 8, letterSpacing: 0.5, textTransform: 'uppercase' },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8, paddingVertical: 14, borderRadius: 12 },
  addBtnText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  empty: { alignItems: 'center', paddingTop: 60, paddingHorizontal: 32, gap: 8 },
  emptyTitle: { fontSize: 18, fontFamily: 'Inter_600SemiBold', marginTop: 12 },
  emptySub: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20 },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20 },
  retryText: { color: '#fff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
