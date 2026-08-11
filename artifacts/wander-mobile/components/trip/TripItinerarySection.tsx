import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, ActivityIndicator, RefreshControl,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useGetTripTimeline, useListItineraryDays } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  try {
    // Parse as local date (YYYY-MM-DD) to avoid timezone issues
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return dateStr;
  }
}

function formatTime(timeStr: string | null): string | null {
  if (!timeStr) return null;
  try {
    const [h, m] = timeStr.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  } catch {
    return timeStr;
  }
}

function formatDatetimeTime(dt: string | null): string | null {
  if (!dt) return null;
  try {
    const d = new Date(dt);
    return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch {
    return null;
  }
}

// ── Event description builder ─────────────────────────────────────────────────

function getEventLabel(event: any): string {
  switch (event.type) {
    case 'flight': {
      const time = formatDatetimeTime(event.departureDatetime);
      const from = event.departureAirport ?? '?';
      const to = event.arrivalAirport ?? '?';
      const flight = [event.airline, event.flightNumber].filter(Boolean).join(' ');
      return [flight, `${from} → ${to}`, time].filter(Boolean).join(' · ');
    }
    case 'accommodation': {
      const verb = event._isCheckout === 1 ? 'Check out' : 'Check in';
      return `${verb}: ${event.name ?? event.title ?? ''}`;
    }
    case 'activity': {
      const time = formatTime(event.time);
      return [event.title, time].filter(Boolean).join(' at ');
    }
    case 'car_rental': {
      const verb = event._isDropoff === 1 ? 'Drop off' : 'Pick up';
      return `${verb}: ${event.company ?? event.title ?? ''}`;
    }
    case 'itinerary':
      return event.title ?? event.note ?? '';
    default:
      return event.title ?? '';
  }
}

function getEventIcon(type: string): keyof typeof Feather.glyphMap {
  switch (type) {
    case 'flight':        return 'navigation';
    case 'accommodation': return 'home';
    case 'activity':      return 'compass';
    case 'car_rental':    return 'truck';
    case 'itinerary':     return 'file-text';
    default:              return 'circle';
  }
}

const TYPE_COLOR: Record<string, string> = {
  flight:        '#2F7CE0',
  accommodation: '#EC4899',
  activity:      '#10B981',
  itinerary:     '#8B5CF6',
  car_rental:    '#F59E0B',
  reservation:   '#F97316',
};

// ── EventRow ──────────────────────────────────────────────────────────────────

function EventRow({ event, colors }: { event: any; colors: ReturnType<typeof useColors> }) {
  const icon = getEventIcon(event.type);
  const color = TYPE_COLOR[event.type] ?? colors.primary;
  const label = getEventLabel(event);

  return (
    <View style={eventStyles.row}>
      <View style={[eventStyles.iconWrap, { backgroundColor: color + '18', borderColor: color + '40' }]}>
        <Feather name={icon} size={13} color={color} />
      </View>
      <Text style={[eventStyles.label, { color: colors.foreground }]} numberOfLines={2}>
        {label}
      </Text>
    </View>
  );
}

const eventStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 5 },
  iconWrap: {
    width: 28, height: 28, borderRadius: 14, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', marginTop: 1,
  },
  label: { flex: 1, fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18 },
});

// ── DayCard ───────────────────────────────────────────────────────────────────

function DayCard({
  dayNumber, dateStr, events, note, colors,
}: {
  dayNumber: number;
  dateStr: string;
  events: any[];
  note: any;
  colors: ReturnType<typeof useColors>;
}) {
  const headerLabel = `Day ${dayNumber} — ${formatDate(dateStr)}`;
  const title = note?.title ?? null;
  const description = note?.description ?? null;

  return (
    <View style={[dayStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      {/* Day header */}
      <View style={[dayStyles.header, { backgroundColor: colors.muted, borderBottomColor: colors.border }]}>
        <View style={dayStyles.headerLeft}>
          <Text style={[dayStyles.dayLabel, { color: colors.foreground }]}>{headerLabel}</Text>
          {title ? (
            <Text style={[dayStyles.dayTitle, { color: colors.primary }]}>{title}</Text>
          ) : null}
        </View>
        <View style={[dayStyles.countBadge, { backgroundColor: colors.primary + '18' }]}>
          <Text style={[dayStyles.countText, { color: colors.primary }]}>{events.length}</Text>
        </View>
      </View>

      {/* Body */}
      <View style={dayStyles.body}>
        {description ? (
          <Text style={[dayStyles.description, { color: colors.mutedForeground }]}>{description}</Text>
        ) : null}

        {events.length > 0 ? (
          <View style={dayStyles.events}>
            {events.map((event: any, i: number) => (
              <View key={`${event.type}-${event.id}-${i}`}>
                {i > 0 && <View style={[dayStyles.divider, { backgroundColor: colors.border }]} />}
                <EventRow event={event} colors={colors} />
              </View>
            ))}
          </View>
        ) : (
          <Text style={[dayStyles.noEvents, { color: colors.mutedForeground }]}>
            No events scheduled for this day.
          </Text>
        )}
      </View>
    </View>
  );
}

const dayStyles = StyleSheet.create({
  card: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  headerLeft: { flex: 1, gap: 2 },
  dayLabel: { fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  dayTitle: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  countBadge: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10,
  },
  countText: { fontSize: 11, fontFamily: 'Inter_600SemiBold' },
  body: { padding: 14, gap: 8 },
  description: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18, marginBottom: 4 },
  events: { gap: 0 },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: 2 },
  noEvents: { fontSize: 13, fontFamily: 'Inter_400Regular', fontStyle: 'italic' },
});

// ── Main Section ──────────────────────────────────────────────────────────────

export function TripItinerarySection({ tripId }: { tripId: number }) {
  const colors = useColors();

  const {
    data: timeline,
    isLoading: tlLoading,
    refetch: refetchTimeline,
    isRefetching: tlRefetching,
  } = useGetTripTimeline(tripId, { query: { enabled: !!tripId } });

  const {
    data: itineraryDays,
    isLoading: dayLoading,
    refetch: refetchDays,
    isRefetching: dayRefetching,
  } = useListItineraryDays(tripId, { query: { enabled: !!tripId } });

  const isLoading = tlLoading || dayLoading;
  const isRefreshing = tlRefetching || dayRefetching;

  function handleRefresh() {
    refetchTimeline();
    refetchDays();
  }

  if (isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  const events: any[] = Array.isArray(timeline) ? (timeline as any[]) : [];
  const days: any[] = Array.isArray(itineraryDays) ? (itineraryDays as any[]) : [];

  // Group events by date string (YYYY-MM-DD)
  const byDate = new Map<string, any[]>();
  for (const event of events) {
    const dateKey = event.date ? String(event.date).slice(0, 10) : '__unknown__';
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey)!.push(event);
  }

  // Build sorted list of dates
  const allDates = Array.from(byDate.keys()).filter(d => d !== '__unknown__').sort();

  // Add any itinerary day dates that may not have events
  for (const day of days) {
    const dk = day.date ? String(day.date).slice(0, 10) : null;
    if (dk && !byDate.has(dk)) {
      byDate.set(dk, []);
      allDates.push(dk);
    }
  }
  allDates.sort();

  // Note lookup by date
  const noteByDate = new Map<string, any>();
  for (const day of days) {
    const dk = day.date ? String(day.date).slice(0, 10) : null;
    if (dk) noteByDate.set(dk, day);
  }

  if (allDates.length === 0) {
    return (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.container}
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor={colors.primary}
          />
        }
      >
        <View style={[styles.empty, { backgroundColor: colors.muted + '60', borderColor: colors.border }]}>
          <Feather name="calendar" size={28} color={colors.mutedForeground} />
          <Text style={[styles.emptyText, { color: colors.mutedForeground }]}>
            No events yet. Add flights, stays, and activities to build your itinerary.
          </Text>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={isRefreshing}
          onRefresh={handleRefresh}
          tintColor={colors.primary}
        />
      }
    >
      {allDates.map((dateStr, index) => (
        <DayCard
          key={dateStr}
          dayNumber={index + 1}
          dateStr={dateStr}
          events={byDate.get(dateStr) ?? []}
          note={noteByDate.get(dateStr) ?? null}
          colors={colors}
        />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 16, paddingBottom: 32 },
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
