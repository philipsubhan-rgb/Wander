import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, Alert, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import {
  useGetTrip,
  useUpdateTrip,
  useDeleteTrip,
  getGetTripQueryKey,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

// ── Sub-components ────────────────────────────────────────────────────────────

function FieldLabel({ label, colors }: { label: string; colors: ReturnType<typeof useColors> }) {
  return (
    <Text style={[fieldStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
  );
}

function FormInput({
  value,
  onChangeText,
  placeholder,
  colors,
  keyboardType,
  autoCapitalize,
}: {
  value: string;
  onChangeText: (v: string) => void;
  placeholder?: string;
  colors: ReturnType<typeof useColors>;
  keyboardType?: 'default' | 'email-address' | 'url';
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
}) {
  return (
    <TextInput
      style={[
        fieldStyles.input,
        { backgroundColor: colors.muted, borderColor: colors.border, color: colors.foreground },
      ]}
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.mutedForeground}
      keyboardType={keyboardType ?? 'default'}
      autoCapitalize={autoCapitalize ?? 'sentences'}
    />
  );
}

const fieldStyles = StyleSheet.create({
  label: {
    fontSize: 12,
    fontFamily: 'Inter_500Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 6,
  },
  input: {
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
  },
});

// ── Status chips ──────────────────────────────────────────────────────────────

type TripStatus = 'planning' | 'active' | 'completed';
const STATUS_OPTIONS: TripStatus[] = ['planning', 'active', 'completed'];

function StatusChips({
  value,
  onChange,
  colors,
}: {
  value: TripStatus;
  onChange: (s: TripStatus) => void;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={chipStyles.row}>
      {STATUS_OPTIONS.map(s => {
        const active = value === s;
        return (
          <TouchableOpacity
            key={s}
            style={[
              chipStyles.chip,
              { borderColor: active ? colors.primary : colors.border },
              active && { backgroundColor: colors.primary + '18' },
            ]}
            onPress={() => onChange(s)}
            activeOpacity={0.7}
          >
            <Text
              style={[
                chipStyles.chipText,
                { color: active ? colors.primary : colors.mutedForeground },
                active && { fontFamily: 'Inter_600SemiBold' },
              ]}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const chipStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1.5,
  },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
});

// ── Main Section ──────────────────────────────────────────────────────────────

export function TripSettingsSection({ tripId }: { tripId: number }) {
  const colors = useColors();
  const queryClient = useQueryClient();

  const { data: trip, isLoading } = useGetTrip(tripId, { query: { enabled: !!tripId } });
  const { mutate: updateTrip, isPending: isSaving } = useUpdateTrip();
  const { mutate: deleteTrip, isPending: isDeleting } = useDeleteTrip();

  const isAdmin = !!(trip as any)?.isTripAdmin;

  // Form state
  const [title, setTitle] = useState('');
  const [destination, setDestination] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [coverImageUrl, setCoverImageUrl] = useState('');
  const [status, setStatus] = useState<TripStatus>('planning');

  // Populate form when trip loads
  useEffect(() => {
    if (!trip) return;
    setTitle((trip as any).title ?? '');
    setDestination((trip as any).destination ?? '');
    setStartDate((trip as any).startDate ?? '');
    setEndDate((trip as any).endDate ?? '');
    setCoverImageUrl((trip as any).coverImageUrl ?? '');
    const s = (trip as any).status;
    if (s === 'active' || s === 'completed') {
      setStatus(s);
    } else {
      setStatus('planning');
    }
  }, [trip]);

  function handleSave() {
    updateTrip(
      {
        tripId,
        data: {
          title,
          destination,
          startDate,
          endDate,
          coverImage: coverImageUrl || undefined,
          status,
        },
      },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetTripQueryKey(tripId) });
          Alert.alert('Trip updated');
        },
        onError: () => {
          Alert.alert('Error', 'Failed to update trip');
        },
      },
    );
  }

  function handleDelete() {
    Alert.alert(
      'Delete Trip',
      'Are you sure you want to delete this trip? This action cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            deleteTrip(
              { tripId },
              {
                onSuccess: () => {
                  router.push('/(tabs)');
                },
                onError: () => {
                  Alert.alert('Error', 'Failed to delete trip');
                },
              },
            );
          },
        },
      ],
    );
  }

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!isAdmin) {
    return (
      <View style={styles.center}>
        <Feather name="lock" size={32} color={colors.mutedForeground} />
        <Text style={[styles.permissionText, { color: colors.mutedForeground }]}>
          You don't have permission to edit trip settings.
        </Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
      >
        {/* Settings card */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>TRIP DETAILS</Text>

          <View style={styles.field}>
            <FieldLabel label="Title" colors={colors} />
            <FormInput
              value={title}
              onChangeText={setTitle}
              placeholder="Trip title"
              colors={colors}
              autoCapitalize="words"
            />
          </View>

          <View style={styles.field}>
            <FieldLabel label="Destination" colors={colors} />
            <FormInput
              value={destination}
              onChangeText={setDestination}
              placeholder="e.g. Paris, France"
              colors={colors}
              autoCapitalize="words"
            />
          </View>

          <View style={styles.row}>
            <View style={[styles.field, { flex: 1 }]}>
              <FieldLabel label="Start Date" colors={colors} />
              <FormInput
                value={startDate}
                onChangeText={setStartDate}
                placeholder="YYYY-MM-DD"
                colors={colors}
                autoCapitalize="none"
              />
            </View>
            <View style={[styles.field, { flex: 1 }]}>
              <FieldLabel label="End Date" colors={colors} />
              <FormInput
                value={endDate}
                onChangeText={setEndDate}
                placeholder="YYYY-MM-DD"
                colors={colors}
                autoCapitalize="none"
              />
            </View>
          </View>

          <View style={styles.field}>
            <FieldLabel label="Cover Image URL (optional)" colors={colors} />
            <FormInput
              value={coverImageUrl}
              onChangeText={setCoverImageUrl}
              placeholder="https://..."
              colors={colors}
              keyboardType="url"
              autoCapitalize="none"
            />
          </View>

          <View style={styles.field}>
            <FieldLabel label="Status" colors={colors} />
            <StatusChips value={status} onChange={setStatus} colors={colors} />
          </View>

          <TouchableOpacity
            style={[
              styles.saveBtn,
              { backgroundColor: colors.primary },
              isSaving && { opacity: 0.7 },
            ]}
            onPress={handleSave}
            disabled={isSaving}
            activeOpacity={0.8}
          >
            {isSaving ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Feather name="save" size={15} color="#fff" />
                <Text style={styles.saveBtnText}>Save Changes</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* Danger zone */}
        <View style={[styles.card, styles.dangerCard, { borderColor: '#EF444440' }]}>
          <View style={styles.dangerHeader}>
            <Feather name="alert-triangle" size={16} color="#EF4444" />
            <Text style={[styles.sectionTitle, { color: '#EF4444', marginBottom: 0 }]}>DANGER ZONE</Text>
          </View>
          <Text style={[styles.dangerDesc, { color: colors.mutedForeground }]}>
            Deleting a trip is permanent and cannot be undone. All associated data will be removed.
          </Text>
          <TouchableOpacity
            style={[styles.deleteBtn, isDeleting && { opacity: 0.7 }]}
            onPress={handleDelete}
            disabled={isDeleting}
            activeOpacity={0.8}
          >
            {isDeleting ? (
              <ActivityIndicator color="#fff" size="small" />
            ) : (
              <>
                <Feather name="trash-2" size={15} color="#fff" />
                <Text style={styles.deleteBtnText}>Delete Trip</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  permissionText: {
    fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center', lineHeight: 20,
  },
  container: { padding: 16, gap: 16, paddingBottom: 40 },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 14,
  },
  dangerCard: {
    borderColor: '#EF444440',
    backgroundColor: '#EF444408',
  },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    marginBottom: -4,
  },
  field: { gap: 6 },
  row: { flexDirection: 'row', gap: 10 },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 10,
    marginTop: 4,
  },
  saveBtnText: { color: '#fff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  dangerHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dangerDesc: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18 },
  deleteBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    borderRadius: 10,
    backgroundColor: '#EF4444',
    marginTop: 4,
  },
  deleteBtnText: { color: '#fff', fontSize: 14, fontFamily: 'Inter_600SemiBold' },
});
