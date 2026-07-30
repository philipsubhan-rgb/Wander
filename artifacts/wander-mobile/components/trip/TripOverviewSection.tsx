import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useGetTripSummary, useGetTripTimeline } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

function StatCard({
  icon,
  label,
  value,
  colors,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string | number | undefined;
  colors: ReturnType<typeof useColors>;
}) {
  return (
    <View style={[statStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={[statStyles.iconWrap, { backgroundColor: colors.primary + '18' }]}>
        <Feather name={icon} size={18} color={colors.primary} />
      </View>
      <Text style={[statStyles.value, { color: colors.foreground }]}>
        {value !== undefined ? String(value) : '–'}
      </Text>
      <Text style={[statStyles.label, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const statStyles = StyleSheet.create({
  card: {
    flex: 1,
    minWidth: 90,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    alignItems: 'center',
    gap: 6,
  },
  iconWrap: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: 20, fontFamily: 'Inter_700Bold' },
  label: { fontSize: 11, fontFamily: 'Inter_500Medium', textTransform: 'uppercase', letterSpacing: 0.5 },
});

const TYPE_ICON: Record<string, keyof typeof Feather.glyphMap> = {
  flight: 'navigation',
  accommodation: 'home',
  activity: 'compass',
  itinerary: 'calendar',
  car_rental: 'truck',
  reservation: 'bookmark',
};

const TYPE_COLOR: Record<string, string> = {
  flight: '#2F7CE0',
  accommodation: '#EC4899',
  activity: '#10B981',
  itinerary: '#8B5CF6',
  car_rental: '#F59E0B',
  reservation: '#F97316',
};

function TimelineEvent({ event, colors }: { event: any; colors: ReturnType<typeof useColors> }) {
  const icon = TYPE_ICON[event.type] ?? 'circle';
  const color = TYPE_COLOR[event.type] ?? colors.primary;

  const date = event.date
    ? new Date(event.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  return (
    <View style={timelineStyles.row}>
      <View style={timelineStyles.dotCol}>
        <View style={[timelineStyles.dot, { backgroundColor: color + '20', borderColor: color }]}>
          <Feather name={icon} size={12} color={color} />
        </View>
        <View style={[timelineStyles.line, { backgroundColor: colors.border }]} />
      </View>
      <View style={[timelineStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={timelineStyles.cardRow}>
          <Text style={[timelineStyles.title, { color: colors.foreground }]} numberOfLines={1}>
            {event.title}
          </Text>
          {date ? (
            <View style={[timelineStyles.dateBadge, { backgroundColor: colors.muted }]}>
              <Text style={[timelineStyles.dateText, { color: colors.mutedForeground }]}>{date}</Text>
            </View>
          ) : null}
        </View>
        {(event.time || event.location) ? (
          <Text style={[timelineStyles.sub, { color: colors.mutedForeground }]} numberOfLines={1}>
            {[event.time, event.location].filter(Boolean).join(' · ')}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const timelineStyles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 12 },
  dotCol: { alignItems: 'center', width: 32 },
  dot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: { width: 1.5, flex: 1, marginTop: 4 },
  card: {
    flex: 1,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 10,
    marginBottom: 12,
    gap: 3,
  },
  cardRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  title: { flex: 1, fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  dateBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  dateText: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  sub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
});

export function TripOverviewSection({ tripId }: { tripId: number }) {
  const colors = useColors();
  const { data: summary, isLoading: sumLoading } = useGetTripSummary(tripId, { query: { enabled: !!tripId } });
  const { data: timeline, isLoading: tlLoading } = useGetTripTimeline(tripId, { query: { enabled: !!tripId } });

  if (sumLoading || tlLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const packed = `${summary?.packingCheckedCount ?? 0}/${summary?.packingItemsCount ?? 0}`;

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.container}
    >
      {/* Stats grid */}
      <View style={styles.statsGrid}>
        <View style={styles.statsRow}>
          <StatCard icon="calendar" label="Days" value={summary?.daysCount} colors={colors} />
          <StatCard icon="navigation" label="Flights" value={summary?.flightsCount} colors={colors} />
          <StatCard icon="home" label="Stays" value={summary?.accommodationsCount} colors={colors} />
        </View>
        <View style={styles.statsRow}>
          <StatCard icon="compass" label="Activities" value={summary?.activitiesCount} colors={colors} />
          <StatCard icon="users" label="Travelers" value={summary?.participantsCount} colors={colors} />
          <StatCard icon="check-square" label="Packed" value={packed} colors={colors} />
        </View>
      </View>

      {/* Timeline */}
      <Text style={[styles.sectionTitle, { color: colors.mutedForeground }]}>TIMELINE</Text>
      {timeline && (timeline as any[]).length > 0 ? (
        <View style={styles.timeline}>
          {(timeline as any[]).map((event: any, i: number) => (
            <TimelineEvent key={`${event.type}-${event.id}-${i}`} event={event} colors={colors} />
          ))}
        </View>
      ) : (
        <View style={[styles.empty, { backgroundColor: colors.muted + '60', borderColor: colors.border }]}>
          <Feather name="calendar" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            Add flights, stays, or activities to build your timeline.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 16, gap: 16, paddingBottom: 32 },
  statsGrid: { gap: 8 },
  statsRow: { flexDirection: 'row', gap: 8 },
  sectionTitle: {
    fontSize: 11,
    fontFamily: 'Inter_600SemiBold',
    letterSpacing: 0.8,
    marginBottom: -4,
  },
  timeline: { gap: 0 },
  empty: {
    borderRadius: 12,
    borderWidth: 1,
    borderStyle: 'dashed',
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
