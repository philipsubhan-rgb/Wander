import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  RefreshControl,
  Modal,
  TextInput,
  ScrollView,
  KeyboardAvoidingView,
  Alert,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useListTrips,
  useCreateTrip,
  getListTripsQueryKey,
} from '@workspace/api-client-react';
import type { Trip } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/context/AuthContext';

const STATUS_COLORS: Record<string, string> = {
  planning: '#F59E0B',
  confirmed: '#2F7CE0',
  active: '#10B981',
  completed: '#6B7FA3',
};

const STATUS_LABELS: Record<string, string> = {
  planning: 'Planning',
  confirmed: 'Confirmed',
  active: 'Active',
  completed: 'Completed',
};

function TripCard({ trip, colors }: { trip: Trip; colors: ReturnType<typeof useColors> }) {
  const startDate = new Date(trip.startDate);
  const endDate = new Date(trip.endDate);
  const statusColor = STATUS_COLORS[trip.status] ?? '#6B7FA3';

  const formatDate = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const daysCount = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
      onPress={() => router.push(`/trip/${trip.id}`)}
      activeOpacity={0.85}
      testID={`trip-card-${trip.id}`}
    >
      {/* Color bar */}
      <View style={[styles.cardAccent, { backgroundColor: statusColor }]} />

      <View style={styles.cardBody}>
        <View style={styles.cardTop}>
          <View style={styles.cardTitles}>
            <Text style={[styles.cardTitle, { color: colors.foreground }]} numberOfLines={1}>
              {trip.title}
            </Text>
            <View style={styles.destRow}>
              <Feather name="map-pin" size={12} color={colors.mutedForeground} />
              <Text style={[styles.cardDest, { color: colors.mutedForeground }]} numberOfLines={1}>
                {trip.destination}
              </Text>
            </View>
          </View>
          <View style={[styles.statusBadge, { backgroundColor: statusColor + '20' }]}>
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>
              {STATUS_LABELS[trip.status]}
            </Text>
          </View>
        </View>

        <View style={styles.cardBottom}>
          <View style={styles.metaItem}>
            <Feather name="calendar" size={12} color={colors.mutedForeground} />
            <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
              {formatDate(startDate)} – {formatDate(endDate)}
            </Text>
          </View>
          <View style={[styles.daysBadge, { backgroundColor: colors.muted }]}>
            <Text style={[styles.daysText, { color: colors.primary }]}>
              {daysCount}d
            </Text>
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function CreateTripModal({
  visible,
  onClose,
  colors,
}: {
  visible: boolean;
  onClose: () => void;
  colors: ReturnType<typeof useColors>;
}) {
  const queryClient = useQueryClient();
  const { mutate: createTrip, isPending } = useCreateTrip({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTripsQueryKey() });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onClose();
        reset();
      },
      onError: () => Alert.alert('Error', 'Failed to create trip. Please try again.'),
    },
  });

  const [title, setTitle] = useState('');
  const [destination, setDestination] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  function reset() {
    setTitle('');
    setDestination('');
    setStartDate('');
    setEndDate('');
  }

  function handleSubmit() {
    if (!title.trim() || !destination.trim() || !startDate.trim() || !endDate.trim()) {
      Alert.alert('Missing fields', 'Please fill in all required fields.');
      return;
    }
    createTrip({
      data: {
        title: title.trim(),
        destination: destination.trim(),
        startDate: startDate.trim(),
        endDate: endDate.trim(),
      },
    });
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={() => { onClose(); reset(); }}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
      >
        <View style={[modalStyles.container, { backgroundColor: colors.background }]}>
          {/* Header */}
          <View style={[modalStyles.header, { borderBottomColor: colors.border }]}>
            <Text style={[modalStyles.title, { color: colors.foreground }]}>New Trip</Text>
            <TouchableOpacity onPress={() => { onClose(); reset(); }} hitSlop={8}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={modalStyles.body} keyboardShouldPersistTaps="handled">
            {/* Title */}
            <Text style={[modalStyles.label, { color: colors.mutedForeground }]}>TITLE</Text>
            <View style={[modalStyles.inputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <TextInput
                style={[modalStyles.input, { color: colors.foreground }]}
                value={title}
                onChangeText={setTitle}
                placeholder="e.g. Summer in Europe"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="words"
              />
            </View>

            {/* Destination */}
            <Text style={[modalStyles.label, { color: colors.mutedForeground }]}>DESTINATION</Text>
            <View style={[modalStyles.inputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Feather name="map-pin" size={14} color={colors.mutedForeground} style={{ marginRight: 6 }} />
              <TextInput
                style={[modalStyles.input, { color: colors.foreground }]}
                value={destination}
                onChangeText={setDestination}
                placeholder="e.g. Paris, France"
                placeholderTextColor={colors.mutedForeground}
                autoCapitalize="words"
              />
            </View>

            {/* Dates */}
            <View style={modalStyles.row}>
              <View style={{ flex: 1 }}>
                <Text style={[modalStyles.label, { color: colors.mutedForeground }]}>START DATE</Text>
                <View style={[modalStyles.inputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Feather name="calendar" size={14} color={colors.mutedForeground} style={{ marginRight: 6 }} />
                  <TextInput
                    style={[modalStyles.input, { color: colors.foreground }]}
                    value={startDate}
                    onChangeText={setStartDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="none"
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[modalStyles.label, { color: colors.mutedForeground }]}>END DATE</Text>
                <View style={[modalStyles.inputWrap, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  <Feather name="calendar" size={14} color={colors.mutedForeground} style={{ marginRight: 6 }} />
                  <TextInput
                    style={[modalStyles.input, { color: colors.foreground }]}
                    value={endDate}
                    onChangeText={setEndDate}
                    placeholder="YYYY-MM-DD"
                    placeholderTextColor={colors.mutedForeground}
                    autoCapitalize="none"
                    keyboardType="numbers-and-punctuation"
                  />
                </View>
              </View>
            </View>

            <TouchableOpacity
              style={[modalStyles.submit, { backgroundColor: isPending ? colors.muted : colors.primary }]}
              onPress={handleSubmit}
              disabled={isPending}
            >
              {isPending ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={modalStyles.submitText}>Create Trip</Text>
              )}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export default function TripsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, isLoading: authLoading } = useAuth();
  const isWeb = Platform.OS === 'web';
  const [showCreate, setShowCreate] = useState(false);

  // Redirect to login if not authenticated
  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/login');
    }
  }, [user, authLoading]);

  const { data: trips, isLoading, isError, refetch, isRefetching } = useListTrips({
    query: { enabled: !!user },
  });

  if (authLoading || !user) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const topPad = isWeb ? insets.top + 67 : insets.top;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View style={[styles.header, { paddingTop: topPad + 16, borderBottomColor: colors.border }]}>
        <View style={styles.headerRow}>
          <View>
            <Text style={[styles.headerTitle, { color: colors.foreground }]}>Trips</Text>
            <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
              {trips ? `${trips.length} trip${trips.length !== 1 ? 's' : ''}` : ''}
            </Text>
          </View>
          <TouchableOpacity
            style={[styles.newTripBtn, { backgroundColor: colors.primary }]}
            onPress={() => setShowCreate(true)}
            activeOpacity={0.85}
            testID="create-trip-button"
          >
            <Feather name="plus" size={16} color="#fff" />
            <Text style={styles.newTripBtnText}>New Trip</Text>
          </TouchableOpacity>
        </View>
      </View>

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} size="large" />
        </View>
      ) : isError ? (
        <View style={styles.center}>
          <Feather name="wifi-off" size={32} color={colors.mutedForeground} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>Failed to load trips</Text>
          <TouchableOpacity onPress={() => refetch()} style={[styles.retryBtn, { backgroundColor: colors.primary }]}>
            <Text style={styles.retryText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={trips ?? []}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => <TripCard trip={item} colors={colors} />}
          contentContainerStyle={[
            styles.list,
            { paddingBottom: isWeb ? insets.bottom + 84 + 20 : insets.bottom + 90 + 20 },
          ]}
          scrollEnabled={!!(trips && trips.length > 0)}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={refetch}
              tintColor={colors.primary}
            />
          }
          ListEmptyComponent={
            <View style={styles.empty}>
              <Feather name="globe" size={40} color={colors.mutedForeground} />
              <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No trips yet</Text>
              <Text style={[styles.emptySub, { color: colors.mutedForeground }]}>
                Create your first trip or wait for an admin to add you to one.
              </Text>
            </View>
          }
        />
      )}

      <CreateTripModal
        visible={showCreate}
        onClose={() => setShowCreate(false)}
        colors={colors}
      />
    </View>
  );
}

const modalStyles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 18, fontFamily: 'Inter_700Bold' },
  body: { padding: 16, gap: 8, paddingBottom: 40 },
  label: { fontSize: 11, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8, marginBottom: 2 },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginBottom: 10,
  },
  input: { flex: 1, fontSize: 15, fontFamily: 'Inter_400Regular', padding: 0, margin: 0 },
  row: { flexDirection: 'row', gap: 10 },
  submit: { paddingVertical: 15, borderRadius: 12, alignItems: 'center', marginTop: 8 },
  submitText: { color: '#fff', fontSize: 16, fontFamily: 'Inter_600SemiBold' },
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
  },
  headerTitle: {
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.5,
  },
  headerSub: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
    marginTop: 2,
  },
  newTripBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
  },
  newTripBtnText: {
    color: '#fff',
    fontSize: 13,
    fontFamily: 'Inter_600SemiBold',
  },
  list: {
    padding: 16,
    gap: 12,
  },
  card: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    flexDirection: 'row',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardAccent: {
    width: 4,
  },
  cardBody: {
    flex: 1,
    padding: 14,
    gap: 10,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  cardTitles: { flex: 1, gap: 3 },
  cardTitle: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
  },
  destRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  cardDest: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 20,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
  },
  cardBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  daysBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
  },
  daysText: {
    fontSize: 12,
    fontFamily: 'Inter_700Bold',
  },
  empty: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontFamily: 'Inter_600SemiBold',
    marginTop: 12,
  },
  emptySub: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
  retryBtn: {
    marginTop: 8,
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 20,
  },
  retryText: {
    color: '#fff',
    fontSize: 14,
    fontFamily: 'Inter_600SemiBold',
  },
});
