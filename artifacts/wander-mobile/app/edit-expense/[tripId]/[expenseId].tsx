import React, { useState } from 'react';
import {
  View,
  Text,
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

const CAT_COLORS: Record<Category, string> = {
  travel: '#2F7CE0', activity: '#10B981', restaurant: '#F59E0B',
  car_rental: '#8B5CF6', accommodation: '#EC4899', other: '#6B7FA3',
};
const CAT_ICONS: Record<Category, keyof typeof Feather.glyphMap> = {
  travel: 'navigation', activity: 'zap', restaurant: 'coffee',
  car_rental: 'truck', accommodation: 'home', other: 'tag',
};

/** Convert a stored objectPath to a full serving URL (same logic as TripExpensesSection). */
function receiptImageUrl(objectPath: string): string {
  const base = getBaseUrl();
  const withoutPrefix = objectPath.replace(/^\/objects\//, '');
  return `${base}/api/storage/objects/${withoutPrefix}`;
}

export default function EditExpenseReceiptScreen() {
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

  // Receipt state
  // - receiptUri: local preview URI (null = no preview / use existing)
  // - pendingObjectPath: freshly uploaded objectPath (null = not yet uploaded)
  // - removeReceipt: user explicitly wants to clear it
  const [receiptUri, setReceiptUri] = useState<string | null>(null);
  const [pendingObjectPath, setPendingObjectPath] = useState<string | null>(null);
  const [removeReceipt, setRemoveReceipt] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

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

  function handleSave() {
    if (!expense) return;

    // Determine the new receiptUrl value:
    // - If a new photo was uploaded → use pendingObjectPath
    // - If user removed → send null (empty string clears it on the server)
    // - Otherwise → no-op (don't send receiptUrl at all, keep existing)
    const hasNewPhoto = pendingObjectPath !== null;
    const hasClearIntent = removeReceipt;

    if (!hasNewPhoto && !hasClearIntent) {
      // Nothing changed — just go back
      router.back();
      return;
    }

    updateExpense({
      tripId,
      expenseId,
      data: {
        receiptUrl: hasNewPhoto ? pendingObjectPath! : null,
      },
    });
  }

  // Determine what to show in the receipt area
  const existingReceiptUrl = expense?.receiptUrl ? receiptImageUrl(expense.receiptUrl) : null;
  const previewUri = receiptUri ?? (removeReceipt ? null : existingReceiptUrl);
  const hasReceipt = previewUri !== null;

  const isDirty = pendingObjectPath !== null || removeReceipt;
  const canSave = !isPending && !isUploading;

  if (isLoading || !expense) {
    return (
      <View style={[s.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  const color = CAT_COLORS[(expense.category as Category)] ?? '#6B7FA3';
  const icon = CAT_ICONS[(expense.category as Category)] ?? 'tag';
  const amount = parseFloat(expense.amount);

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
          <Text style={[s.headerTitle, { color: colors.foreground }]}>Edit Receipt</Text>
          <TouchableOpacity onPress={() => router.back()} hitSlop={8}>
            <Feather name="x" size={22} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
        {/* Expense summary card */}
        <View style={[s.summaryCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[s.catIcon, { backgroundColor: color + '18' }]}>
            <Feather name={icon} size={18} color={color} />
          </View>
          <View style={s.summaryBody}>
            <Text style={[s.summaryDesc, { color: colors.foreground }]} numberOfLines={1}>
              {expense.description}
            </Text>
            <Text style={[s.summaryMeta, { color: colors.mutedForeground }]}>
              {expense.currency} {amount.toFixed(2)} · {expense.payerName ?? 'Unknown'}
            </Text>
          </View>
        </View>

        {/* Receipt section */}
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

        {/* Save button */}
        <TouchableOpacity
          style={[
            s.saveBtn,
            { backgroundColor: isDirty && canSave ? colors.primary : colors.muted },
          ]}
          onPress={handleSave}
          disabled={!canSave}
          activeOpacity={0.85}
          testID="save-receipt"
        >
          {isPending || isUploading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <>
              <Feather
                name="check"
                size={16}
                color={isDirty && canSave ? '#fff' : colors.mutedForeground}
              />
              <Text
                style={[
                  s.saveBtnText,
                  { color: isDirty && canSave ? '#fff' : colors.mutedForeground },
                ]}
              >
                {isDirty ? 'Save Changes' : 'No Changes'}
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

  summaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 20,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 14,
  },
  catIcon: {
    width: 42,
    height: 42,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summaryBody: { flex: 1, gap: 3 },
  summaryDesc: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  summaryMeta: { fontSize: 13, fontFamily: 'Inter_400Regular' },

  sectionLabel: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    paddingHorizontal: 20,
    marginBottom: 8,
  },

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
