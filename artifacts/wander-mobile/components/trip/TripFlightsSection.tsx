import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Modal, TextInput, Alert, RefreshControl, KeyboardAvoidingView, Platform, Image,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useListFlights, useCreateFlight, useDeleteFlight, getListFlightsQueryKey, getGetTripTimelineQueryKey,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

const DIRECTIONS = ['outbound', 'return', 'connecting'] as const;
type Direction = typeof DIRECTIONS[number];

function AirlineLogo({ code }: { code: string }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <View style={[cardStyles.iconWrap, { backgroundColor: '#2F7CE018' }]}>
        <Feather name="navigation" size={16} color="#2F7CE0" />
      </View>
    );
  }
  return (
    <View style={cardStyles.logoWrap}>
      <Image
        source={{ uri: `https://pics.avs.io/200/80/${code}.png` }}
        style={cardStyles.logoImg}
        resizeMode="contain"
        onError={() => setErr(true)}
      />
    </View>
  );
}

function FlightCard({ tripId, flight, colors, onDelete }: {
  tripId: number; flight: any; colors: ReturnType<typeof useColors>; onDelete: (id: number) => void;
}) {
  const dep = flight.departureDatetime ? new Date(flight.departureDatetime) : null;
  const arr = flight.arrivalDatetime ? new Date(flight.arrivalDatetime) : null;
  const carrierCode = (flight.flightNumber ?? '').toUpperCase().match(/^([A-Z0-9]{2,3})\s*\d/)?.[1] ?? null;

  const fmt = (d: Date | null) =>
    d ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }) : '–';
  const fmtDate = (d: Date | null) =>
    d ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

  function confirmDelete() {
    Alert.alert('Delete Flight', `Remove flight ${flight.flightNumber}?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onDelete(flight.id); } },
    ]);
  }

  const dirColor: Record<string, string> = { outbound: '#2F7CE0', return: '#10B981', connecting: '#F59E0B' };
  const dir = flight.direction ?? 'outbound';

  return (
    <View style={[cardStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={cardStyles.header}>
        {carrierCode ? (
          <AirlineLogo code={carrierCode} />
        ) : (
          <View style={[cardStyles.iconWrap, { backgroundColor: '#2F7CE018' }]}>
            <Feather name="navigation" size={16} color="#2F7CE0" />
          </View>
        )}
        <View style={{ flex: 1 }}>
          <Text style={[cardStyles.airline, { color: colors.foreground }]}>{flight.airline}</Text>
          <Text style={[cardStyles.sub, { color: colors.mutedForeground }]}>{flight.flightNumber}</Text>
        </View>
        <View style={[cardStyles.dirBadge, { backgroundColor: (dirColor[dir] ?? '#6B7FA3') + '20' }]}>
          <Text style={[cardStyles.dirText, { color: dirColor[dir] ?? '#6B7FA3' }]}>{dir}</Text>
        </View>
        <TouchableOpacity onPress={confirmDelete} hitSlop={8}>
          <Feather name="trash-2" size={14} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <View style={cardStyles.route}>
        <View style={cardStyles.airport}>
          <Text style={[cardStyles.iata, { color: colors.foreground }]}>{flight.departureAirport}</Text>
          <Text style={[cardStyles.time, { color: colors.primary }]}>{fmt(dep)}</Text>
          <Text style={[cardStyles.dateStr, { color: colors.mutedForeground }]}>{fmtDate(dep)}</Text>
        </View>
        <Feather name="arrow-right" size={16} color={colors.mutedForeground} />
        <View style={[cardStyles.airport, { alignItems: 'flex-end' }]}>
          <Text style={[cardStyles.iata, { color: colors.foreground }]}>{flight.arrivalAirport}</Text>
          <Text style={[cardStyles.time, { color: colors.primary }]}>{fmt(arr)}</Text>
          <Text style={[cardStyles.dateStr, { color: colors.mutedForeground }]}>{fmtDate(arr)}</Text>
        </View>
      </View>

      {flight.confirmationCode ? (
        <View style={[cardStyles.codeRow, { backgroundColor: colors.muted }]}>
          <Text style={[cardStyles.codeText, { color: colors.mutedForeground }]}>
            Confirmation: {flight.confirmationCode}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const cardStyles = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 12 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  logoWrap: { width: 64, height: 36, borderRadius: 8, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  logoImg:  { width: 56, height: 28 },
  airline: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  sub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  dirBadge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  dirText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', textTransform: 'capitalize' },
  route: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  airport: { gap: 2 },
  iata: { fontSize: 22, fontFamily: 'Inter_700Bold', letterSpacing: 1 },
  time: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  dateStr: { fontSize: 11, fontFamily: 'Inter_400Regular' },
  codeRow: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8 },
  codeText: { fontSize: 12, fontFamily: 'Inter_500Medium' },
});

function AddFlightModal({ tripId, visible, onClose, colors }: {
  tripId: number; visible: boolean; onClose: () => void; colors: ReturnType<typeof useColors>;
}) {
  const queryClient = useQueryClient();
  const { mutate: createFlight, isPending } = useCreateFlight({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListFlightsQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetTripTimelineQueryKey(tripId) });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onClose();
        reset();
      },
      onError: () => Alert.alert('Error', 'Failed to add flight'),
    },
  });

  const [airline, setAirline] = useState('');
  const [flightNumber, setFlightNumber] = useState('');
  const [departureAirport, setDepartureAirport] = useState('');
  const [arrivalAirport, setArrivalAirport] = useState('');
  const [departureDatetime, setDepartureDatetime] = useState('');
  const [arrivalDatetime, setArrivalDatetime] = useState('');
  const [confirmationCode, setConfirmationCode] = useState('');
  const [direction, setDirection] = useState<Direction>('outbound');

  function reset() {
    setAirline(''); setFlightNumber(''); setDepartureAirport(''); setArrivalAirport('');
    setDepartureDatetime(''); setArrivalDatetime(''); setConfirmationCode(''); setDirection('outbound');
  }

  function handleSubmit() {
    if (!airline.trim() || !flightNumber.trim() || !departureAirport.trim() || !arrivalAirport.trim() || !departureDatetime.trim() || !arrivalDatetime.trim()) {
      Alert.alert('Missing fields', 'Please fill in airline, flight number, airports, and times.');
      return;
    }
    // Convert local datetime strings to ISO
    const depIso = new Date(departureDatetime).toISOString();
    const arrIso = new Date(arrivalDatetime).toISOString();
    createFlight({
      tripId,
      data: {
        airline: airline.trim(),
        flightNumber: flightNumber.trim(),
        departureAirport: departureAirport.trim().toUpperCase(),
        arrivalAirport: arrivalAirport.trim().toUpperCase(),
        departureDatetime: depIso,
        arrivalDatetime: arrIso,
        confirmationCode: confirmationCode.trim() || undefined,
        direction,
      },
    });
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[formStyles.container, { backgroundColor: colors.background }]}>
          <View style={[formStyles.header, { borderBottomColor: colors.border }]}>
            <Text style={[formStyles.title, { color: colors.foreground }]}>Add Flight</Text>
            <TouchableOpacity onPress={() => { onClose(); reset(); }} hitSlop={8}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
            <FieldLabel label="Airline" colors={colors} />
            <FormInput value={airline} onChangeText={setAirline} placeholder="e.g. Lufthansa" colors={colors} />

            <FieldLabel label="Flight Number" colors={colors} />
            <FormInput value={flightNumber} onChangeText={setFlightNumber} placeholder="e.g. LH401" colors={colors} autoCapitalize="characters" />

            <View style={formStyles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel label="From (IATA)" colors={colors} />
                <FormInput value={departureAirport} onChangeText={setDepartureAirport} placeholder="JFK" colors={colors} autoCapitalize="characters" maxLength={3} />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel label="To (IATA)" colors={colors} />
                <FormInput value={arrivalAirport} onChangeText={setArrivalAirport} placeholder="FRA" colors={colors} autoCapitalize="characters" maxLength={3} />
              </View>
            </View>

            <FieldLabel label="Departure (YYYY-MM-DD HH:MM)" colors={colors} />
            <FormInput value={departureDatetime} onChangeText={setDepartureDatetime} placeholder="2025-07-15 08:30" colors={colors} />

            <FieldLabel label="Arrival (YYYY-MM-DD HH:MM)" colors={colors} />
            <FormInput value={arrivalDatetime} onChangeText={setArrivalDatetime} placeholder="2025-07-15 20:15" colors={colors} />

            <FieldLabel label="Direction" colors={colors} />
            <View style={formStyles.chips}>
              {DIRECTIONS.map((d) => (
                <TouchableOpacity
                  key={d}
                  style={[formStyles.chip, { backgroundColor: direction === d ? colors.primary : colors.card, borderColor: direction === d ? colors.primary : colors.border }]}
                  onPress={() => setDirection(d)}
                >
                  <Text style={[formStyles.chipText, { color: direction === d ? '#fff' : colors.foreground }]}>
                    {d.charAt(0).toUpperCase() + d.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            <FieldLabel label="Confirmation Code (optional)" colors={colors} />
            <FormInput value={confirmationCode} onChangeText={setConfirmationCode} placeholder="ABC123" colors={colors} autoCapitalize="characters" />

            <TouchableOpacity
              style={[formStyles.submit, { backgroundColor: isPending ? colors.muted : colors.primary }]}
              onPress={handleSubmit}
              disabled={isPending}
            >
              {isPending ? <ActivityIndicator color="#fff" /> : (
                <Text style={formStyles.submitText}>Add Flight</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function TripFlightsSection({ tripId }: { tripId: number }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const { data: flights, isLoading, isError, refetch, isRefetching } = useListFlights(tripId, { query: { enabled: !!tripId } });
  const { mutate: deleteFlight } = useDeleteFlight({
    mutation: {
      onSuccess: () => { queryClient.invalidateQueries({ queryKey: getListFlightsQueryKey(tripId) }); queryClient.invalidateQueries({ queryKey: getGetTripTimelineQueryKey(tripId) }); },
    },
  });

  if (isLoading) return <View style={s.center}><ActivityIndicator color={colors.primary} /></View>;
  if (isError) return (
    <View style={s.center}>
      <Feather name="alert-circle" size={28} color={colors.mutedForeground} />
      <TouchableOpacity onPress={() => refetch()} style={[s.retryBtn, { backgroundColor: colors.primary }]}>
        <Text style={s.retryText}>Retry</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}
      >
        <TouchableOpacity style={[s.addBtn, { backgroundColor: colors.primary }]} onPress={() => setShowAdd(true)}>
          <Feather name="plus" size={16} color="#fff" />
          <Text style={s.addBtnText}>Add Flight</Text>
        </TouchableOpacity>

        {flights && flights.length > 0 ? flights.map((f) => (
          <FlightCard key={f.id} tripId={tripId} flight={f} colors={colors} onDelete={(id) => deleteFlight({ tripId, flightId: id })} />
        )) : (
          <View style={[s.empty, { borderColor: colors.border }]}>
            <Feather name="navigation" size={32} color={colors.mutedForeground} />
            <Text style={[s.emptyTitle, { color: colors.foreground }]}>No flights yet</Text>
            <Text style={[s.emptySub, { color: colors.mutedForeground }]}>Tap Add Flight to log your first flight.</Text>
          </View>
        )}
      </ScrollView>
      <AddFlightModal tripId={tripId} visible={showAdd} onClose={() => setShowAdd(false)} colors={colors} />
    </>
  );
}

// ── Shared form helpers ───────────────────────────────────────────────────────

export function FieldLabel({ label, colors }: { label: string; colors: ReturnType<typeof useColors> }) {
  return <Text style={[formStyles.label, { color: colors.mutedForeground }]}>{label.toUpperCase()}</Text>;
}

export function FormInput({
  value, onChangeText, placeholder, colors, multiline, autoCapitalize, maxLength,
}: {
  value: string; onChangeText: (t: string) => void; placeholder?: string;
  colors: ReturnType<typeof useColors>; multiline?: boolean; autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters'; maxLength?: number;
}) {
  return (
    <View style={[formStyles.inputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <TextInput
        style={[formStyles.input, { color: colors.foreground }, multiline && { minHeight: 80, textAlignVertical: 'top' }]}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        multiline={multiline}
        autoCapitalize={autoCapitalize ?? 'words'}
        maxLength={maxLength}
      />
    </View>
  );
}

export const formStyles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingVertical: 16, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  body: { padding: 16, gap: 8, paddingBottom: 40 },
  label: { fontSize: 11, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, marginBottom: 2 },
  inputWrap: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 10 },
  input: { fontSize: 15, fontFamily: 'Inter_400Regular', padding: 0, margin: 0 },
  row: { flexDirection: 'row', gap: 10 },
  chips: { flexDirection: 'row', gap: 8, flexWrap: 'wrap', marginBottom: 10 },
  chip: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 20, borderWidth: 1 },
  chipText: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  submit: { paddingVertical: 15, borderRadius: 12, alignItems: 'center', marginTop: 8 },
  submitText: { color: '#fff', fontSize: 16, fontFamily: 'Inter_600SemiBold' },
});

const s = StyleSheet.create({
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
