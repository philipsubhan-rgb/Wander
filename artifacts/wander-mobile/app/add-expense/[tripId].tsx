import React, { useState } from 'react';
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
  useCreateExpense,
  useListTripParticipants,
  getListExpensesQueryKey,
  getGetExpenseBalanceQueryKey,
  requestUploadUrl,
} from '@workspace/api-client-react';
import type { TripExpense } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/context/AuthContext';
import { DatePickerField } from '@/components/DatePickerField';

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
  const [date, setDate] = useState(isoToday());
  const [paidByUserId, setPaidByUserId] = useState<number | null>(user?.id ?? null);
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const [receiptObjectPath, setReceiptObjectPath] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  const { data: participants } = useListTripParticipants(tripId, {
    query: { enabled: !!tripId },
  });

  const { mutate: createExpense, isPending } = useCreateExpense({
    mutation: {
      onSuccess: (newExpense) => {
        // Immediately prepend the new expense to the cached list so the user
        // sees it as soon as they navigate back — no stale-data flicker.
        queryClient.setQueryData<TripExpense[]>(
          getListExpensesQueryKey(tripId),
          (old) => (old ? [newExpense, ...old] : [newExpense]),
        );
        queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetExpenseBalanceQueryKey(tripId) });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.back();
      },
    },
  });

  async function uploadReceipt(uri: string, fileName: string, mimeType: string): Promise<string | null> {
    setIsUploading(true);
    try {
      // Step 1: fetch the image blob first so we know the real file size
      const imageRes = await fetch(uri);
      if (!imageRes.ok) throw new Error(`Failed to read image: ${imageRes.status}`);
      const blob = await imageRes.blob();

      // Step 2: request a presigned URL with the actual file size (schema requires size >= 1)
      const { uploadURL, objectPath } = await requestUploadUrl({
        name: fileName,
        size: blob.size || 1, // blob.size is 0 only if fetch polyfill misbehaves; floor at 1
        contentType: mimeType,
      });

      // Step 3: upload the blob directly to GCS via the presigned URL
      const uploadRes = await fetch(uploadURL, {
        method: 'PUT',
        headers: { 'Content-Type': mimeType },
        body: blob,
      });
      if (!uploadRes.ok) {
        throw new Error(`GCS upload responded ${uploadRes.status}`);
      }

      return objectPath;
    } catch (err) {
      console.error('[upload] Error uploading receipt', err);
      Alert.alert(
        'Receipt upload failed',
        'Could not attach the receipt photo. You can still save the expense and try again later.',
        [{ text: 'OK' }],
      );
      return null;
    } finally {
      setIsUploading(false);
    }
  }

  async function handlePickReceipt() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (isWeb) {
      // Web: open file picker
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.7,
        allowsEditing: false,
      });
      if (!result.canceled && result.assets[0]) {
        const asset = result.assets[0];
        setReceiptUri(asset.uri);
        setReceiptObjectPath(null);
        const mimeType = asset.mimeType ?? 'image/jpeg';
        const fileName = asset.fileName ?? `receipt-${Date.now()}.jpg`;
        const objectPath = await uploadReceipt(asset.uri, fileName, mimeType);
        setReceiptObjectPath(objectPath);
      }
      return;
    }

    // Native: offer camera or library
    Alert.alert('Add Receipt', 'Choose a source', [
      {
        text: 'Camera',
        onPress: async () => {
          const perm = await ImagePicker.requestCameraPermissionsAsync();
          if (!perm.granted) {
            Alert.alert('Permission required', 'Camera access is needed to capture receipts.');
            return;
          }
          const result = await ImagePicker.launchCameraAsync({
            mediaTypes: ['images'],
            quality: 0.7,
            allowsEditing: false,
          });
          if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            setReceiptUri(asset.uri);
            setReceiptObjectPath(null);
            const mimeType = asset.mimeType ?? 'image/jpeg';
            const fileName = asset.fileName ?? `receipt-${Date.now()}.jpg`;
            const objectPath = await uploadReceipt(asset.uri, fileName, mimeType);
            setReceiptObjectPath(objectPath);
          }
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
          const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 0.7,
            allowsEditing: false,
          });
          if (!result.canceled && result.assets[0]) {
            const asset = result.assets[0];
            setReceiptUri(asset.uri);
            setReceiptObjectPath(null);
            const mimeType = asset.mimeType ?? 'image/jpeg';
            const fileName = asset.fileName ?? `receipt-${Date.now()}.jpg`;
            const objectPath = await uploadReceipt(asset.uri, fileName, mimeType);
            setReceiptObjectPath(objectPath);
          }
        },
      },
      { text: 'Cancel', style: 'cancel' },
    ]);
  }

  function handleRemoveReceipt() {
    setReceiptUri(null);
    setReceiptObjectPath(null);
  }

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
        date,
        receiptUrl: receiptObjectPath ?? undefined,
      },
    });
  }

  const canSubmit = !!(
    parseFloat(amountRaw || '0') > 0 &&
    description.trim() &&
    paidByUserId &&
    !isPending &&
    !isUploading
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

        {/* Date */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>DATE</Text>
        <DatePickerField
          value={date}
          onChange={setDate}
          colors={colors}
          testID="date-input"
        />

        {/* Receipt photo */}
        <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>RECEIPT</Text>
        {receiptUri ? (
          <View style={[styles.receiptWrap, { borderColor: colors.border }]}>
            <Image source={{ uri: receiptUri }} style={styles.receiptPreview} resizeMode="cover" />
            {isUploading && (
              <View style={styles.receiptOverlay}>
                <ActivityIndicator color="#fff" />
                <Text style={styles.receiptOverlayText}>Uploading…</Text>
              </View>
            )}
            {!isUploading && receiptObjectPath && (
              <View style={[styles.receiptBadge, { backgroundColor: '#10B981' }]}>
                <Feather name="check" size={11} color="#fff" />
                <Text style={styles.receiptBadgeText}>Uploaded</Text>
              </View>
            )}
            <TouchableOpacity style={styles.receiptRemove} onPress={handleRemoveReceipt} hitSlop={8}>
              <Feather name="x-circle" size={22} color="#fff" />
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.receiptBtn, { backgroundColor: colors.card, borderColor: colors.border }]}
            onPress={handlePickReceipt}
            activeOpacity={0.8}
          >
            <Feather name="camera" size={18} color={colors.primary} />
            <Text style={[styles.receiptBtnText, { color: colors.primary }]}>Attach Receipt</Text>
          </TouchableOpacity>
        )}

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

        {/* Payer hint */}
        {participants && participants.length > 0 && !paidByUserId && (
          <View style={[styles.hintRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="alert-circle" size={14} color={colors.mutedForeground} />
            <Text style={[styles.hintText, { color: colors.mutedForeground }]}>
              Select who paid above before saving.
            </Text>
          </View>
        )}

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
          {isPending || isUploading ? (
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
  receiptWrap: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    height: 140,
  },
  receiptPreview: {
    width: '100%',
    height: '100%',
  },
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
  receiptBadgeText: {
    color: '#fff',
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
  },
  receiptRemove: {
    position: 'absolute',
    top: 8,
    right: 8,
  },
  receiptBtn: {
    marginHorizontal: 16,
    marginBottom: 16,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    paddingVertical: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  receiptBtnText: { fontSize: 14, fontFamily: 'Inter_500Medium' },
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
  hintRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginHorizontal: 16,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  hintText: { fontSize: 13, fontFamily: 'Inter_400Regular', flex: 1 },
});
