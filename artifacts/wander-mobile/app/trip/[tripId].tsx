import React, { useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Feather } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useGetTrip } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';

import { TripOverviewSection } from '@/components/trip/TripOverviewSection';
import { TripFlightsSection } from '@/components/trip/TripFlightsSection';
import { TripStaysSection } from '@/components/trip/TripStaysSection';
import { TripActivitiesSection } from '@/components/trip/TripActivitiesSection';
import { TripCarRentalsSection } from '@/components/trip/TripCarRentalsSection';
import { TripReservationsSection } from '@/components/trip/TripReservationsSection';
import { TripPackingSection } from '@/components/trip/TripPackingSection';
import { TripNotesSection } from '@/components/trip/TripNotesSection';
import { TripExpensesSection } from '@/components/trip/TripExpensesSection';
import { TripBalanceSection } from '@/components/trip/TripBalanceSection';
import { TripTravelersSection } from '@/components/trip/TripTravelersSection';
import { TripItinerarySection } from '@/components/trip/TripItinerarySection';
import { TripSettingsSection } from '@/components/trip/TripSettingsSection';

// ── Tab definitions ───────────────────────────────────────────────────────────

type TabId =
  | 'overview'
  | 'flights'
  | 'stays'
  | 'activities'
  | 'cars'
  | 'bookings'
  | 'packing'
  | 'notes'
  | 'expenses'
  | 'balance'
  | 'travelers'
  | 'itinerary'
  | 'settings';

const TABS: { id: TabId; label: string; icon: keyof typeof Feather.glyphMap }[] = [
  { id: 'overview',    label: 'Overview',    icon: 'grid' },
  { id: 'flights',     label: 'Flights',     icon: 'navigation' },
  { id: 'stays',       label: 'Stays',       icon: 'home' },
  { id: 'activities',  label: 'Activities',  icon: 'compass' },
  { id: 'cars',        label: 'Cars',        icon: 'truck' },
  { id: 'bookings',    label: 'Bookings',    icon: 'bookmark' },
  { id: 'packing',     label: 'Packing',     icon: 'briefcase' },
  { id: 'notes',       label: 'Notes',       icon: 'file-text' },
  { id: 'expenses',    label: 'Expenses',    icon: 'credit-card' },
  { id: 'balance',     label: 'Balance',     icon: 'bar-chart-2' },
  { id: 'travelers',   label: 'Travelers',   icon: 'users' },
  { id: 'itinerary',  label: 'Itinerary',   icon: 'calendar' },
  { id: 'settings',   label: 'Settings',    icon: 'settings' },
];

// ── Main screen ───────────────────────────────────────────────────────────────

export default function TripDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { tripId: tripIdParam } = useLocalSearchParams<{ tripId: string }>();
  const tripId = Number(tripIdParam);
  const isWeb = Platform.OS === 'web';
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const tabScrollRef = useRef<ScrollView>(null);

  const { data: trip } = useGetTrip(tripId);

  const bottomPad = isWeb ? insets.bottom + 34 : insets.bottom;

  function handleTabPress(tab: TabId, index: number) {
    Haptics.selectionAsync();
    setActiveTab(tab);
    // Scroll tab bar to keep selected tab visible
    tabScrollRef.current?.scrollTo({ x: Math.max(0, index * 88 - 88), animated: true });
  }

  function renderSection() {
    switch (activeTab) {
      case 'overview':    return <TripOverviewSection tripId={tripId} />;
      case 'flights':     return <TripFlightsSection tripId={tripId} />;
      case 'stays':       return <TripStaysSection tripId={tripId} />;
      case 'activities':  return <TripActivitiesSection tripId={tripId} />;
      case 'cars':        return <TripCarRentalsSection tripId={tripId} />;
      case 'bookings':    return <TripReservationsSection tripId={tripId} />;
      case 'packing':     return <TripPackingSection tripId={tripId} />;
      case 'notes':       return <TripNotesSection tripId={tripId} />;
      case 'expenses':    return <TripExpensesSection tripId={tripId} bottomPad={bottomPad} />;
      case 'balance':     return <TripBalanceSection tripId={tripId} bottomPad={bottomPad} />;
      case 'travelers':   return <TripTravelersSection tripId={tripId} />;
      case 'itinerary':   return <TripItinerarySection tripId={tripId} />;
      case 'settings':    return <TripSettingsSection tripId={tripId} />;
    }
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Trip header */}
      <View style={[styles.tripHeader, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} hitSlop={8} style={styles.backBtn}>
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.tripTitle, { color: colors.foreground }]} numberOfLines={1}>
            {trip?.title ?? '…'}
          </Text>
          {trip?.destination ? (
            <View style={styles.destRow}>
              <Feather name="map-pin" size={11} color={colors.mutedForeground} />
              <Text style={[styles.tripDest, { color: colors.mutedForeground }]}>{trip.destination}</Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Scrollable tab bar */}
      <View style={[styles.tabBarWrap, { borderBottomColor: colors.border }]}>
        <ScrollView
          ref={tabScrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabBarContent}
        >
          {TABS.map((tab, index) => {
            const active = activeTab === tab.id;
            return (
              <TouchableOpacity
                key={tab.id}
                style={[
                  styles.tabBtn,
                  active && [styles.tabBtnActive, { borderBottomColor: colors.primary }],
                ]}
                onPress={() => handleTabPress(tab.id, index)}
                activeOpacity={0.7}
              >
                <Feather
                  name={tab.icon}
                  size={14}
                  color={active ? colors.primary : colors.mutedForeground}
                />
                <Text
                  style={[
                    styles.tabLabel,
                    { color: active ? colors.primary : colors.mutedForeground },
                    active && { fontFamily: 'Inter_600SemiBold' },
                  ]}
                >
                  {tab.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Section content */}
      <View style={styles.content}>
        {renderSection()}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  tripHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
  backBtn: { padding: 2 },
  tripTitle: { fontSize: 17, fontFamily: 'Inter_700Bold' },
  destRow: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 1 },
  tripDest: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  tabBarWrap: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabBarContent: {
    paddingHorizontal: 12,
    gap: 0,
  },
  tabBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabBtnActive: {
    borderBottomWidth: 2,
  },
  tabLabel: {
    fontSize: 13,
    fontFamily: 'Inter_500Medium',
  },
  content: { flex: 1 },
});
