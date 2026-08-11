import React, { useState, useEffect } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Modal, Alert, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useListAccommodations, useCreateAccommodation, useDeleteAccommodation, useUpdateAccommodation, getListAccommodationsQueryKey, getGetTripTimelineQueryKey,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { FieldLabel, FormInput, formStyles } from './TripFlightsSection';

const STAY_TYPES = ['hotel', 'airbnb', 'hostel', 'resort', 'other'] as const;
type StayType = typeof STAY_TYPES[number];

const STAY_COLORS: Record<StayType, string> = {
  hotel: '#F59E0B', airbnb: '#EC4899', hostel: '#38BDF8', resort: '#2DD4BF', other: '#94A3B8',
};

function StayCard({ tripId, stay, colors, onDelete, onEdit }: {
  tripId: number; stay: any; colors: ReturnType<typeof useColors>; onDelete: (id: number) => void; onEdit: (stay: any) => void;
}) {
  const accent = STAY_COLORS[(stay.type as StayType) ?? 'other'] ?? '#94A3B8';
  const checkIn = stay.checkIn ? new Date(stay.checkIn.substring(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '–';
  const checkOut = stay.checkOut ? new Date(stay.checkOut.substring(0, 10) + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '–';

  function confirmDelete() {
    Alert.alert('Delete Stay', `Remove "${stay.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onDelete(stay.id); } },
    ]);
  }

  return (
    <View style={[c.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={c.header}>
        <View style={[c.iconWrap, { backgroundColor: accent + '18' }]}>
          <Feather name="home" size={16} color={accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[c.name, { color: colors.foreground }]} numberOfLines={1}>{stay.name}</Text>
          <View style={[c.typeBadge, { backgroundColor: accent + '18' }]}>
            <Text style={[c.typeText, { color: accent }]}>{stay.type ?? 'hotel'}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={() => onEdit(stay)} hitSlop={8} style={{ marginRight: 6 }}>
          <Feather name="edit-2" size={14} color={colors.mutedForeground} />
        </TouchableOpacity>
        <TouchableOpacity onPress={confirmDelete} hitSlop={8}>
          <Feather name="trash-2" size={14} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <View style={c.detailRow}>
        <Feather name="map-pin" size={12} color={colors.mutedForeground} />
        <Text style={[c.detail, { color: colors.mutedForeground }]} numberOfLines={1}>{stay.address}</Text>
      </View>

      <View style={c.datesRow}>
        <View style={[c.dateChip, { backgroundColor: colors.muted }]}>
          <Feather name="log-in" size={11} color={colors.primary} />
          <Text style={[c.dateText, { color: colors.foreground }]}>Check in {checkIn}</Text>
        </View>
        <View style={[c.dateChip, { backgroundColor: colors.muted }]}>
          <Feather name="log-out" size={11} color={colors.primary} />
          <Text style={[c.dateText, { color: colors.foreground }]}>Check out {checkOut}</Text>
        </View>
      </View>

      {stay.confirmationCode ? (
        <View style={[c.codeRow, { backgroundColor: colors.muted }]}>
          <Text style={[c.codeText, { color: colors.mutedForeground }]}>Confirmation: {stay.confirmationCode}</Text>
        </View>
      ) : null}
      {stay.phone ? (
        <View style={c.detailRow}>
          <Feather name="phone" size={12} color={colors.mutedForeground} />
          <Text style={[c.detail, { color: colors.mutedForeground }]}>{stay.phone}</Text>
        </View>
      ) : null}
    </View>
  );
}

const c = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  typeBadge: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginTop: 2 },
  typeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', textTransform: 'capitalize' },
  detailRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  detail: { fontSize: 12, fontFamily: 'Inter_400Regular', flex: 1 },
  datesRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  dateChip: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 5, borderRadius: 8 },
  dateText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  codeRow: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  codeText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
});

function AddStayModal({ tripId, visible, onClose, colors }: {
  tripId: number; visible: boolean; onClose: () => void; colors: ReturnType<typeof useColors>;
}) {
  const queryClient = useQueryClient();
  const { mutate: createStay, isPending } = useCreateAccommodation({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAccommodationsQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetTripTimelineQueryKey(tripId) });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onClose(); reset();
      },
      onError: () => Alert.alert('Error', 'Failed to add stay'),
    },
  });

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<StayType>('hotel');
  const [checkInDate, setCheckInDate] = useState('');
  const [checkInTime, setCheckInTime] = useState('15:00');
  const [checkOutDate, setCheckOutDate] = useState('');
  const [checkOutTime, setCheckOutTime] = useState('11:00');
  const [confirmationCode, setConfirmationCode] = useState('');

  function reset() {
    setName(''); setAddress(''); setPhone(''); setType('hotel');
    setCheckInDate(''); setCheckInTime('15:00'); setCheckOutDate(''); setCheckOutTime('11:00');
    setConfirmationCode('');
  }

  function handleSubmit() {
    if (!name.trim() || !address.trim() || !checkInDate.trim() || !checkOutDate.trim()) {
      Alert.alert('Missing fields', 'Name, address, and dates are required.');
      return;
    }
    createStay({
      tripId,
      data: {
        name: name.trim(),
        address: address.trim(),
        phone: phone.trim() || undefined,
        type,
        checkIn: `${checkInDate}T${checkInTime}:00.000Z`,
        checkOut: `${checkOutDate}T${checkOutTime}:00.000Z`,
        confirmationCode: confirmationCode.trim() || undefined,
      },
    });
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[formStyles.container, { backgroundColor: colors.background }]}>
          <View style={[formStyles.header, { borderBottomColor: colors.border }]}>
            <Text style={[formStyles.title, { color: colors.foreground }]}>Add Stay</Text>
            <TouchableOpacity onPress={() => { onClose(); reset(); }} hitSlop={8}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
            <FieldLabel label="Property Name" colors={colors} />
            <FormInput value={name} onChangeText={setName} placeholder="e.g. Marriott Downtown" colors={colors} />
            <FieldLabel label="Address" colors={colors} />
            <FormInput value={address} onChangeText={setAddress} placeholder="e.g. 123 Main St, Tokyo" colors={colors} />
            <FieldLabel label="Phone (optional)" colors={colors} />
            <FormInput value={phone} onChangeText={setPhone} placeholder="+1 555-0100" colors={colors} autoCapitalize="none" />
            <FieldLabel label="Type" colors={colors} />
            <View style={formStyles.chips}>
              {STAY_TYPES.map((t) => (
                <TouchableOpacity key={t} style={[formStyles.chip, { backgroundColor: type === t ? STAY_COLORS[t] : colors.card, borderColor: type === t ? STAY_COLORS[t] : colors.border }]} onPress={() => setType(t)}>
                  <Text style={[formStyles.chipText, { color: type === t ? '#fff' : colors.foreground }]}>{t.charAt(0).toUpperCase() + t.slice(1)}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={formStyles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Check-in Date" colors={colors} />
                <FormInput value={checkInDate} onChangeText={setCheckInDate} placeholder="YYYY-MM-DD" colors={colors} autoCapitalize="none" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Time" colors={colors} />
                <FormInput value={checkInTime} onChangeText={setCheckInTime} placeholder="15:00" colors={colors} autoCapitalize="none" />
              </View>
            </View>
            <View style={formStyles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Check-out Date" colors={colors} />
                <FormInput value={checkOutDate} onChangeText={setCheckOutDate} placeholder="YYYY-MM-DD" colors={colors} autoCapitalize="none" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Time" colors={colors} />
                <FormInput value={checkOutTime} onChangeText={setCheckOutTime} placeholder="11:00" colors={colors} autoCapitalize="none" />
              </View>
            </View>
            <FieldLabel label="Confirmation Code (optional)" colors={colors} />
            <FormInput value={confirmationCode} onChangeText={setConfirmationCode} placeholder="ABC123" colors={colors} autoCapitalize="characters" />
            <TouchableOpacity style={[formStyles.submit, { backgroundColor: isPending ? colors.muted : colors.primary }]} onPress={handleSubmit} disabled={isPending}>
              {isPending ? <ActivityIndicator color="#fff" /> : <Text style={formStyles.submitText}>Add Stay</Text>}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function EditStayModal({ tripId, item, visible, onClose, colors }: {
  tripId: number; item: any; visible: boolean; onClose: () => void; colors: ReturnType<typeof useColors>;
}) {
  const queryClient = useQueryClient();
  const { mutate: updateStay, isPending } = useUpdateAccommodation({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListAccommodationsQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetTripTimelineQueryKey(tripId) });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onClose();
      },
      onError: () => Alert.alert('Error', 'Failed to update stay'),
    },
  });

  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [phone, setPhone] = useState('');
  const [type, setType] = useState<StayType>('hotel');
  const [checkInDate, setCheckInDate] = useState('');
  const [checkInTime, setCheckInTime] = useState('15:00');
  const [checkOutDate, setCheckOutDate] = useState('');
  const [checkOutTime, setCheckOutTime] = useState('11:00');
  const [confirmationCode, setConfirmationCode] = useState('');

  useEffect(() => {
    if (item) {
      setName(item.name ?? '');
      setAddress(item.address ?? '');
      setPhone(item.phone ?? '');
      setType((item.type as StayType) ?? 'hotel');
      setCheckInDate(item.checkIn ? item.checkIn.slice(0, 10) : '');
      setCheckInTime(item.checkIn ? item.checkIn.slice(11, 16) : '15:00');
      setCheckOutDate(item.checkOut ? item.checkOut.slice(0, 10) : '');
      setCheckOutTime(item.checkOut ? item.checkOut.slice(11, 16) : '11:00');
      setConfirmationCode(item.confirmationCode ?? '');
    }
  }, [item]);

  function reset() {
    setName(''); setAddress(''); setPhone(''); setType('hotel');
    setCheckInDate(''); setCheckInTime('15:00'); setCheckOutDate(''); setCheckOutTime('11:00');
    setConfirmationCode('');
  }

  function handleSubmit() {
    if (!name.trim() || !address.trim() || !checkInDate.trim() || !checkOutDate.trim()) {
      Alert.alert('Missing fields', 'Name, address, and dates are required.');
      return;
    }
    updateStay({
      tripId,
      accommodationId: item.id,
      data: {
        name: name.trim(),
        address: address.trim(),
        phone: phone.trim() || undefined,
        type,
        checkIn: `${checkInDate}T${checkInTime}:00.000Z`,
        checkOut: `${checkOutDate}T${checkOutTime}:00.000Z`,
        confirmationCode: confirmationCode.trim() || undefined,
      },
    });
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => { onClose(); reset(); }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[formStyles.container, { backgroundColor: colors.background }]}>
          <View style={[formStyles.header, { borderBottomColor: colors.border }]}>
            <Text style={[formStyles.title, { color: colors.foreground }]}>Edit Stay</Text>
            <TouchableOpacity onPress={() => { onClose(); reset(); }} hitSlop={8}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
            <FieldLabel label="Property Name" colors={colors} />
            <FormInput value={name} onChangeText={setName} placeholder="e.g. Marriott Downtown" colors={colors} />
            <FieldLabel label="Address" colors={colors} />
            <FormInput value={address} onChangeText={setAddress} placeholder="e.g. 123 Main St, Tokyo" colors={colors} />
            <FieldLabel label="Phone (optional)" colors={colors} />
            <FormInput value={phone} onChangeText={setPhone} placeholder="+1 555-0100" colors={colors} autoCapitalize="none" />
            <FieldLabel label="Type" colors={colors} />
            <View style={formStyles.chips}>
              {STAY_TYPES.map((t) => (
                <TouchableOpacity key={t} style={[formStyles.chip, { backgroundColor: type === t ? STAY_COLORS[t] : colors.card, borderColor: type === t ? STAY_COLORS[t] : colors.border }]} onPress={() => setType(t)}>
                  <Text style={[formStyles.chipText, { color: type === t ? '#fff' : colors.foreground }]}>{t.charAt(0).toUpperCase() + t.slice(1)}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={formStyles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Check-in Date" colors={colors} />
                <FormInput value={checkInDate} onChangeText={setCheckInDate} placeholder="YYYY-MM-DD" colors={colors} autoCapitalize="none" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Time" colors={colors} />
                <FormInput value={checkInTime} onChangeText={setCheckInTime} placeholder="15:00" colors={colors} autoCapitalize="none" />
              </View>
            </View>
            <View style={formStyles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Check-out Date" colors={colors} />
                <FormInput value={checkOutDate} onChangeText={setCheckOutDate} placeholder="YYYY-MM-DD" colors={colors} autoCapitalize="none" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Time" colors={colors} />
                <FormInput value={checkOutTime} onChangeText={setCheckOutTime} placeholder="11:00" colors={colors} autoCapitalize="none" />
              </View>
            </View>
            <FieldLabel label="Confirmation Code (optional)" colors={colors} />
            <FormInput value={confirmationCode} onChangeText={setConfirmationCode} placeholder="ABC123" colors={colors} autoCapitalize="characters" />
            <TouchableOpacity style={[formStyles.submit, { backgroundColor: isPending ? colors.muted : colors.primary }]} onPress={handleSubmit} disabled={isPending}>
              {isPending ? <ActivityIndicator color="#fff" /> : <Text style={formStyles.submitText}>Save Changes</Text>}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function TripStaysSection({ tripId }: { tripId: number }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [editingItem, setEditingItem] = useState<any>(null);

  const { data: stays, isLoading, isError, refetch, isRefetching } = useListAccommodations(tripId, { query: { enabled: !!tripId } });
  const { mutate: deleteStay } = useDeleteAccommodation({
    mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListAccommodationsQueryKey(tripId) }); queryClient.invalidateQueries({ queryKey: getGetTripTimelineQueryKey(tripId) }); } },
  });

  if (isLoading) return <View style={ss.center}><ActivityIndicator color={colors.primary} /></View>;
  if (isError) return (
    <View style={ss.center}>
      <Feather name="alert-circle" size={28} color={colors.mutedForeground} />
      <TouchableOpacity onPress={() => refetch()} style={[ss.retryBtn, { backgroundColor: colors.primary }]}>
        <Text style={ss.retryText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={ss.list}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}>
        <TouchableOpacity style={[ss.addBtn, { backgroundColor: colors.primary }]} onPress={() => setShowAdd(true)}>
          <Feather name="plus" size={16} color="#fff" />
          <Text style={ss.addBtnText}>Add Stay</Text>
        </TouchableOpacity>
        {stays && stays.length > 0 ? stays.map((s) => (
          <StayCard key={s.id} tripId={tripId} stay={s} colors={colors} onDelete={(id) => deleteStay({ tripId, accommodationId: id })} onEdit={setEditingItem} />
        )) : (
          <View style={[ss.empty, { borderColor: colors.border }]}>
            <Feather name="home" size={32} color={colors.mutedForeground} />
            <Text style={[ss.emptyTitle, { color: colors.foreground }]}>No places to stay</Text>
            <Text style={[ss.emptySub, { color: colors.mutedForeground }]}>Tap Add Stay to log your first accommodation.</Text>
          </View>
        )}
      </ScrollView>
      <AddStayModal tripId={tripId} visible={showAdd} onClose={() => setShowAdd(false)} colors={colors} />
      <EditStayModal tripId={tripId} item={editingItem} visible={!!editingItem} onClose={() => setEditingItem(null)} colors={colors} />
    </>
  );
}

const ss = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  list: { padding: 16, gap: 10, paddingBottom: 32 },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12 },
  addBtnText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  empty: { borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', paddingVertical: 48, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', marginTop: 4 },
  emptySub: { fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center' },
  retryBtn: { paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20 },
  retryText: { color: '#fff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
});
