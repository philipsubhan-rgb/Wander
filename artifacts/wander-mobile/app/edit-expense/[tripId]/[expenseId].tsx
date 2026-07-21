import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  ScrollView,
  Image,
  Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import {
  useListExpenses,
  useUpdateExpense,
  getListExpensesQueryKey,
  getGetExpenseBalanceQueryKey,
  requestUploadUrl,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { getBaseUrl } from '@/lib/api';

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

function formatDisplay(raw: string): string {
  if (!raw || raw === '0') return '0.00';
  const num = parseFloat(raw);
  if (isNaN(num)) return '0.00';
  return num.toFixed(2);
}

/** Convert a stored objectPath to a full serving URL (same logic as TripExpensesSection). */
function receiptImageUrl(objectPath: string): string {
  const base = getBaseUrl();
  const withoutPrefix = objectPath.replace(/^\/objects\//, '');
  return `${base}/api/storage/objects/${withoutPrefix}`;
}

export default function EditExpenseScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { tripId: tripIdParam, expenseId: expenseIdParam } = useLocalSearchParams<{
    tripId: string;
    expenseId: string;
  }>();
  const tripId = Number(tripIdParam);
  const expenseId = Number(expenseIdParam);
  const queryClient = useQueryClient();
  const isWeb = Platform.OS === 'web';

  // Load from the cached list — avoids a separate endpoint
  const { data: expenses, isLoading } = useListExpenses(tripId, {
    query: { enabled: !!tripId },
  });
  const expense = expenses?.find((e) => e.id === expenseId);

  // Expense detail fields — initialized from the loaded expense
  const [description, setDescription] = useState('');
  const [amountRaw, setAmountRaw] = useState('');
  const [category, setCategory] = useState<Category>('restaurant');
  const [date, setDate] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [initialized, setInitialized] = useState(false);

  // Receipt state
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const [pendingObjectPath, setPendingObjectPath] = useState<string | null>(null);
  const [removeReceipt, setRemoveReceipt] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  // Once the expense loads, seed the editable fields
  useEffect(() => {
    if (expense && !initialized) {
      setDescription(expense.description ?? '');
      setAmountRaw(parseFloat(expense.amount).toFixed(2));
      setCategory((expense.category as Category) ?? 'other');
      setDate(expense.date ? expense.date.slice(0, 10) : '');
      setCurrency(expense.currency ?? 'USD');
      setInitialized(true);
    }
  }, [expense, initialized]);

  const { mutate: updateExpense, isPending } = useUpdateExpense({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetExpenseBalanceQueryKey(tripId) });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
      },
      onError: () => {
        Alert.alert('Update failed', 'Could not save the changes. Please try again.');
      },
    },
  });

  // ── Numpad ─────────────────────────────────────────────────────────────────
  function handlePad(key: string) {
    Haptics.selectionAsync();
    if (key === '⌫') {
      setAmountRaw((prev) => prev.slice(0, -1));
      return;
    }
    if (key === '.' && amountRaw.includes('.')) return;
    if (amountRaw.includes('.')) {
      const decimals = amountRaw.split('.')[1] ?? '';
      if (decimals.length >= 2) return;
    }
    if (key !== '.' && amountRaw === '') {
      if (key === '0') return;
      setAmountRaw(key);
      return;
    }
    setAmountRaw((prev) => prev + key);
  }

  // ── Receipt helpers ────────────────────────────────────────────────────────
  async function uploadReceipt(uri: string, fileName: string, mimeType: string): Promise<string | null> {
    setIsUploading(true);
    try {
      const imageRes = await fetch(uri);
      if (!imageRes.ok) throw new Error(`Failed to read image: ${imageRes.status}`);
      const blob = await imageRes.blob();

      const { uploadURL, objectPath } = await requestUploadUrl({
        name: fileName,
        size: blob.size || 1,
        contentType: mimeType,
      });

      const uploadRes = await fetch(uploadURL, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: blob,
      });
      if (!uploadRes.ok) throw new Error(`GCS upload responded ${uploadRes.status}`);

      return objectPath;
    } catch (err) {
      console.error('[upload] Error uploading receipt', err);
      Alert.alert(
        'Receipt upload failed',
        'Could not attach the receipt photo. You can try again.',
        [{ text: 'OK' }],
      );
      return null;
    } finally {
      setIsUploading(false);
    }
  }

  async function pickAndUpload(launchFn: () => Promise<ImagePicker.ImagePickerResult>) {
    const result = await launchFn();
    if (!result.canceled && result.assets[0]) {
      const asset = result.assets[0];
      setReceiptUri(asset.uri);
      setPendingObjectPath(null);
      setRemoveReceipt(false);
      const mimeType = asset.mimeType ?? 'image/jpeg';
      const fileName = asset.fileName ?? `receipt-${Date.now()}.jpg`;
      const objectPath = await uploadReceipt(asset.uri, fileName, mimeType);
      if (objectPath) setPendingObjectPath(objectPath);
    }
  }

  async function handlePickReceipt() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (isWeb) {
      await pickAndUpload(() =>
        ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 0.7,
          allowsEditing: false,
        }),
      );
      return;
    }

    Alert.alert('Add Receipt', 'Choose a source', [
      {
        text: 'Camera',
        onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) {
            Alert.alert('Permission required', 'Camera access is needed to capture receipts.');
            return;
          }
          await pickAndUpload(() =>
            ImagePicker.launchCameraAsync({
              mediaTypes: ['images'],
              quality: 0.7,
              allowsEditing: false,
            }),
          );
        },
      },
      {
        text: 'Photo Library',
        onPress: async () => {
          const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
          if (!perm.granted) {
            Alert.alert('Permission required', 'Photo library access is needed to pick receipts.');
            return;
          }
          await pickAndUpload(() =>
            ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              quality: 0.7,
              allowsEditing: false,
            }),
          );
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function handleClearReceipt() {
    Alert.alert('Remove Receipt', 'Remove the receipt photo from this expense?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          setReceiptUri(null);
          setPendingObjectPath(null);
          setRemoveReceipt(true);
        },
      },
    ]);
  }

  // ── Save ───────────────────────────────────────────────────────────────────
  function handleSave() {
    if (!expense) return;

    const numericAmount = parseFloat(amountRaw || '0');
    if (!numericAmount || numericAmount <= 0) {
      Alert.alert('Invalid amount', 'Please enter a valid amount greater than 0.');
      return;
    }
    if (!description.trim()) {
      Alert.alert('Missing description', 'Please enter a description for this expense.');
      return;
    }
    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) {
      Alert.alert('Invalid date', 'Please use the format YYYY-MM-DD.');
      return;
    }

    const receiptUrlPatch: { receiptUrl?: string | null } = {};
    if (pendingObjectPath !== null) {
      receiptUrlPatch.receiptUrl = pendingObjectPath;
    } else if (removeReceipt) {
      receiptUrlPatch.receiptUrl = null;
    }

    updateExpense({
      tripId,
      expenseId,
      data: {
        description: description.trim(),
        amount: numericAmount.toFixed(2),
        currency,
        category,
        date,
        ...receiptUrlPatch,
      },
    });
  }

  // ── Derived ────────────────────────────────────────────────────────────────
  const existingReceiptUrl = expense?.receiptUrl ? receiptImageUrl(expense.receiptUrl) : null;
  const previewUri = receiptUri ?? (removeReceipt ? null : existingReceiptUrl);
  const hasReceipt = previewUri !== null;

  const catSelected = CATEGORIES.find((c) => c.key === category) ?? CATEGORIES[5];

  const canSave =
    !isPending &&
    !isUploading &&
    description.trim().length > 0 &&
    parseFloat(amountRaw || '0') > 0;

  if (isLoading || !expense || !initialized) {
    return (
      <View style={[s.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <View
      style={[
        s.container,
        {
          backgroundColor: colors.background,
          paddingBottom: isWeb ? insets.bottom + 34 : insets.bottom + 16,
        },
      ]}
    >
      {/* Header */}
      <View style={[s.header, { paddingTop: isWeb ? 67 : insets.top > 0 ? insets.top + 8 : 20 }]}>
        <View style={[s.handle, { backgroundColor: colors.border }]} />
        <View style={s.headerRow}>
          <Text style={[s.headerTitle, { color: colors.foreground }]}>Edit Expense</Text>
          <TouchableOpacity onPress={() => router.back()} hitSlop={8}>
            <Feather name="x" size={22} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">

        {/* ── Amount display ── */}
        <View style={s.amountArea}>
          <View style={[s.catBadge, { backgroundColor: catSelected.color + '20' }]}>
            <Feather name={catSelected.icon} size={14} color={catSelected.color} />
            <Text style={[s.catLabel, { color: catSelected.color }]}>{catSelected.label}</Text>
          </View>
          <Text style={[s.amountDisplay, { color: colors.foreground }]}>
            <Text style={[s.currencySign, { color: colors.mutedForeground }]}>{currency} </Text>
            {amountRaw ? formatDisplay(amountRaw) : '0.00'}
          </Text>
        </View>

        {/* ── Numpad ── */}
        <View style={s.numpad}>
          {PAD_KEYS.map((key) => (
            <TouchableOpacity
              key={key}
              style={[
                s.padKey,
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
                <Text style={[s.padKeyText, { color: colors.foreground }]}>{key}</Text>
              )}
            </TouchableOpacity>
          ))}
        </View>

        {/* ── Currency ── */}
        <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>CURRENCY</Text>
        <View style={s.currencyRow}>
          {['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD'].map((cur) => {
            const active = currency === cur;
            return (
              <TouchableOpacity
                key={cur}
                style={[
                  s.currencyChip,
                  {
                    backgroundColor: active ? colors.primary : colors.card,
                    borderColor: active ? colors.primary : colors.border,
                  },
                ]}
                onPress={() => {
                  setCurrency(cur);
                  Haptics.selectionAsync();
                }}
                activeOpacity={0.8}
              >
                <Text style={[s.currencyChipText, { color: active ? '#fff' : colors.foreground }]}>
                  {cur}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Category ── */}
        <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>CATEGORY</Text>
        <View style={s.catGrid}>
          {CATEGORIES.map((cat) => {
            const active = category === cat.key;
            return (
              <TouchableOpacity
                key={cat.key}
                style={[
                  s.catChip,
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
                <Text style={[s.catChipText, { color: active ? '#fff' : colors.foreground }]}>
                  {cat.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* ── Description ── */}
        <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>DESCRIPTION</Text>
        <View style={[s.inputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            style={[s.input, { color: colors.foreground }]}
            placeholder="e.g. Dinner at Nobu"
            placeholderTextColor={colors.mutedForeground}
            value={description}
            onChangeText={setDescription}
            returnKeyType="done"
            testID="description-input"
          />
        </View>

        {/* ── Date ── */}
        <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>DATE</Text>
        <View style={[s.inputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            style={[s.input, { color: colors.foreground }]}
            placeholder="YYYY-MM-DD"
            placeholderTextColor={colors.mutedForeground}
            value={date}
            onChangeText={setDate}
            returnKeyType="done"
            keyboardType="numbers-and-punctuation"
            testID="date-input"
          />
        </View>

        {/* ── Receipt photo ── */}
        <Text style={[s.sectionLabel, { color: colors.mutedForeground }]}>RECEIPT PHOTO</Text>

        {hasReceipt ? (
          <View style={[s.receiptWrap, { borderColor: colors.border }]}>
            <Image source={{ uri: previewUri! }} style={s.receiptPreview} resizeMode="cover" />

            {isUploading && (
              <View style={s.receiptOverlay}>
                <ActivityIndicator color="#fff" />
                <Text style={s.receiptOverlayText}>Uploading…</Text>
              </View>
            )}

            {!isUploading && pendingObjectPath && (
              <View style={[s.receiptBadge, { backgroundColor: '#10B981' }]}>
                <Feather name="check" size={11} color="#fff" />
                <Text style={s.receiptBadgeText}>Uploaded</Text>
              </View>
            )}

            {!isUploading && (
              <View style={s.receiptActions}>
                <TouchableOpacity
                  style={[s.receiptActionBtn, { backgroundColor: 'rgba(0,0,0,0.55)' }]}
                  onPress={handlePickReceipt}
                  hitSlop={4}
                >
                  <Feather name="refresh-cw" size={14} color="#fff" />
                  <Text style={s.receiptActionText}>Replace</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[s.receiptActionBtn, { backgroundColor: 'rgba(220,38,38,0.8)' }]}
                  onPress={handleClearReceipt}
                  hitSlop={4}
                >
                  <Feather name="trash-2" size={14} color="#fff" />
                  <Text style={s.receiptActionText}>Remove</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ) : (
          <TouchableOpacity
            style={[s.receiptBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={handlePickReceipt}
            activeOpacity={0.8}
          >
            <Feather name="camera" size={18} color={colors.primary} />
            <Text style={[s.receiptBtnText, { color: colors.primary }]}>Attach Receipt</Text>
          </TouchableOpacity>
        )}

        {/* ── Save button ── */}
        <TouchableOpacity
          style={[
            s.saveBtn,
            { backgroundColor: canSave ? colors.primary : colors.muted },
          ]}
          onPress={handleSave}
          disabled={!canSave}
          activeOpacity={0.85}
          testID="save-expense"
        >
          {isPending || isUploading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Feather
                name="check"
                size={16}
                color={canSave ? '#fff' : colors.mutedForeground}
              />
              <Text
                style={[
                  s.saveBtnText,
                  { color: canSave ? '#fff' : colors.mutedForeground },
                ]}
              >
                Save Changes
              </Text>
            </>
          )}
        </TouchableOpacity>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 8,
    alignItems: 'center',
    gap: 12,
  },
  handle: { width: 36, height: 4, borderRadius: 2 },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    alignSelf: 'stretch',
  },
  headerTitle: { fontSize: 18, fontFamily: 'Inter_700Bold' },

  // Amount area
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

  // Numpad
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

  // Currency chips
  currencyRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    gap: 8,
    marginBottom: 16,
  },
  currencyChip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
  },
  currencyChipText: { fontSize: 12, fontFamily: 'Inter_600SemiBold' },

  // Category
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

  // Description / date inputs
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

  // Receipt
  receiptWrap: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    height: 200,
  },
  receiptPreview: { width: '100%', height: '100%' },
  receiptOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  receiptOverlayText: {
    color: '#fff',
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
  receiptBadge: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 20,
  },
  receiptBadgeText: { color: '#fff', fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  receiptActions: {
    position: 'absolute',
    top: 8,
    right: 8,
    gap: 6,
  },
  receiptActionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 20,
  },
  receiptActionText: { color: '#fff', fontSize: 12, fontFamily: 'Inter_600SemiBold' },
  receiptBtn: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    paddingVertical: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  receiptBtnText: { fontSize: 14, fontFamily: 'Inter_500Medium' },

  // Save button
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 8,
    marginTop: 8,
    paddingVertical: 15,
    borderRadius: 14,
  },
  saveBtnText: { fontSize: 16, fontFamily: 'Inter_600SemiBold' },
});
