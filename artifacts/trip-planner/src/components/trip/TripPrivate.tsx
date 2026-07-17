import {
  useListTripNotes, useCreateTripNote, useUpdateTripNote, useDeleteTripNote, getListTripNotesQueryKey,
  useListTravelDocuments, useCreateTravelDocument, useUpdateTravelDocument, useDeleteTravelDocument, getListTravelDocumentsQueryKey
} from '@workspace/api-client-react';
import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { StickyNote, Plus, Trash2, FileText, Globe, Lock, Users } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Badge } from '@/components/ui/badge';

// ─── Notes ────────────────────────────────────────────────────────────────────

export function TripNotes({ tripId }: { tripId: number }) {
  const { data: notes, isLoading } = useListTripNotes(tripId, { query: { enabled: !!tripId } });
  const queryClient = useQueryClient();
  const createNote = useCreateTripNote();
  const deleteNote = useDeleteTripNote();

  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);

  if (isLoading) return <div className="text-muted-foreground p-4">Loading notes…</div>;

  const myNotes = notes?.filter((n: any) => n.isMine !== false) ?? [];
  const sharedNotes = notes?.filter((n: any) => n.isMine === false) ?? [];

  const handleCreate = () => {
    createNote.mutate({ tripId, data: { title: 'New Note', content: '', isShared: false } }, {
      onSuccess: (newNote) => {
        queryClient.invalidateQueries({ queryKey: getListTripNotesQueryKey(tripId) });
        setActiveNoteId(newNote.id);
      }
    });
  };

  const handleDelete = (id: number) => {
    if (confirm('Delete this note?')) {
      deleteNote.mutate({ tripId, tripNoteId: id }, {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTripNotesQueryKey(tripId) });
          if (activeNoteId === id) setActiveNoteId(null);
        }
      });
    }
  };

  const activeNote = notes?.find((n: any) => n.id === activeNoteId);

  return (
    <div className="flex flex-col md:flex-row gap-6 min-h-[500px]">
      {/* Sidebar */}
      <div className="md:w-72 shrink-0 flex flex-col gap-4">
        <Button onClick={handleCreate} className="w-full shadow-sm">
          <Plus className="h-4 w-4 mr-2" /> New Note
        </Button>

        {/* My notes */}
        <div className="space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 mb-2">My Notes</p>
          {myNotes.map((note: any) => (
            <NoteListItem
              key={note.id}
              note={note}
              isActive={activeNoteId === note.id}
              onClick={() => setActiveNoteId(note.id)}
            />
          ))}
          {myNotes.length === 0 && (
            <p className="text-muted-foreground text-sm text-center py-3">No notes yet.</p>
          )}
        </div>

        {/* Shared by others */}
        {sharedNotes.length > 0 && (
          <div className="space-y-1 border-t pt-4">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1 mb-2 flex items-center gap-1.5">
              <Users className="h-3 w-3" /> Shared with group
            </p>
            {sharedNotes.map((note: any) => (
              <NoteListItem
                key={note.id}
                note={note}
                isActive={activeNoteId === note.id}
                onClick={() => setActiveNoteId(note.id)}
              />
            ))}
          </div>
        )}
      </div>

      {/* Editor / reader pane */}
      <div className="flex-1 bg-card border rounded-xl shadow-sm flex flex-col">
        {activeNote ? (
          (activeNote as any).isMine !== false ? (
            <NoteEditor
              tripId={tripId}
              note={activeNote}
              onDelete={() => handleDelete(activeNote.id)}
            />
          ) : (
            <SharedNoteViewer note={activeNote} />
          )
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8">
            <StickyNote className="h-12 w-12 mb-4 opacity-20" />
            <p>Select a note or create a new one.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function NoteListItem({ note, isActive, onClick }: { note: any; isActive: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left p-3 rounded-lg border transition-all ${
        isActive ? 'bg-primary/10 border-primary/50 text-primary' : 'bg-card hover:bg-muted/50 border-transparent hover:border-border'
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium truncate text-sm">{note.title || 'Untitled'}</div>
        {note.isMine !== false ? (
          note.isShared
            ? <Globe className="h-3 w-3 shrink-0 text-emerald-500" title="Shared with group" />
            : <Lock className="h-3 w-3 shrink-0 text-muted-foreground" title="Private" />
        ) : (
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 shrink-0">
            {note.authorName?.split(' ')[0] ?? 'Teammate'}
          </Badge>
        )}
      </div>
      <div className="text-xs text-muted-foreground mt-1 truncate">{note.content || 'No content…'}</div>
    </button>
  );
}

function SharedNoteViewer({ note }: { note: any }) {
  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b flex items-center gap-3">
        <div className="flex-1">
          <p className="text-lg font-serif font-bold">{note.title || 'Untitled'}</p>
          <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
            <Users className="h-3 w-3" /> Shared by {note.authorName ?? 'a teammate'}
          </p>
        </div>
        <Badge variant="secondary" className="flex items-center gap-1 shrink-0">
          <Globe className="h-3 w-3 text-emerald-500" /> Shared
        </Badge>
      </div>
      <div className="flex-1 p-6 text-muted-foreground whitespace-pre-wrap">{note.content || <em>No content.</em>}</div>
    </div>
  );
}

function NoteEditor({ tripId, note, onDelete }: { tripId: number; note: any; onDelete: () => void }) {
  const queryClient = useQueryClient();
  const updateNote = useUpdateTripNote();
  const [title, setTitle] = useState(note.title || '');
  const [content, setContent] = useState(note.content || '');
  const [isShared, setIsShared] = useState<boolean>(!!note.isShared);

  useEffect(() => {
    setTitle(note.title || '');
    setContent(note.content || '');
    setIsShared(!!note.isShared);
  }, [note.id]);

  const mutateFnRef = useRef(updateNote.mutate);
  mutateFnRef.current = updateNote.mutate;

  const save = useCallback((t: string, c: string, s: boolean) => {
    mutateFnRef.current({ tripId, tripNoteId: note.id, data: { title: t, content: c, isShared: s } }, {
      onSuccess: () => {
        queryClient.setQueryData(getListTripNotesQueryKey(tripId), (old: any) => {
          if (!old) return old;
          return old.map((n: any) => n.id === note.id ? { ...n, title: t, content: c, isShared: s } : n);
        });
      }
    });
  }, [tripId, note.id, queryClient]);

  // Debounced save for content/title changes
  useEffect(() => {
    const timer = setTimeout(() => {
      if (title !== note.title || content !== note.content) {
        save(title, content, isShared);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [title, content, note.title, note.content, isShared, save]);

  const toggleShare = () => {
    const next = !isShared;
    setIsShared(next);
    save(title, content, next);
    toast.success(next ? 'Note shared with the group' : 'Note set to private');
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b flex items-center justify-between gap-4">
        <Input
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="text-lg font-serif font-bold border-transparent bg-transparent hover:bg-muted/50 focus-visible:bg-muted/50 px-2 h-auto py-1"
          placeholder="Note Title"
        />
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant={isShared ? 'default' : 'outline'}
            size="sm"
            onClick={toggleShare}
            className={isShared ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : ''}
            title={isShared ? 'Visible to all travelers — click to make private' : 'Only you can see this — click to share'}
          >
            {isShared ? <Globe className="h-3.5 w-3.5 mr-1.5" /> : <Lock className="h-3.5 w-3.5 mr-1.5" />}
            {isShared ? 'Shared' : 'Private'}
          </Button>
          <Button variant="ghost" size="icon" onClick={onDelete} className="text-destructive hover:text-destructive">
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <Textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        className="flex-1 resize-none border-0 focus-visible:ring-0 rounded-none p-6 min-h-[400px]"
        placeholder="Write your notes here… (auto-saved)"
      />
    </div>
  );
}

// ─── Documents ────────────────────────────────────────────────────────────────

export function TripDocuments({ tripId }: { tripId: number }) {
  const { data: docs, isLoading } = useListTravelDocuments(tripId, { query: { enabled: !!tripId } });
  const queryClient = useQueryClient();
  const createDoc = useCreateTravelDocument();
  const updateDoc = useUpdateTravelDocument();
  const deleteDoc = useDeleteTravelDocument();

  if (isLoading) return <div className="text-muted-foreground p-4">Loading documents…</div>;

  const myDocs = docs?.filter((d: any) => d.isMine !== false) ?? [];
  const sharedDocs = docs?.filter((d: any) => d.isMine === false) ?? [];

  const handleAdd = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const data = {
      type: fd.get('type') as any,
      number: fd.get('number') as string,
      expiryDate: fd.get('expiryDate') as string || undefined,
      notes: fd.get('notes') as string || undefined,
      isShared: false,
    };
    createDoc.mutate({ tripId, data }, {
      onSuccess: () => {
        toast.success('Document added');
        queryClient.invalidateQueries({ queryKey: getListTravelDocumentsQueryKey(tripId) });
        (e.target as HTMLFormElement).reset();
      }
    });
  };

  const toggleShare = (doc: any) => {
    const next = !doc.isShared;
    updateDoc.mutate(
      { tripId, travelDocumentId: doc.id, data: { isShared: next } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTravelDocumentsQueryKey(tripId) });
          toast.success(next ? 'Document shared with the group' : 'Document set to private');
        }
      }
    );
  };

  return (
    <div className="max-w-3xl space-y-8">
      {/* Add document form */}
      <div className="bg-card border p-6 rounded-xl shadow-sm">
        <h3 className="font-serif font-bold text-xl mb-4">Add Document</h3>
        <form onSubmit={handleAdd} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Type</label>
              <select name="type" className="flex h-10 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
                <option value="passport">Passport</option>
                <option value="visa">Visa</option>
                <option value="insurance">Insurance</option>
                <option value="id_card">ID Card</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Document Number</label>
              <Input name="number" required placeholder="XYZ12345" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Expiry Date</label>
              <Input name="expiryDate" type="date" />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Notes</label>
              <Input name="notes" placeholder="Optional notes" />
            </div>
          </div>
          <Button type="submit" disabled={createDoc.isPending}>Add Document</Button>
        </form>
      </div>

      {/* My documents */}
      {myDocs.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">My Documents</h3>
          {myDocs.map((doc: any) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
              onToggleShare={() => toggleShare(doc)}
              onDelete={() => {
                if (confirm('Delete document?')) {
                  deleteDoc.mutate({ tripId, travelDocumentId: doc.id }, {
                    onSuccess: () => queryClient.invalidateQueries({ queryKey: getListTravelDocumentsQueryKey(tripId) })
                  });
                }
              }}
            />
          ))}
        </div>
      )}

      {myDocs.length === 0 && sharedDocs.length === 0 && (
        <p className="text-muted-foreground text-center py-8">No documents added yet.</p>
      )}

      {/* Shared by others */}
      {sharedDocs.length > 0 && (
        <div className="space-y-3">
          <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider flex items-center gap-2">
            <Users className="h-4 w-4" /> Shared with group
          </h3>
          {sharedDocs.map((doc: any) => (
            <DocumentCard key={doc.id} doc={doc} readOnly />
          ))}
        </div>
      )}
    </div>
  );
}

function DocumentCard({
  doc,
  readOnly = false,
  onToggleShare,
  onDelete,
}: {
  doc: any;
  readOnly?: boolean;
  onToggleShare?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="bg-card border rounded-xl p-5 shadow-sm flex items-center justify-between gap-4">
      <div className="flex items-center gap-4 min-w-0">
        <div className="h-10 w-10 bg-primary/10 rounded-full flex items-center justify-center shrink-0">
          <FileText className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="font-semibold uppercase tracking-wider text-sm">{doc.type.replace('_', ' ')}</h4>
            {!readOnly && (
              doc.isShared
                ? <Badge variant="secondary" className="text-[10px] px-1.5 py-0 flex items-center gap-1"><Globe className="h-2.5 w-2.5 text-emerald-500" />Shared</Badge>
                : <Badge variant="outline" className="text-[10px] px-1.5 py-0 flex items-center gap-1"><Lock className="h-2.5 w-2.5" />Private</Badge>
            )}
            {readOnly && doc.authorName && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0">{doc.authorName}</Badge>
            )}
          </div>
          <p className="font-mono text-muted-foreground text-sm mt-0.5">{doc.number}</p>
          {doc.notes && <p className="text-xs text-muted-foreground mt-1 truncate">{doc.notes}</p>}
        </div>
      </div>

      <div className="flex items-center gap-3 shrink-0">
        {doc.expiryDate && (
          <div className="text-right hidden sm:block">
            <span className="text-xs text-muted-foreground block mb-0.5">Expires</span>
            <span className="text-sm font-medium">{format(parseISO(doc.expiryDate), 'MMM d, yyyy')}</span>
          </div>
        )}
        {!readOnly && (
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={onToggleShare}
              className={doc.isShared ? 'text-emerald-600 hover:text-emerald-700' : 'text-muted-foreground'}
              title={doc.isShared ? 'Shared — click to make private' : 'Private — click to share with group'}
            >
              {doc.isShared ? <Globe className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={onDelete}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
