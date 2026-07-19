import React, { useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, TextInput, Alert, RefreshControl,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useListPackingItems, useCreatePackingItem, useUpdatePackingItem, useDeletePackingItem,
  getListPackingItemsQueryKey,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { useAuth } from '@/context/AuthContext';

export function TripPackingSection({ tripId }: { tripId: number }) {
  const colors = useColors();
  const { user } = useAuth();
  const isAdmin = (user as any)?.role === 'admin';
  const queryClient = useQueryClient();
  const [newTemplateItem, setNewTemplateItem] = useState('');
  const [newPersonalItem, setNewPersonalItem] = useState('');

  const { data: items, isLoading, refetch, isRefetching } = useListPackingItems(tripId, { query: { enabled: !!tripId } });
  const { mutate: createItem, isPending: isCreating } = useCreatePackingItem();
  const { mutate: updateItem } = useUpdatePackingItem();
  const { mutate: deleteItem } = useDeletePackingItem();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListPackingItemsQueryKey(tripId) });

  const templateItems = (items as any[])?.filter((i: any) => i.isTemplate) ?? [];
  const personalItems = (items as any[])?.filter((i: any) => !i.isTemplate) ?? [];

  const allChecked = [...templateItems, ...personalItems].filter((i: any) => i.checked).length;
  const allTotal = [...templateItems, ...personalItems].length;
  const progress = allTotal === 0 ? 0 : Math.round((allChecked / allTotal) * 100);

  function handleToggle(item: any) {
    Haptics.selectionAsync();
    updateItem({ tripId, packingItemId: item.id, data: { checked: !item.checked } }, { onSuccess: invalidate });
  }

  function handleDelete(id: number) {
    Alert.alert('Remove item?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => deleteItem({ tripId, packingItemId: id }, { onSuccess: invalidate }) },
    ]);
  }

  function addTemplate() {
    if (!newTemplateItem.trim()) return;
    (createItem as any).mutate(
      { tripId, data: { name: newTemplateItem.trim(), category: 'General', checked: false, isTemplate: true } },
      { onSuccess: () => { setNewTemplateItem(''); invalidate(); } }
    );
  }

  function addPersonal() {
    if (!newPersonalItem.trim()) return;
    createItem(
      { tripId, data: { name: newPersonalItem.trim(), category: 'General', checked: false } },
      { onSuccess: () => { setNewPersonalItem(''); invalidate(); } }
    );
  }

  if (isLoading) return <View style={pk.center}><ActivityIndicator color={colors.primary} /></View>;

  return (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={pk.container}
      refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={refetch} tintColor={colors.primary} />}
    >
      {/* Progress card */}
      <View style={[pk.progressCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={pk.progressHeader}>
          <Text style={[pk.progressTitle, { color: colors.foreground }]}>Packing Progress</Text>
          <Text style={[pk.progressPct, { color: colors.primary }]}>{progress}% Packed</Text>
        </View>
        <View style={[pk.progressBar, { backgroundColor: colors.muted }]}>
          <View style={[pk.progressFill, { width: `${progress}%` as any, backgroundColor: colors.primary }]} />
        </View>
        <Text style={[pk.progressSub, { color: colors.mutedForeground }]}>{allChecked} of {allTotal} items packed</Text>
      </View>

      {/* Trip list (template items) */}
      <View style={pk.section}>
        <View style={pk.sectionHeader}>
          <Feather name="users" size={14} color={colors.mutedForeground} />
          <Text style={[pk.sectionTitle, { color: colors.mutedForeground }]}>TRIP PACKING LIST</Text>
          <Text style={[pk.sectionCount, { color: colors.mutedForeground }]}>
            {templateItems.filter((i: any) => i.checked).length}/{templateItems.length}
          </Text>
        </View>

        {isAdmin && (
          <View style={[pk.addRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <TextInput
              style={[pk.addInput, { color: colors.foreground }]}
              value={newTemplateItem}
              onChangeText={setNewTemplateItem}
              placeholder="Add to everyone's list…"
              placeholderTextColor={colors.mutedForeground}
              returnKeyType="done"
              onSubmitEditing={addTemplate}
            />
            <TouchableOpacity onPress={addTemplate} disabled={isCreating || !newTemplateItem.trim()} hitSlop={8}>
              <Feather name="plus-circle" size={22} color={newTemplateItem.trim() ? colors.primary : colors.mutedForeground} />
            </TouchableOpacity>
          </View>
        )}

        {templateItems.length > 0 ? (
          <View style={[pk.itemsList, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {templateItems.map((item: any, i: number) => (
              <PackingItem
                key={item.id}
                item={item}
                colors={colors}
                canDelete={isAdmin}
                onToggle={() => handleToggle(item)}
                onDelete={() => handleDelete(item.id)}
                isLast={i === templateItems.length - 1}
              />
            ))}
          </View>
        ) : (
          <Text style={[pk.emptyNote, { color: colors.mutedForeground }]}>
            {isAdmin ? 'No shared items yet — add above to give everyone a checklist.' : 'No shared packing items yet.'}
          </Text>
        )}
      </View>

      {/* My items */}
      <View style={pk.section}>
        <View style={pk.sectionHeader}>
          <Feather name="user" size={14} color={colors.mutedForeground} />
          <Text style={[pk.sectionTitle, { color: colors.mutedForeground }]}>MY ITEMS</Text>
          <Text style={[pk.sectionCount, { color: colors.mutedForeground }]}>
            {personalItems.filter((i: any) => i.checked).length}/{personalItems.length}
          </Text>
        </View>

        <View style={[pk.addRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <TextInput
            style={[pk.addInput, { color: colors.foreground }]}
            value={newPersonalItem}
            onChangeText={setNewPersonalItem}
            placeholder="Add a personal item…"
            placeholderTextColor={colors.mutedForeground}
            returnKeyType="done"
            onSubmitEditing={addPersonal}
          />
          <TouchableOpacity onPress={addPersonal} disabled={isCreating || !newPersonalItem.trim()} hitSlop={8}>
            <Feather name="plus-circle" size={22} color={newPersonalItem.trim() ? colors.primary : colors.mutedForeground} />
          </TouchableOpacity>
        </View>

        {personalItems.length > 0 ? (
          <View style={[pk.itemsList, { backgroundColor: colors.card, borderColor: colors.border }]}>
            {personalItems.map((item: any, i: number) => (
              <PackingItem
                key={item.id}
                item={item}
                colors={colors}
                canDelete
                onToggle={() => handleToggle(item)}
                onDelete={() => handleDelete(item.id)}
                isLast={i === personalItems.length - 1}
              />
            ))}
          </View>
        ) : (
          <Text style={[pk.emptyNote, { color: colors.mutedForeground }]}>No personal items yet.</Text>
        )}
      </View>
    </ScrollView>
  );
}

function PackingItem({ item, colors, canDelete, onToggle, onDelete, isLast }: {
  item: any; colors: ReturnType<typeof useColors>; canDelete: boolean;
  onToggle: () => void; onDelete: () => void; isLast: boolean;
}) {
  return (
    <View style={[pk.item, !isLast && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}>
      <TouchableOpacity onPress={onToggle} style={[pk.checkbox, { borderColor: item.checked ? colors.primary : colors.border, backgroundColor: item.checked ? colors.primary : 'transparent' }]}>
        {item.checked ? <Feather name="check" size={12} color="#fff" /> : null}
      </TouchableOpacity>
      <Text style={[pk.itemName, { color: item.checked ? colors.mutedForeground : colors.foreground, textDecorationLine: item.checked ? 'line-through' : 'none' }]}>
        {item.name}
      </Text>
      {canDelete ? (
        <TouchableOpacity onPress={onDelete} hitSlop={8}>
          <Feather name="trash-2" size={14} color={colors.mutedForeground} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const pk = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  container: { padding: 16, gap: 16, paddingBottom: 32 },
  progressCard: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 16, gap: 10 },
  progressHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  progressTitle: { fontSize: 15, fontFamily: 'Inter_700Bold' },
  progressPct: { fontSize: 14, fontFamily: 'Inter_600SemiBold' },
  progressBar: { height: 8, borderRadius: 4, overflow: 'hidden' },
  progressFill: { height: 8, borderRadius: 4 },
  progressSub: { fontSize: 12, fontFamily: 'Inter_400Regular' },
  section: { gap: 10 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  sectionTitle: { flex: 1, fontSize: 11, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.8 },
  sectionCount: { fontSize: 11, fontFamily: 'Inter_500Medium' },
  addRow: { flexDirection: 'row', alignItems: 'center', borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingVertical: 10, gap: 10 },
  addInput: { flex: 1, fontSize: 14, fontFamily: 'Inter_400Regular', padding: 0, margin: 0 },
  itemsList: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 14 },
  checkbox: { width: 20, height: 20, borderRadius: 6, borderWidth: 1.5, alignItems: 'center', justifyContent: 'center' },
  itemName: { flex: 1, fontSize: 14, fontFamily: 'Inter_500Medium' },
  emptyNote: { fontSize: 13, fontFamily: 'Inter_400Regular', textAlign: 'center', paddingVertical: 12 },
});
