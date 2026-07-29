import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, TextInput, Alert, RefreshControl,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useGetTrip,
  useListTripParticipants,
  useAddTripParticipant,
  useRemoveTripParticipant,
  lookupUserByEmail,
  customFetch,
  getListTripParticipantsQueryKey,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/context/AuthContext';

export function TripTravelersSection({ tripId }: { tripId: number }) {
  const colors = useColors();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: trip } = useGetTrip(tripId);
  const { data: participants, isLoading, refetch, isRefetching } = useListTripParticipants(
    tripId,
    { query: { enabled: !!tripId } },
  );

  const { mutate: addParticipant } = useAddTripParticipant();
  const { mutate: removeParticipant } = useRemoveTripParticipant();

  // The API sets isTripAdmin:true in the trip response for both super_admins
  // and trip-scoped admins, so checking this single field is sufficient.
  const canManage = !!(trip as any)?.isTripAdmin;

  // Add-by-email state
  const [email, setEmail] = useState('');
  const [isLooking, setIsLooking] = useState(false);
  const [foundUser, setFoundUser] = useState<any | null>(null);
  const [lookupError, setLookupError] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  // Crown-toggle pending
  const [togglingId, setTogglingId] = useState<number | null>(null);

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListTripParticipantsQueryKey(tripId) });

  // ── Lookup ──────────────────────────────────────────────────────────────────

  async function handleSearch() {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setIsLooking(true);
    setFoundUser(null);
    setLookupError('');
    try {
      const result = await lookupUserByEmail({ email: trimmed });
      setFoundUser(result ?? null);
      if (!result) setLookupError('No account found with that email.');
    } catch {
      setLookupError('No account found with that email.');
    } finally {
      setIsLooking(false);
    }
  }

  // ── Add ─────────────────────────────────────────────────────────────────────

  function handleAdd() {
    if (!foundUser) return;
    setIsAdding(true);
    addParticipant(
      { tripId, data: { userId: foundUser.id } },
      {
        onSuccess: () => {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          invalidate();
          setEmail('');
          setFoundUser(null);
          setLookupError('');
        },
        onError: () =>
          Alert.alert('Could not add traveler', 'They may already be in this trip.'),
        onSettled: () => setIsAdding(false),
      },
    );
  }

  // ── Remove ──────────────────────────────────────────────────────────────────

  function handleRemove(userId: number, name: string) {
    Alert.alert(
      'Remove traveler?',
      `${name} will be removed from this trip.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () =>
            removeParticipant(
              { tripId, userId },
              {
                onSuccess: () => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  invalidate();
                },
                onError: () =>
                  Alert.alert('Could not remove traveler', 'Something went wrong.'),
              },
            ),
        },
      ],
    );
  }

  // ── Toggle trip-admin role ───────────────────────────────────────────────────

  async function handleToggleAdmin(userId: number, currentlyAdmin: boolean) {
    setTogglingId(userId);
    try {
      await customFetch(`/api/trips/${tripId}/participants/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isTripAdmin: !currentlyAdmin }),
      });
      await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      invalidate();
    } catch {
      Alert.alert('Could not update role', 'Something went wrong.');
    } finally {
      setTogglingId(null);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <View style={tr.center}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={tr.container}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        <RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />
      }
    >
      {/* ── Add by email (admins only) ─────────────────────────────────── */}
      {canManage && (
        <View style={tr.section}>
          <View style={tr.sectionHeader}>
            <Feather name="user-plus" size={14} color={colors.mutedForeground} />
            <Text style={[tr.sectionTitle, { color: colors.mutedForeground }]}>
              ADD TRAVELER
            </Text>
          </View>

          <View style={[tr.searchRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TextInput
              style={[tr.searchInput, { color: colors.foreground }]}
              value={email}
              onChangeText={(t) => {
                setEmail(t);
                setFoundUser(null);
                setLookupError('');
              }}
              placeholder="Search by email…"
              placeholderTextColor={colors.mutedForeground}
              keyboardType="email-address"
              autoCapitalize="none"
              returnKeyType="search"
              onSubmitEditing={handleSearch}
            />
            <TouchableOpacity
              onPress={handleSearch}
              disabled={isLooking || !email.trim()}
              hitSlop={8}
            >
              {isLooking ? (
                <ActivityIndicator size="small" color={colors.primary} />
              ) : (
                <Feather
                  name="search"
                  size={18}
                  color={email.trim() ? colors.primary : colors.mutedForeground}
                />
              )}
            </TouchableOpacity>
          </View>

          {/* Found user card */}
          {foundUser ? (
            <View
              style={[tr.foundCard, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={[tr.foundAvatar, { backgroundColor: colors.primary + '20' }]}>
                <Text style={[tr.foundInitials, { color: colors.primary }]}>
                  {foundUser.name.charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={tr.foundInfo}>
                <Text style={[tr.foundName, { color: colors.foreground }]}>{foundUser.name}</Text>
                <Text style={[tr.foundEmail, { color: colors.mutedForeground }]}>
                  {foundUser.email}
                </Text>
              </View>
              <TouchableOpacity
                style={[
                  tr.addBtn,
                  { backgroundColor: colors.primary },
                  isAdding && { opacity: 0.6 },
                ]}
                onPress={handleAdd}
                disabled={isAdding}
                activeOpacity={0.8}
              >
                {isAdding ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <Text style={tr.addBtnText}>Add</Text>
                )}
              </TouchableOpacity>
            </View>
          ) : lookupError ? (
            <Text style={[tr.lookupNote, { color: colors.mutedForeground }]}>{lookupError}</Text>
          ) : null}
        </View>
      )}

      {/* ── Traveler list ──────────────────────────────────────────────── */}
      <View style={tr.section}>
        <View style={tr.sectionHeader}>
          <Feather name="users" size={14} color={colors.mutedForeground} />
          <Text style={[tr.sectionTitle, { color: colors.mutedForeground }]}>
            TRAVELERS{participants?.length ? ` · ${participants.length}` : ''}
          </Text>
        </View>

        {participants && participants.length > 0 ? (
          <View style={[tr.list, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {(participants as any[]).map((p, i) => {
              const isTripAdminParticipant = !!p.isTripAdmin;
              const isLast = i === (participants as any[]).length - 1;
              const initials = p.name
                .split(' ')
                .map((w: string) => w[0])
                .slice(0, 2)
                .join('')
                .toUpperCase();

              return (
                <View
                  key={p.id}
                  style={[
                    tr.row,
                    !isLast && {
                      borderBottomWidth: StyleSheet.hairlineWidth,
                      borderBottomColor: colors.border,
                    },
                  ]}
                >
                  {/* Avatar */}
                  <View style={[tr.avatar, { backgroundColor: colors.primary + '20' }]}>
                    <Text style={[tr.avatarText, { color: colors.primary }]}>{initials}</Text>
                  </View>

                  {/* Name + email */}
                  <View style={tr.info}>
                    <View style={tr.nameRow}>
                      <Text style={[tr.name, { color: colors.foreground }]} numberOfLines={1}>
                        {p.name}
                      </Text>
                      {isTripAdminParticipant && (
                        <View style={[tr.adminBadge, { backgroundColor: '#F59E0B20' }]}>
                          <Feather name="star" size={9} color="#F59E0B" />
                          <Text style={[tr.adminBadgeText, { color: '#F59E0B' }]}>Admin</Text>
                        </View>
                      )}
                    </View>
                    <Text style={[tr.email, { color: colors.mutedForeground }]} numberOfLines={1}>
                      {p.email ?? `@${p.username}`}
                    </Text>
                  </View>

                  {/* Actions (admin only) */}
                  {canManage && (
                    <View style={tr.actions}>
                      {/* Promote / demote */}
                      <TouchableOpacity
                        onPress={() => handleToggleAdmin(p.id, isTripAdminParticipant)}
                        disabled={togglingId === p.id}
                        hitSlop={8}
                        style={tr.actionBtn}
                        accessibilityLabel={isTripAdminParticipant ? 'Remove admin role' : 'Make trip admin'}
                      >
                        {togglingId === p.id ? (
                          <ActivityIndicator size="small" color={colors.primary} />
                        ) : (
                          <Feather
                            name="star"
                            size={17}
                            color={isTripAdminParticipant ? '#F59E0B' : colors.mutedForeground}
                          />
                        )}
                      </TouchableOpacity>

                      {/* Remove */}
                      <TouchableOpacity
                        onPress={() => handleRemove(p.id, p.name)}
                        hitSlop={8}
                        style={tr.actionBtn}
                        accessibilityLabel="Remove traveler"
                      >
                        <Feather name="user-minus" size={17} color={colors.destructive} />
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })}
          </View>
        ) : (
          <Text style={[tr.empty, { color: colors.mutedForeground }]}>No travelers yet.</Text>
        )}
      </View>
    </ScrollView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const tr = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 16, gap: 16, paddingBottom: 32 },

  section: { gap: 10 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionTitle: {
    flex: 1, fontSize: 11, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8,
  },

  // Search row
  searchRow: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12, paddingVertical: 11, gap: 10,
  },
  searchInput: {
    flex: 1, fontSize: 14, fontFamily: 'Inter_400Regular', padding: 0, margin: 0,
  },

  // Found user
  foundCard: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 12, borderWidth: StyleSheet.hairlineWidth,
    padding: 12, gap: 12,
  },
  foundAvatar: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  foundInitials: { fontSize: 14, fontFamily: 'Inter_700Bold' },
  foundInfo: { flex: 1, gap: 2 },
  foundName: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  foundEmail: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  addBtn: {
    paddingHorizontal: 16, paddingVertical: 8,
    borderRadius: 8, minWidth: 56, alignItems: 'center',
  },
  addBtnText: { color: '#fff', fontSize: 13, fontFamily: 'Inter_600SemiBold' },
  lookupNote: { fontSize: 12, fontFamily: 'Inter_400Regular', paddingHorizontal: 2 },

  // Participant list
  list: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  row: {
    flexDirection: 'row', alignItems: 'center',
    gap: 12, paddingHorizontal: 14, paddingVertical: 12,
  },
  avatar: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  avatarText: { fontSize: 13, fontFamily: 'Inter_700Bold' },
  info: { flex: 1, gap: 2, minWidth: 0 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
  name: { fontSize: 14, fontFamily: 'Inter_600SemiBold', flexShrink: 1 },
  adminBadge: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6,
  },
  adminBadgeText: { fontSize: 10, fontFamily: 'Inter_600SemiBold' },
  email: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  actions: { flexDirection: 'row', alignItems: 'center', gap: 0, flexShrink: 0 },
  actionBtn: { padding: 8 },

  empty: {
    fontSize: 13, fontFamily: 'Inter_400Regular',
    textAlign: 'center', paddingVertical: 12,
  },
});
