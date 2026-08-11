import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Modal, Alert, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useListCarRentals, useCreateCarRental, useDeleteCarRental, getListCarRentalsQueryKey, getGetTripTimelineQueryKey,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { FieldLabel, FormInput, formStyles } from './TripFlightsSection';

const CAR_TYPES = ['economy', 'compact', 'midsize', 'fullsize', 'suv', 'luxury', 'van', 'convertible', 'other'] as const;
type CarType = typeof CAR_TYPES[number];

const CAR_COLORS: Record<CarType, string> = {
  economy: '#38BDF8', compact: '#4ADE80', midsize: '#FBBF24', fullsize: '#94A3B8',
  suv: '#A78BFA', luxury: '#F472B6', van: '#2DD4BF', convertible: '#FB923C', other: '#A8A29E',
};

function CarRentalCard({ tripId, rental, colors, onDelete }: {
  tripId: number; rental: any; colors: ReturnType<typeof useColors>; onDelete: (id: number) => void;
}) {
  const accent = CAR_COLORS[(rental.carType as CarType) ?? 'other'];
  const pickup = rental.pickupDatetime ? new Date(rental.pickupDatetime) : null;
  const dropoff = rental.dropoffDatetime ? new Date(rental.dropoffDatetime) : null;
  const fmtDt = (d: Date | null) =>
    d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '–';

  function confirmDelete() {
    Alert.alert('Delete Car Rental', `Remove "${rental.company}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onDelete(rental.id); } },
    ]);
  }

  return (
    <View style={[cr.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={cr.header}>
        <View style={[cr.iconWrap, { backgroundColor: accent + '18' }]}>
          <Feather name="truck" size={15} color={accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[cr.company, { color: colors.foreground }]} numberOfLines={1}>{rental.company}</Text>
          <View style={[cr.typeBadge, { backgroundColor: accent + '18' }]}>
            <Text style={[cr.typeText, { color: accent }]}>{rental.carType ?? 'other'}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={confirmDelete} hitSlop={8}>
          <Feather name="trash-2" size={14} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <View style={cr.routeRow}>
        <View style={cr.locationBlock}>
          <Text style={[cr.locationLabel, { color: colors.mutedForeground }]}>Pick up</Text>
          <Text style={[cr.locationName, { color: colors.foreground }]} numberOfLines={1}>{rental.pickupLocation}</Text>
          <Text style={[cr.locationTime, { color: colors.primary }]}>{fmtDt(pickup)}</Text>
        </View>
        <Feather name="arrow-right" size={14} color={colors.mutedForeground} />
        <View style={[cr.locationBlock, { alignItems: 'flex-end' }]}>
          <Text style={[cr.locationLabel, { color: colors.mutedForeground }]}>Drop off</Text>
          <Text style={[cr.locationName, { color: colors.foreground }]} numberOfLines={1}>
            {rental.dropoffLocation || rental.pickupLocation}
          </Text>
          <Text style={[cr.locationTime, { color: colors.primary }]}>{fmtDt(dropoff)}</Text>
        </View>
      </View>

      {rental.confirmationCode ? (
        <View style={[cr.codeRow, { backgroundColor: colors.muted }]}>
          <Text style={[cr.codeText, { color: colors.mutedForeground }]}>Confirmation: {rental.confirmationCode}</Text>
        </View>
      ) : null}
    </View>
  );
}

const cr = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  company: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  typeBadge: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginTop: 2 },
  typeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', textTransform: 'capitalize' },
  routeRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  locationBlock: { flex: 1, gap: 2 },
  locationLabel: { fontSize: 10, fontFamily: 'Inter_500Medium', textTransform: 'uppercase', letterSpacing: 0.5 },
  locationName: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  locationTime: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  codeRow: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  codeText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
});

function AddCarRentalModal({ tripId, visible, onClose, colors }: {
  tripId: number; visible: boolean; onClose: () => void; colors: ReturnType<typeof useColors>;
}) {
  const queryClient = useQueryClient();
  const { mutate: createRental, isPending } = useCreateCarRental({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListCarRentalsQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetTripTimelineQueryKey(tripId) });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onClose(); reset();
      },
      onError: () => Alert.alert('Error', 'Failed to add car rental'),
    },
  });

  const [company, setCompany] = useState('');
  const [carType, setCarType] = useState<CarType>('economy');
  const [pickupLocation, setPickupLocation] = useState('');
  const [dropoffLocation, setDropoffLocation] = useState('');
  const [pickupDate, setPickupDate] = useState('');
  const [pickupTime, setPickupTime] = useState('10:00');
  const [dropoffDate, setDropoffDate] = useState('');
  const [dropoffTime, setDropoffTime] = useState('10:00');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [driverName, setDriverName] = useState('');

  function reset() {
    setCompany(''); setCarType('economy'); setPickupLocation(''); setDropoffLocation('');
    setPickupDate(''); setPickupTime('10:00'); setDropoffDate(''); setDropoffTime('10:00');
    setConfirmationCode(''); setDriverName('');
  }

  function handleSubmit() {
    if (!company.trim() || !pickupLocation.trim() || !pickupDate.trim() || !dropoffDate.trim()) {
      Alert.alert('Missing fields', 'Company, pickup location, and dates are required.');
      return;
    }
    createRental({
      tripId,
      data: {
        company: company.trim(),
        carType,
        pickupLocation: pickupLocation.trim(),
        dropoffLocation: dropoffLocation.trim() || undefined,
        pickupDatetime: new Date(`${pickupDate}T${pickupTime}`).toISOString(),
        dropoffDatetime: new Date(`${dropoffDate}T${dropoffTime}`).toISOString(),
        confirmationCode: confirmationCode.trim() || undefined,
        driverName: driverName.trim() || undefined,
      },
    });
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[formStyles.container, { backgroundColor: colors.background }]}>
          <View style={[formStyles.header, { borderBottomColor: colors.border }]}>
            <Text style={[formStyles.title, { color: colors.foreground }]}>Add Car Rental</Text>
            <TouchableOpacity onPress={() => { onClose(); reset(); }} hitSlop={8}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
            <FieldLabel label="Rental Company" colors={colors} />
            <FormInput value={company} onChangeText={setCompany} placeholder="e.g. Hertz, Sixt" colors={colors} />
            <FieldLabel label="Car Type" colors={colors} />
            <View style={formStyles.chips}>
              {CAR_TYPES.map((t) => (
                <TouchableOpacity key={t} style={[formStyles.chip, { backgroundColor: carType === t ? CAR_COLORS[t] : colors.card, borderColor: carType === t ? CAR_COLORS[t] : colors.border }]} onPress={() => setCarType(t)}>
                  <Text style={[formStyles.chipText, { color: carType === t ? '#fff' : colors.foreground }]}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <FieldLabel label="Pickup Location" colors={colors} />
            <FormInput value={pickupLocation} onChangeText={setPickupLocation} placeholder="e.g. Munich Airport" colors={colors} />
            <View style={formStyles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Pickup Date" colors={colors} />
                <FormInput value={pickupDate} onChangeText={setPickupDate} placeholder="YYYY-MM-DD" colors={colors} autoCapitalize="none" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Time" colors={colors} />
                <FormInput value={pickupTime} onChangeText={setPickupTime} placeholder="10:00" colors={colors} autoCapitalize="none" />
              </View>
            </View>
            <FieldLabel label="Drop-off Location (if different)" colors={colors} />
            <FormInput value={dropoffLocation} onChangeText={setDropoffLocation} placeholder="e.g. Frankfurt Airport" colors={colors} />
            <View style={formStyles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Drop-off Date" colors={colors} />
                <FormInput value={dropoffDate} onChangeText={setDropoffDate} placeholder="YYYY-MM-DD" colors={colors} autoCapitalize="none" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Time" colors={colors} />
                <FormInput value={dropoffTime} onChangeText={setDropoffTime} placeholder="10:00" colors={colors} autoCapitalize="none" />
              </View>
            </View>
            <FieldLabel label="Driver Name (optional)" colors={colors} />
            <FormInput value={driverName} onChangeText={setDriverName} placeholder="e.g. John Doe" colors={colors} />
            <FieldLabel label="Confirmation Code (optional)" colors={colors} />
            <FormInput value={confirmationCode} onChangeText={setConfirmationCode} placeholder="ABC123" colors={colors} autoCapitalize="characters" />
            <TouchableOpacity style={[formStyles.submit, { backgroundColor: isPending ? colors.muted : colors.primary }]} onPress={handleSubmit} disabled={isPending}>
              {isPending ? <ActivityIndicator color="#fff" /> : <Text style={formStyles.submitText}>Add Car Rental</Text>}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function TripCarRentalsSection({ tripId }: { tripId: number }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const { data: rentals, isLoading, refetch, isRefetching } = useListCarRentals(tripId, { query: { enabled: !!tripId } });
  const { mutate: deleteRental } = useDeleteCarRental({
    mutation: { onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListCarRentalsQueryKey(tripId) }); queryClient.invalidateQueries({ queryKey: getGetTripTimelineQueryKey(tripId) }); } },
  });

  if (isLoading) return <View style={crs.center}><ActivityIndicator color={colors.primary} /></View>;

  return (
    <>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={crs.list}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}>
        <TouchableOpacity style={[crs.addBtn, { backgroundColor: colors.primary }]} onPress={() => setShowAdd(true)}>
          <Feather name="plus" size={16} color="#fff" />
          <Text style={crs.addBtnText}>Add Car Rental</Text>
        </TouchableOpacity>
        {rentals && rentals.length > 0 ? rentals.map((r) => (
          <CarRentalCard key={r.id} tripId={tripId} rental={r} colors={colors} onDelete={(id) => deleteRental({ tripId, carRentalId: id })} />
        )) : (
          <View style={[crs.empty, { borderColor: colors.border }]}>
            <Feather name="truck" size={32} color={colors.mutedForeground} />
            <Text style={[crs.emptyTitle, { color: colors.foreground }]}>No car rentals yet</Text>
            <Text style={[crs.emptySub, { color: colors.mutedForeground }]}>Tap Add Car Rental to track your vehicles.</Text>
          </View>
        )}
      </ScrollView>
      <AddCarRentalModal tripId={tripId} visible={showAdd} onClose={() => setShowAdd(false)} colors={colors} />
    </>
  );
}

const crs = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 16, gap: 10, paddingBottom: 32 },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12 },
  addBtnText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  empty: { borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', paddingVertical: 48, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', marginTop: 4 },
  emptySub: { fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
