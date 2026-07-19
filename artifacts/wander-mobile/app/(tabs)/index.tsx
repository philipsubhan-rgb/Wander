import React, { useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Platform,
  RefreshControl,
} from 'react-native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import { useListTrips } from '@workspace/api-client-react';
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

export default function TripsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { user, isLoading: authLoading } = useAuth();
  const isWeb = Platform.OS === 'web';

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
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>Trips</Text>
        <Text style={[styles.headerSub, { color: colors.mutedForeground }]}>
          {trips ? `${trips.length} trip${trips.length !== 1 ? 's' : ''}` : ''}
        </Text>
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
                Your trips will appear here once an admin adds you to one.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: {
    paddingHorizontal: 20,
    paddingBottom: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  headerTitle: {
    fontSize: 28,
    fontFamily: 'Inter_700Bold',
    letterSpacing: -0.5,
  },
  headerSub: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
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
