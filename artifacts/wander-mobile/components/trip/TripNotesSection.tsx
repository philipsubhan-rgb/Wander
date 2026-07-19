import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  ActivityIndicator, TextInput, Alert, KeyboardAvoidingView, Platform, Modal,
} from 'react-native';
import { Feather } from '@expo/vector-icons';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import {
  useListTripNotes, useCreateTripNote, useUpdateTripNote, useDeleteTripNote, getListTripNotesQueryKey,
  useListTravelDocuments, useCreateTravelDocument, useDeleteTravelDocument, getListTravelDocumentsQueryKey,
} from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { FieldLabel, FormInput, formStyles } from './TripFlightsSection';

// ── Notes ─────────────────────────────────────────────────────────────────────

function NoteEditor({ tripId, note, onClose, colors }: {
  tripId: number; note: any; onClose: () => void; colors: ReturnType<typeof useColors>;
}) {
  const queryClient = useQueryClient();
  const { mutate: updateNote } = useUpdateTripNote();
  const { mutate: deleteNote } = useDeleteTripNote();
  const [title, setTitle] = useState(note.title ?? '');
  const [content, setContent] = useState(note.content ?? '');
  const saveRef = useRef(updateNote);
  saveRef.current = updateNote;

  const save = useCallback((t: string, c: string) => {
    saveRef.current({ tripId, tripNoteId: note.id, data: { title: t, content: c, isShared: false } }, {
      onSuccess: () => queryClient.setQueryData(getListTripNotesQueryKey(tripId), (old: any) => {
        if (!old) return old;
        return old.map((n: any) => n.id === note.id ? { ...n, title: t, content: c } : n);
      }),
    });
  }, [tripId, note.id, queryClient]);

  // Debounced auto-save
  useEffect(() => {
    const timer = setTimeout(() => {
      if (title !== note.title || content !== note.content) {
        save(title, content);
      }
    }, 1200);
    return () => clearTimeout(timer);
  }, [title, content]);

  function handleDelete() {
    Alert.alert('Delete Note', 'Delete this note?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: () => {
          deleteNote({ tripId, tripNoteId: note.id }, {
            onSuccess: () => {
              queryClient.invalidateQueries({ queryKey: getListTripNotesQueryKey(tripId) });
              onClose();
            },
          });
        },
      },
    ]);
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[ne.container, { backgroundColor: colors.background }]}>
          <View style={[ne.header, { borderBottomColor: colors.border }]}>
            <TouchableOpacity onPress={onClose} hitSlop={8}>
              <Feather name="chevron-left" size={22} color={colors.primary} />
            </TouchableOpacity>
            <Text style={[ne.headerTitle, { color: colors.mutedForeground }]}>auto-saved</Text>
            <TouchableOpacity onPress={handleDelete} hitSlop={8}>
              <Feather name="trash-2" size={18} color={colors.destructive} />
            </TouchableOpacity>
          </View>
          <TextInput
            style={[ne.titleInput, { color: colors.foreground, borderBottomColor: colors.border }]}
            value={title}
            onChangeText={setTitle}
            placeholder="Note Title"
            placeholderTextColor={colors.mutedForeground}
          />
          <TextInput
            style={[ne.contentInput, { color: colors.foreground }]}
            value={content}
            onChangeText={setContent}
            placeholder="Write your notes here…"
            placeholderTextColor={colors.mutedForeground}
            multiline
            textAlignVertical="top"
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const ne = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: 13, fontFamily: 'Inter_400Regular' },
  titleInput: {
    fontSize: 22, fontFamily: 'Inter_700Bold', paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contentInput: { flex: 1, fontSize: 15, fontFamily: 'Inter_400Regular', padding: 16, lineHeight: 24 },
});

// ── Documents ─────────────────────────────────────────────────────────────────

const DOC_TYPES = ['passport', 'visa', 'insurance', 'id_card', 'other'] as const;
type DocType = typeof DOC_TYPES[number];

const DOC_ICONS: Record<DocType, keyof typeof Feather.glyphMap> = {
  passport: 'book-open', visa: 'globe', insurance: 'shield', id_card: 'credit-card', other: 'file-text',
};

function AddDocModal({ tripId, visible, onClose, colors }: {
  tripId: number; visible: boolean; onClose: () => void; colors: ReturnType<typeof useColors>;
}) {
  const queryClient = useQueryClient();
  const { mutate: createDoc, isPending } = useCreateTravelDocument({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTravelDocumentsQueryKey(tripId) });
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        onClose(); reset();
      },
      onError: () => Alert.alert('Error', 'Failed to add document'),
    },
  });

  const [type, setType] = useState<DocType>('passport');
  const [number, setNumber] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [notes, setNotes] = useState('');

  function reset() { setType('passport'); setNumber(''); setExpiryDate(''); setNotes(''); }

  function handleSubmit() {
    if (!number.trim()) { Alert.alert('Missing field', 'Document number is required.'); return; }
    createDoc({
      tripId,
      data: {
        type,
        number: number.trim(),
        expiryDate: expiryDate.trim() || undefined,
        notes: notes.trim() || undefined,
        isShared: false,
      },
    });
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={{ flex: 1 }}>
        <View style={[formStyles.container, { backgroundColor: colors.background }]}>
          <View style={[formStyles.header, { borderBottomColor: colors.border }]}>
            <Text style={[formStyles.title, { color: colors.foreground }]}>Add Document</Text>
            <TouchableOpacity onPress={() => { onClose(); reset(); }} hitSlop={8}>
              <Feather name="x" size={22} color={colors.mutedForeground} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={formStyles.body} keyboardShouldPersistTaps="handled">
            <FieldLabel label="Type" colors={colors} />
            <View style={formStyles.chips}>
              {DOC_TYPES.map((t) => (
                <TouchableOpacity key={t} style={[formStyles.chip, { backgroundColor: type === t ? colors.primary : colors.card, borderColor: type === t ? colors.primary : colors.border }]} onPress={() => setType(t)}>
                  <Text style={[formStyles.chipText, { color: type === t ? '#fff' : colors.foreground }]}>{t.replace('_', ' ')}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <FieldLabel label="Document Number" colors={colors} />
            <FormInput value={number} onChangeText={setNumber} placeholder="XYZ12345" colors={colors} autoCapitalize="characters" />
            <FieldLabel label="Expiry Date (optional, YYYY-MM-DD)" colors={colors} />
            <FormInput value={expiryDate} onChangeText={setExpiryDate} placeholder="2030-01-01" colors={colors} autoCapitalize="none" />
            <FieldLabel label="Notes (optional)" colors={colors} />
            <FormInput value={notes} onChangeText={setNotes} placeholder="Any notes about this document" colors={colors} multiline />
            <TouchableOpacity style={[formStyles.submit, { backgroundColor: isPending ? colors.muted : colors.primary }]} onPress={handleSubmit} disabled={isPending}>
              {isPending ? <ActivityIndicator color="#fff" /> : <Text style={formStyles.submitText}>Add Document</Text>}
            </TouchableOpacity>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ── Combined Notes + Documents screen ─────────────────────────────────────────

export function TripNotesSection({ tripId }: { tripId: number }) {
  const colors = useColors();
  const queryClient = useQueryClient();
  const [activeNote, setActiveNote] = useState<any>(null);
  const [showAddDoc, setShowAddDoc] = useState(false);
  const [subTab, setSubTab] = useState<'notes' | 'documents'>('notes');

  const { data: notes, isLoading: notesLoading } = useListTripNotes(tripId, { query: { enabled: !!tripId } });
  const { data: docs, isLoading: docsLoading } = useListTravelDocuments(tripId, { query: { enabled: !!tripId } });
  const { mutate: createNote, isPending: isCreating } = useCreateTripNote();
  const { mutate: deleteDoc } = useDeleteTravelDocument();

  function handleCreateNote() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    createNote({ tripId, data: { title: 'New Note', content: '', isShared: false } }, {
      onSuccess: (newNote) => {
        queryClient.invalidateQueries({ queryKey: getListTripNotesQueryKey(tripId) });
        setActiveNote(newNote);
      },
    });
  }

  function handleDeleteDoc(id: number) {
    Alert.alert('Delete Document?', undefined, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteDoc({ tripId, travelDocumentId: id }, { onSuccess: () => queryClient.invalidateQueries({ queryKey: getListTravelDocumentsQueryKey(tripId) }) }) },
    ]);
  }

  return (
    <>
      {/* Sub-tab */}
      <View style={[ns.subTabRow, { backgroundColor: colors.muted, borderColor: colors.border }]}>
        {(['notes', 'documents'] as const).map((t) => (
          <TouchableOpacity
            key={t}
            style={[ns.subTabBtn, subTab === t && { backgroundColor: colors.card }]}
            onPress={() => setSubTab(t)}
          >
            <Feather name={t === 'notes' ? 'edit-3' : 'file-text'} size={13} color={subTab === t ? colors.primary : colors.mutedForeground} />
            <Text style={[ns.subTabLabel, { color: subTab === t ? colors.primary : colors.mutedForeground }, subTab === t && { fontFamily: 'Inter_600SemiBold' }]}>
              {t === 'notes' ? 'Notes' : 'Documents'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {subTab === 'notes' ? (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={ns.list}>
          <TouchableOpacity
            style={[ns.addBtn, { backgroundColor: isCreating ? colors.muted : colors.primary }]}
            onPress={handleCreateNote}
            disabled={isCreating}
          >
            {isCreating ? <ActivityIndicator color="#fff" size="small" /> : <Feather name="plus" size={16} color="#fff" />}
            <Text style={ns.addBtnText}>New Note</Text>
          </TouchableOpacity>

          {notesLoading ? <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} /> : null}

          {notes && (notes as any[]).length > 0 ? (
            (notes as any[]).map((note: any) => (
              <TouchableOpacity
                key={note.id}
                style={[ns.noteCard, { backgroundColor: colors.card, borderColor: colors.border }]}
                onPress={() => setActiveNote(note)}
                activeOpacity={0.7}
              >
                <Text style={[ns.noteTitle, { color: colors.foreground }]} numberOfLines={1}>{note.title || 'Untitled'}</Text>
                <Text style={[ns.notePreview, { color: colors.mutedForeground }]} numberOfLines={2}>{note.content || 'No content…'}</Text>
                <Feather name="chevron-right" size={14} color={colors.mutedForeground} style={ns.noteArrow} />
              </TouchableOpacity>
            ))
          ) : !notesLoading ? (
            <View style={[ns.empty, { borderColor: colors.border }]}>
              <Feather name="edit-3" size={28} color={colors.mutedForeground} />
              <Text style={[ns.emptyText, { color: colors.mutedForeground }]}>No notes yet. Create one above.</Text>
            </View>
          ) : null}
        </ScrollView>
      ) : (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={ns.list}>
          <TouchableOpacity style={[ns.addBtn, { backgroundColor: colors.primary }]} onPress={() => setShowAddDoc(true)}>
            <Feather name="plus" size={16} color="#fff" />
            <Text style={ns.addBtnText}>Add Document</Text>
          </TouchableOpacity>

          {docsLoading ? <ActivityIndicator color={colors.primary} style={{ marginTop: 24 }} /> : null}

          {docs && (docs as any[]).length > 0 ? (
            (docs as any[]).map((doc: any) => (
              <View key={doc.id} style={[ns.docCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <View style={[ns.docIcon, { backgroundColor: colors.primary + '18' }]}>
                  <Feather name={DOC_ICONS[(doc.type as DocType)] ?? 'file-text'} size={16} color={colors.primary} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={[ns.docType, { color: colors.mutedForeground }]}>{(doc.type as string).replace('_', ' ').toUpperCase()}</Text>
                  <Text style={[ns.docNumber, { color: colors.foreground }]}>{doc.number}</Text>
                  {doc.expiryDate ? (
                    <Text style={[ns.docExpiry, { color: colors.mutedForeground }]}>Expires: {new Date(doc.expiryDate).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</Text>
                  ) : null}
                  {doc.notes ? <Text style={[ns.docNotes, { color: colors.mutedForeground }]} numberOfLines={1}>{doc.notes}</Text> : null}
                </View>
                <TouchableOpacity onPress={() => handleDeleteDoc(doc.id)} hitSlop={8}>
                  <Feather name="trash-2" size={14} color={colors.mutedForeground} />
                </TouchableOpacity>
              </View>
            ))
          ) : !docsLoading ? (
            <View style={[ns.empty, { borderColor: colors.border }]}>
              <Feather name="file-text" size={28} color={colors.mutedForeground} />
              <Text style={[ns.emptyText, { color: colors.mutedForeground }]}>No documents yet. Add one above.</Text>
            </View>
          ) : null}
        </ScrollView>
      )}

      {activeNote ? (
        <NoteEditor
          tripId={tripId}
          note={activeNote}
          onClose={() => { setActiveNote(null); queryClient.invalidateQueries({ queryKey: getListTripNotesQueryKey(tripId) }); }}
          colors={colors}
        />
      ) : null}

      <AddDocModal tripId={tripId} visible={showAddDoc} onClose={() => setShowAddDoc(false)} colors={colors} />
    </>
  );
}

const ns = StyleSheet.create({
  subTabRow: { flexDirection: 'row', margin: 12, borderRadius: 10, padding: 3, gap: 2, borderWidth: StyleSheet.hairlineWidth },
  subTabBtn: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingVertical: 8, borderRadius: 8 },
  subTabLabel: { fontSize: 13, fontFamily: 'Inter_500Medium' },
  list: { padding: 12, gap: 10, paddingBottom: 32 },
  addBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12, borderRadius: 12 },
  addBtnText: { color: '#fff', fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  noteCard: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 4, position: 'relative' },
  noteTitle: { fontSize: 15, fontFamily: 'Inter_600SemiBold', paddingRight: 20 },
  notePreview: { fontSize: 13, fontFamily: 'Inter_400Regular', lineHeight: 18 },
  noteArrow: { position: 'absolute', right: 12, top: '50%' as any },
  docCard: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 12 },
  docIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  docType: { fontSize: 10, fontFamily: 'Inter_600SemiBold', letterSpacing: 0.5, marginBottom: 2 },
  docNumber: { fontSize: 15, fontFamily: 'Inter_600SemiBold' },
  docExpiry: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  docNotes: { fontSize: 12, fontFamily: 'Inter_400Regular', marginTop: 2 },
  empty: { borderRadius: 12, borderWidth: 1, borderStyle: 'dashed', paddingVertical: 40, alignItems: 'center', gap: 8 },
  emptyText: { fontSize: 14, fontFamily: 'Inter_400Regular', textAlign: 'center' },
});
