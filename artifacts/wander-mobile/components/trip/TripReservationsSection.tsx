import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Modal, Alert, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useListReservations, useCreateReservation, useDeleteReservation, getListReservationsQueryKey,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { FieldLabel, FormInput, formStyles } from './TripFlightsSection';

const RES_TYPES = ['restaurant', 'attraction', 'tour', 'transport', 'event', 'spa', 'other'] as const;
type ResType = typeof RES_TYPES[number];

const RES_META: Record<ResType, { icon: keyof typeof Feather.glyphMap; color: string; label: string }> = {
  restaurant: { icon: 'coffee', color: '#F43F5E', label: 'Restaurant' },
  attraction: { icon: 'map-pin', color: '#3B82F6', label: 'Attraction' },
  tour: { icon: 'map', color: '#10B981', label: 'Tour' },
  transport: { icon: 'truck', color: '#64748B', label: 'Transport' },
  event: { icon: 'star', color: '#8B5CF6', label: 'Event' },
  spa: { icon: 'sun', color: '#14B8A6', label: 'Spa' },
  other: { icon: 'bookmark', color: '#A8A29E', label: 'Other' },
};

function ReservationCard({ tripId, res, colors, onDelete }: {
  tripId: number; res: any; colors: ReturnType<typeof useColors>; onDelete: (id: number) => void;
}) {
  const meta = RES_META[(res.type as ResType) ?? 'other'];
  const date = res.date ? new Date(res.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '–';
  const timeFmt = (t: string | null) => {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };
  const timeStr = res.time ? (res.endTime ? `${timeFmt(res.time)} – ${timeFmt(res.endTime)}` : timeFmt(res.time)) : null;

  function confirmDelete() {
    Alert.alert('Delete Reservation', `Remove "${res.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onDelete(res.id); } },
    ]);
  }

  return (
    <View style={[rv.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={rv.header}>
        <View style={[rv.iconWrap, { backgroundColor: meta.color + '18' }]}>
          <Feather name={meta.icon} size={15} color={meta.color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[rv.title, { color: colors.foreground }]} numberOfLines={1}>{res.title}</Text>
          <View style={[rv.typeBadge, { backgroundColor: meta.color + '18' }]}>
            <Text style={[rv.typeText, { color: meta.color }]}>{meta.label}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={confirmDelete} hitSlop={8}>
          <Feather name="trash-2" size={14} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <View style={rv.row}>
        <Feather name="calendar" size={12} color={colors.primary} />
        <Text style={[rv.detail, { color: colors.foreground }]}>{date}</Text>
        {timeStr ? (
          <>
            <Text style={{ color: colors.mutedForeground }}>·</Text>
            <Feather name="clock" size={12} color={colors.primary} />
            <Text style={[rv.detail, { color: colors.foreground }]}>{timeStr}</Text>
          </>
        ) : null}
      </View>

      {res.venue && res.venue !== res.title ? (
        <View style={rv.row}>
          <Feather name="map-pin" size={12} color={colors.mutedForeground} />
          <Text style={[rv.detail, { color: colors.mutedForeground }]} numberOfLines={1}>{res.venue}</Text>
        </View>
      ) : null}

      {res.address ? (
        <View style={rv.row}>
          <Feather name="navigation" size={12} color={colors.mutedForeground} />
          <Text style={[rv.detail, { color: colors.mutedForeground }]} numberOfLines={1}>{res.address}</Text>
        </View>
      ) : null}

      {res.confirmationCode ? (
        <View style={[rv.codeRow, { backgroundColor: colors.muted }]}>
          <Text style={[rv.codeText, { color: colors.mutedForeground }]}>Confirmation: {res.confirmationCode}</Text>
        </View>
      ) : null}

      {res.numberOfPeople ? (
        <View style={rv.row}>
          <Feather name="users" size={12} color={colors.mutedForeground} />
          <Text style={[rv.detail, { color: colors.mutedForeground }]}>{res.numberOfPeople} people</Text>
        </View>
      ) : null}

      {res.notes ? (
        <Text style={[rv.notes, { color: colors.mutedForeground }]} numberOfLines={2}>{res.notes}</Text>
      ) : null}
    </View>
  );
}

const rv = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  typeBadge: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginTop: 2 },
  typeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  detail: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  codeRow: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  codeText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  notes: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18 },
});

function AddReservationModal({ tripId, visible, onClose, colors }: {
  tripId: number; visible: boolean; onClose: () => void; colors: ReturnType<typeof useColors>;
}) {
  const queryClient = useQueryClient();
  const { mutate: createRes, isPending } = useCreateReservation({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListReservationsQueryKey(tripId) });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onClose(); reset();
      },
      onError: () => Alert.alert('Error', 'Failed to add reservation'),
    },
  });

  const [type, setType] = useState<ResType>('restaurant');
  const [title, setTitle] = useState('');
  const [venue, setVenue] = useState('');
  const [address, setAddress] = useState('');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [numberOfPeople, setNumberOfPeople] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');

  function reset() {
    setType('restaurant'); setTitle(''); setVenue(''); setAddress('');
    setDate(''); setTime(''); setEndTime(''); setConfirmationCode('');
    setNumberOfPeople(''); setPhone(''); setNotes('');
  }

  function handleSubmit() {
    if (!title.trim() || !date.trim()) {
      Alert.alert('Missing fields', 'Title and date are required.');
      return;
    }
    const people = numberOfPeople ? parseInt(numberOfPeople, 10) : undefined;
    createRes({
      tripId,
      data: {
        type,
        title: title.trim(),
        venue: venue.trim() || undefined,
        address: address.trim() || undefined,
        date: date.trim(),
        time: time.trim() || undefined,
        endTime: endTime.trim() || undefined,
        confirmationCode: confirmationCode.trim() || undefined,
        numberOfPeople: people && !isNaN(people) ? people : undefined,
        phone: phone.trim() || undefined,
        notes: notes.trim() || undefined,
      },
    });
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[formStyles.container, { backgroundColor: colors.background }]}>
          <View style={[formStyles.header, { borderBottomColor: colors.border }]}>
            <Text style={[formStyles.title, { color: colors.foreground }]}>Add Booking</Text>
            <TouchableOpacity onPress={() => { onClose(); reset(); }} hitSlop={8}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
            <FieldLabel label="Type" colors={colors} />
            <View style={formStyles.chips}>
              {RES_TYPES.map((t) => {
                const m = RES_META[t];
                return (
                  <TouchableOpacity key={t} style={[formStyles.chip, { backgroundColor: type === t ? m.color : colors.card, borderColor: type === t ? m.color : colors.border }]} onPress={() => setType(t)}>
                    <Text style={[formStyles.chipText, { color: type === t ? '#fff' : colors.foreground }]}>{m.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            <FieldLabel label="Title" colors={colors} />
            <FormInput value={title} onChangeText={setTitle} placeholder="e.g. Dinner at Nobu" colors={colors} />
            <FieldLabel label="Venue (optional)" colors={colors} />
            <FormInput value={venue} onChangeText={setVenue} placeholder="e.g. Nobu Tokyo" colors={colors} />
            <FieldLabel label="Address (optional)" colors={colors} />
            <FormInput value={address} onChangeText={setAddress} placeholder="e.g. 1-1-1 Minato, Tokyo" colors={colors} />
            <View style={formStyles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Date (YYYY-MM-DD)" colors={colors} />
                <FormInput value={date} onChangeText={setDate} placeholder="2025-07-15" colors={colors} autoCapitalize="none" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Time (optional)" colors={colors} />
                <FormInput value={time} onChangeText={setTime} placeholder="19:30" colors={colors} autoCapitalize="none" />
              </View>
            </View>
            <FieldLabel label="End Time (optional)" colors={colors} />
            <FormInput value={endTime} onChangeText={setEndTime} placeholder="21:00" colors={colors} autoCapitalize="none" />
            <View style={formStyles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Confirmation Code" colors={colors} />
                <FormInput value={confirmationCode} onChangeText={setConfirmationCode} placeholder="ABC123" colors={colors} autoCapitalize="characters" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel label="# of People" colors={colors} />
                <FormInput value={numberOfPeople} onChangeText={setNumberOfPeople} placeholder="2" colors={colors} autoCapitalize="none" />
              </View>
            </View>
            <FieldLabel label="Phone (optional)" colors={colors} />
            <FormInput value={phone} onChangeText={setPhone} placeholder="+1 555-0100" colors={colors} autoCapitalize="none" />
            <FieldLabel label="Notes (optional)" colors={colors} />
            <FormInput value={notes} onChangeText={setNotes} placeholder="Any special requests or notes…" colors={colors} multiline />
            <TouchableOpacity style={[formStyles.submit, { backgroundColor: isPending ? colors.muted : colors.primary }]} onPress={handleSubmit} disabled={isPending}>
              {isPending ? <ActivityIndicator color="#fff" /> : <Text style={formStyles.submitText}>Add Booking</Text>}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function TripReservationsSection({ tripId }: { tripId: number }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const { data: reservations, isLoading, refetch, isRefetching } = useListReservations(tripId, { query: { enabled: !!tripId } });
  const { mutate: deleteRes } = useDeleteReservation({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListReservationsQueryKey(tripId) }) },
  });

  if (isLoading) return <View style={rvs.center}><ActivityIndicator color={colors.primary} /></View>;

  const sorted = reservations ? [...reservations].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()) : [];

  return (
    <>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={rvs.list}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}>
        <TouchableOpacity style={[rvs.addBtn, { backgroundColor: colors.primary }]} onPress={() => setShowAdd(true)}>
          <Feather name="plus" size={16} color="#fff" />
          <Text style={rvs.addBtnText}>Add Booking</Text>
        </TouchableOpacity>
        {sorted.length > 0 ? sorted.map((r) => (
          <ReservationCard key={r.id} tripId={tripId} res={r} colors={colors} onDelete={(id) => deleteRes({ tripId, reservationId: id })} />
        )) : (
          <View style={[rvs.empty, { borderColor: colors.border }]}>
            <Feather name="bookmark" size={32} color={colors.mutedForeground} />
            <Text style={[rvs.emptyTitle, { color: colors.foreground }]}>No bookings yet</Text>
            <Text style={[rvs.emptySub, { color: colors.mutedForeground }]}>Tap Add Booking for restaurants, tours, and events.</Text>
          </View>
        )}
      </ScrollView>
      <AddReservationModal tripId={tripId} visible={showAdd} onClose={() => setShowAdd(false)} colors={colors} />
    </>
  );
}

const rvs = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 16, gap: 10, paddingBottom: 32 },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12 },
  addBtnText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  empty: { borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', paddingVertical: 48, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', marginTop: 4 },
  emptySub: { fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
