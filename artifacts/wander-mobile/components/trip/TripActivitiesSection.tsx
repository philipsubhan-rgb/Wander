import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, Modal, Alert, RefreshControl, KeyboardAvoidingView, Platform,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useListActivities, useCreateActivity, useDeleteActivity, getListActivitiesQueryKey,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { FieldLabel, FormInput, formStyles } from './TripFlightsSection';

const ACTIVITY_TYPES = ['sightseeing', 'dining', 'adventure', 'culture', 'relaxation', 'transport', 'other'] as const;
type ActivityType = typeof ACTIVITY_TYPES[number];

const ACT_COLORS: Record<ActivityType, string> = {
  sightseeing: '#60A5FA', dining: '#FB923C', adventure: '#4ADE80',
  culture: '#C084FC', relaxation: '#2DD4BF', transport: '#94A3B8', other: '#A8A29E',
};

const ACT_ICONS: Record<ActivityType, keyof typeof Feather.glyphMap> = {
  sightseeing: 'eye', dining: 'coffee', adventure: 'zap',
  culture: 'book', relaxation: 'sun', transport: 'truck', other: 'compass',
};

function ActivityCard({ tripId, activity, colors, onDelete }: {
  tripId: number; activity: any; colors: ReturnType<typeof useColors>; onDelete: (id: number) => void;
}) {
  const type = (activity.type as ActivityType) ?? 'other';
  const accent = ACT_COLORS[type];
  const icon = ACT_ICONS[type];
  const date = activity.date ? new Date(activity.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '–';

  function confirmDelete() {
    Alert.alert('Delete Activity', `Remove "${activity.title}"?`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); onDelete(activity.id); } },
    ]);
  }

  return (
    <View style={[ac.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={ac.header}>
        <View style={[ac.iconWrap, { backgroundColor: accent + '18' }]}>
          <Feather name={icon} size={15} color={accent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[ac.title, { color: colors.foreground }]} numberOfLines={1}>{activity.title}</Text>
          <View style={[ac.typeBadge, { backgroundColor: accent + '18' }]}>
            <Text style={[ac.typeText, { color: accent }]}>{type}</Text>
          </View>
        </View>
        <TouchableOpacity onPress={confirmDelete} hitSlop={8}>
          <Feather name="trash-2" size={14} color={colors.mutedForeground} />
        </TouchableOpacity>
      </View>

      <View style={ac.row}>
        <Feather name="calendar" size={12} color={colors.primary} />
        <Text style={[ac.detail, { color: colors.foreground }]}>{date}</Text>
        {activity.time ? (
          <>
            <Text style={{ color: colors.mutedForeground }}>·</Text>
            <Feather name="clock" size={12} color={colors.primary} />
            <Text style={[ac.detail, { color: colors.foreground }]}>{activity.time}</Text>
          </>
        ) : null}
      </View>

      {activity.location ? (
        <View style={ac.row}>
          <Feather name="map-pin" size={12} color={colors.mutedForeground} />
          <Text style={[ac.detail, { color: colors.mutedForeground }]} numberOfLines={1}>{activity.location}</Text>
        </View>
      ) : null}

      {activity.description ? (
        <Text style={[ac.desc, { color: colors.mutedForeground }]} numberOfLines={2}>{activity.description}</Text>
      ) : null}
    </View>
  );
}

const ac = StyleSheet.create({
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 8 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  iconWrap: { width: 36, height: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  typeBadge: { alignSelf: 'flex-start', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginTop: 2 },
  typeText: { fontSize: 11, fontFamily: 'Inter_600SemiBold', textTransform: 'capitalize' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  detail: { fontSize: 12, fontFamily: 'Inter_500Medium' },
  desc: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18 },
});

function AddActivityModal({ tripId, visible, onClose, colors }: {
  tripId: number; visible: boolean; onClose: () => void; colors: ReturnType<typeof useColors>;
}) {
  const queryClient = useQueryClient();
  const { mutate: createActivity, isPending } = useCreateActivity({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListActivitiesQueryKey(tripId) });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onClose(); reset();
      },
      onError: () => Alert.alert('Error', 'Failed to add activity'),
    },
  });

  const [title, setTitle] = useState('');
  const [type, setType] = useState<ActivityType>('sightseeing');
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [location, setLocation] = useState('');
  const [description, setDescription] = useState('');

  function reset() { setTitle(''); setType('sightseeing'); setDate(''); setTime(''); setLocation(''); setDescription(''); }

  function handleSubmit() {
    if (!title.trim() || !date.trim()) {
      Alert.alert('Missing fields', 'Title and date are required.');
      return;
    }
    createActivity({
      tripId,
      data: {
        title: title.trim(),
        type,
        date: date.trim(),
        time: time.trim() || undefined,
        location: location.trim() || undefined,
        description: description.trim() || undefined,
      },
    });
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[formStyles.container, { backgroundColor: colors.background }]}>
          <View style={[formStyles.header, { borderBottomColor: colors.border }]}>
            <Text style={[formStyles.title, { color: colors.foreground }]}>Add Activity</Text>
            <TouchableOpacity onPress={() => { onClose(); reset(); }} hitSlop={8}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
            <FieldLabel label="Title" colors={colors} />
            <FormInput value={title} onChangeText={setTitle} placeholder="e.g. Visit Eiffel Tower" colors={colors} />
            <FieldLabel label="Type" colors={colors} />
            <View style={formStyles.chips}>
              {ACTIVITY_TYPES.map((t) => (
                <TouchableOpacity key={t} style={[formStyles.chip, { backgroundColor: type === t ? ACT_COLORS[t] : colors.card, borderColor: type === t ? ACT_COLORS[t] : colors.border }]} onPress={() => setType(t)}>
                  <Text style={[formStyles.chipText, { color: type === t ? '#fff' : colors.foreground }]}>
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <View style={formStyles.row}>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Date (YYYY-MM-DD)" colors={colors} />
                <FormInput value={date} onChangeText={setDate} placeholder="2025-07-15" colors={colors} autoCapitalize="none" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel label="Time (optional)" colors={colors} />
                <FormInput value={time} onChangeText={setTime} placeholder="14:00" colors={colors} autoCapitalize="none" />
              </View>
            </View>
            <FieldLabel label="Location (optional)" colors={colors} />
            <FormInput value={location} onChangeText={setLocation} placeholder="e.g. Champ de Mars, Paris" colors={colors} />
            <FieldLabel label="Description (optional)" colors={colors} />
            <FormInput value={description} onChangeText={setDescription} placeholder="Add notes about this activity…" colors={colors} multiline />
            <TouchableOpacity style={[formStyles.submit, { backgroundColor: isPending ? colors.muted : colors.primary }]} onPress={handleSubmit} disabled={isPending}>
              {isPending ? <ActivityIndicator color="#fff" /> : <Text style={formStyles.submitText}>Add Activity</Text>}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function TripActivitiesSection({ tripId }: { tripId: number }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  const { data: activities, isLoading, isError, refetch, isRefetching } = useListActivities(tripId, { query: { enabled: !!tripId } });
  const { mutate: deleteActivity } = useDeleteActivity({
    mutation: { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListActivitiesQueryKey(tripId) }) },
  });

  const sorted = activities ? [...activities].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()) : [];

  if (isLoading) return <View style={as.center}><ActivityIndicator color={colors.primary} /></View>;

  return (
    <>
      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={as.list}
        refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}>
        <TouchableOpacity style={[as.addBtn, { backgroundColor: colors.primary }]} onPress={() => setShowAdd(true)}>
          <Feather name="plus" size={16} color="#fff" />
          <Text style={as.addBtnText}>Add Activity</Text>
        </TouchableOpacity>
        {sorted.length > 0 ? sorted.map((a) => (
          <ActivityCard key={a.id} tripId={tripId} activity={a} colors={colors} onDelete={(id) => deleteActivity({ tripId, activityId: id })} />
        )) : (
          <View style={[as.empty, { borderColor: colors.border }]}>
            <Feather name="compass" size={32} color={colors.mutedForeground} />
            <Text style={[as.emptyTitle, { color: colors.foreground }]}>No activities planned</Text>
            <Text style={[as.emptySub, { color: colors.mutedForeground }]}>Tap Add Activity to start building your itinerary.</Text>
          </View>
        )}
      </ScrollView>
      <AddActivityModal tripId={tripId} visible={showAdd} onClose={() => setShowAdd(false)} colors={colors} />
    </>
  );
}

const as = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 16, gap: 10, paddingBottom: 32 },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12 },
  addBtnText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  empty: { borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', paddingVertical: 48, alignItems: 'center', gap: 8 },
  emptyTitle: { fontSize: 16, fontFamily: 'Inter_600SemiBold', marginTop: 4 },
  emptySub: { fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
