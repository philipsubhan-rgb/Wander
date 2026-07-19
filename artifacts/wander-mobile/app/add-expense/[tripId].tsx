import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  FlatList,
  Platform,
  ScrollView,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useCreateExpense,
  useListTripParticipants,
  getListExpensesQueryKey,
  getGetExpenseBalanceQueryKey,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/context/AuthContext';

type Category = 'travel' | 'activity' | 'restaurant' | 'car_rental' | 'accommodation' | 'other';

const CATEGORIES: { key: Category; label: string; icon: keyof typeof Feather.glyphMap; color: string }[] = [
  { key: 'restaurant', label: 'Food', icon: 'coffee', color: '#F59E0B' },
  { key: 'travel', label: 'Travel', icon: 'navigation', color: '#2F7CE0' },
  { key: 'accommodation', label: 'Stay', icon: 'home', color: '#EC4899' },
  { key: 'activity', label: 'Activity', icon: 'zap', color: '#10B981' },
  { key: 'car_rental', label: 'Car', icon: 'truck', color: '#8B5CF6' },
  { key: 'other', label: 'Other', icon: 'tag', color: '#6B7FA3' },
];

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'];

function isoToday() {
  return new Date().toISOString().slice(0, 10);
}

function formatDisplay(raw: string): string {
  if (!raw || raw === '0') return '0.00';
  const num = parseFloat(raw);
  if (isNaN(num)) return '0.00';
  return num.toFixed(2);
}

export default function AddExpenseScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { tripId: tripIdParam } = useLocalSearchParams<{ tripId: string }>();
  const tripId = Number(tripIdParam);
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const isWeb = Platform.OS === 'web';

  const [amountRaw, setAmountRaw] = useState('');
  const [category, setCategory] = useState<Category>('restaurant');
  const [description, setDescription] = useState('');
  const [paidByUserId, setPaidByUserId] = useState<number | null>(user?.id ?? null);

  const { data: participants } = useListTripParticipants(tripId, {
    query: { enabled: !!tripId },
  });

  const { mutate: createExpense, isPending } = useCreateExpense({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetExpenseBalanceQueryKey(tripId) });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
      },
    },
  });

  function handlePad(key: string) {
    Haptics.selectionAsync();
    if (key === '⌫') {
      setAmountRaw((prev) => prev.slice(0, -1));
      return;
    }
    if (key === '.' && amountRaw.includes('.')) return;
    // Max 2 decimal places
    if (amountRaw.includes('.')) {
      const decimals = amountRaw.split('.')[1] ?? '';
      if (decimals.length >= 2) return;
    }
    if (key !== '.' && amountRaw === '') {
      if (key === '0') return; // don't start with 0
      setAmountRaw(key);
      return;
    }
    setAmountRaw((prev) => prev + key);
  }

  function handleSubmit() {
    const numericAmount = parseFloat(amountRaw || '0');
    if (!numericAmount || numericAmount <= 0) return;
    if (!description.trim()) return;
    const payerId = paidByUserId ?? user?.id;
    if (!payerId) return;

    createExpense({
      tripId,
      data: {
        paidByUserId: payerId,
        amount: numericAmount.toFixed(2),
        currency: 'USD',
        description: description.trim(),
        category,
        date: isoToday(),
      },
    });
  }

  const canSubmit = !!(
    parseFloat(amountRaw || '0') > 0 &&
    description.trim() &&
    paidByUserId &&
    !isPending
  );

  const catSelected = CATEGORIES.find((c) => c.key === category)!;

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: colors.background,
          paddingBottom: isWeb ? insets.bottom + 34 : insets.bottom + 16,
        },
      ]}
    >
      {/* Handle & header */}
      <View style={[styles.header, { paddingTop: isWeb ? 67 : insets.top > 0 ? insets.top + 8 : 20 }]}>
        <View style={[styles.handle, { backgroundColor: colors.border }]} />
        <View style={styles.headerRow}>
          <Text style={[styles.headerTitle, { color: colors.foreground }]}>Add Expense</Text>
          <TouchableOpacity onPress={() => router.back()} hitSlop={8}>
            <Feather name="x" size={22} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Amount display */}
        <View style={styles.amountArea}>
          <View style={[styles.catBadge, { backgroundColor: catSelected.color + '20' }]}>
            <Feather name={catSelected.icon} size={14} color={catSelected.color} />
            <Text style={[styles.catLabel, { color: catSelected.color }]}>{catSelected.label}</Text>
          </View>
          <Text style={[styles.amountDisplay, { color: colors.foreground }]}>
            <Text style={[styles.currencySign, { color: colors.mutedForeground }]}>$ </Text>
            {amountRaw ? formatDisplay(amountRaw) : '0.00'}
          </Text>
        </View>

        {/* Numpad */}
        <View style={styles.numpad}>
          {PAD_KEYS.map((key) => (
            <TouchableOpacity
              key={key}
              style={[
                styles.padKey,
                {
                  backgroundColor: key === '⌫' ? colors.muted : colors.card,
                  borderColor: colors.border,
                },
              ]}
              onPress={() => handlePad(key)}
              activeOpacity={0.7}
              testID={`pad-${key}`}
            >
              {key === '⌫' ? (
                <Feather name="delete" size={18} color={colors.foreground} />
              ) : (
                <Text style={[styles.padKeyText, { color: colors.foreground }]}>{key}</Text>
              )}
            </TouchableOpacity>
          ))}
        </View>

        {/* Category */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>CATEGORY</Text>
        <View style={styles.catGrid}>
          {CATEGORIES.map((cat) => {
            const active = category === cat.key;
            return (
              <TouchableOpacity
                key={cat.key}
                style={[
                  styles.catChip,
                  {
                    backgroundColor: active ? cat.color : colors.card,
                    borderColor: active ? cat.color : colors.border,
                  },
                ]}
                onPress={() => {
                  setCategory(cat.key);
                  Haptics.selectionAsync();
                }}
                activeOpacity={0.8}
              >
                <Feather name={cat.icon} size={14} color={active ? '#fff' : cat.color} />
                <Text style={[styles.catChipText, { color: active ? '#fff' : colors.foreground }]}>
                  {cat.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Description */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>DESCRIPTION</Text>
        <View style={[styles.inputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            style={[styles.input, { color: colors.foreground }]}
            placeholder="e.g. Dinner at Nobu"
            placeholderTextColor={colors.mutedForeground}
            value={description}
            onChangeText={setDescription}
            returnKeyType="done"
            testID="description-input"
          />
        </View>

        {/* Paid by */}
        {participants && participants.length > 0 ? (
          <>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>PAID BY</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.paidByScroll}>
              {participants.map((p) => {
                const active = paidByUserId === p.id;
                const initials = p.name
                  .split(' ')
                  .map((w) => w[0])
                  .slice(0, 2)
                  .join('')
                  .toUpperCase();
                return (
                  <TouchableOpacity
                    key={p.id}
                    style={[
                      styles.paidByChip,
                      {
                        backgroundColor: active ? colors.primary : colors.card,
                        borderColor: active ? colors.primary : colors.border,
                      },
                    ]}
                    onPress={() => {
                      setPaidByUserId(p.id);
                      Haptics.selectionAsync();
                    }}
                  >
                    <View style={[styles.chipAvatar, { backgroundColor: active ? '#fff3' : colors.muted }]}>
                      <Text style={[styles.chipAvatarText, { color: active ? '#fff' : colors.primary }]}>
                        {initials}
                      </Text>
                    </View>
                    <Text style={[styles.chipName, { color: active ? '#fff' : colors.foreground }]}>
                      {p.name.split(' ')[0]}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollView>
          </>
        ) : null}

        {/* Submit */}
        <TouchableOpacity
          style={[
            styles.submitBtn,
            { backgroundColor: canSubmit ? colors.primary : colors.muted },
          ]}
          onPress={handleSubmit}
          disabled={!canSubmit}
          activeOpacity={0.85}
          testID="submit-expense"
        >
          {isPending ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Feather name="check" size={16} color={canSubmit ? '#fff' : colors.mutedForeground} />
              <Text style={[styles.submitText, { color: canSubmit ? '#fff' : colors.mutedForeground }]}>
                Add Expense
              </Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    alignItems: 'center',
    gap: 12,
  },
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
  },
  amountArea: {
    alignItems: 'center',
    paddingVertical: 16,
    gap: 8,
  },
  catBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  catLabel: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  amountDisplay: {
    fontSize: 52,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -1,
  },
  currencySign: {
    fontSize: 28,
    fontFamily: 'Inter_400Regular',
  },
  numpad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 16,
  },
  padKey: {
    width: '30%',
    flexGrow: 1,
    aspectRatio: 1.8,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  padKeyText: {
    fontSize: 22,
    fontFamily: 'Inter_400Regular',
  },
  sectionLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    paddingHorizontal: 20,
    marginBottom: 8,
  },
  catGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 16,
  },
  catChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
  },
  catChipText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  inputWrap: {
    marginHorizontal: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 16,
  },
  input: {
    fontSize: 15,
    fontFamily: 'Inter_400Regular',
    padding: 0,
    margin: 0,
  },
  paidByScroll: {
    paddingLeft: 16,
    marginBottom: 16,
  },
  paidByChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingRight: 12,
    paddingLeft: 6,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    marginRight: 8,
  },
  chipAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipAvatarText: { fontSize: 11, fontFamily: 'Inter_700Bold' },
  chipName: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  submitBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    marginTop: 4,
    paddingVertical: 15,
    borderRadius: 14,
  },
  submitText: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
});
