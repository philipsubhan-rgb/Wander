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
import { StickyNote, Plus, Trash2, FileText } from 'lucide-react';
import { format, parseISO } from 'date-fns';

// ─── Notes ────────────────────────────────────────────────────────────────────

export function TripNotes({ tripId }: { tripId: number }) {
  const { data: notes, isLoading } = useListTripNotes(tripId, { query: { enabled: !!tripId } });
  const queryClient = useQueryClient();
  const createNote = useCreateTripNote();
  const deleteNote = useDeleteTripNote();

  const [activeNoteId, setActiveNoteId] = useState<number | null>(null);

  if (isLoading) return <div className="text-muted-foreground p-4">Loading notes…</div>;

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

        <div className="space-y-1">
          {notes?.map((note: any) => (
            <NoteListItem
              key={note.id}
              note={note}
              isActive={activeNoteId === note.id}
              onClick={() => setActiveNoteId(note.id)}
            />
          ))}
          {(!notes || notes.length === 0) && (
            <p className="text-muted-foreground text-sm text-center py-3">No notes yet.</p>
          )}
        </div>
      </div>

      {/* Editor pane */}
      <div className="flex-1 bg-card border rounded-xl shadow-sm flex flex-col">
        {activeNote ? (
          <NoteEditor
            tripId={tripId}
            note={activeNote}
            onDelete={() => handleDelete(activeNote.id)}
          />
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
      <div className="font-medium truncate text-sm">{note.title || 'Untitled'}</div>
      <div className="text-xs text-muted-foreground mt-1 truncate">{note.content || 'No content…'}</div>
    </button>
  );
}

function NoteEditor({ tripId, note, onDelete }: { tripId: number; note: any; onDelete: () => void }) {
  const queryClient = useQueryClient();
  const updateNote = useUpdateTripNote();
  const [title, setTitle] = useState(note.title || '');
  const [content, setContent] = useState(note.content || '');

  useEffect(() => {
    setTitle(note.title || '');
    setContent(note.content || '');
  }, [note.id]);

  const mutateFnRef = useRef(updateNote.mutate);
  mutateFnRef.current = updateNote.mutate;

  const save = useCallback((t: string, c: string) => {
    mutateFnRef.current({ tripId, tripNoteId: note.id, data: { title: t, content: c, isShared: false } }, {
      onSuccess: () => {
        queryClient.setQueryData(getListTripNotesQueryKey(tripId), (old: any) => {
          if (!old) return old;
          return old.map((n: any) => n.id === note.id ? { ...n, title: t, content: c } : n);
        });
      }
    });
  }, [tripId, note.id, queryClient]);

  // Debounced save for content/title changes
  useEffect(() => {
    const timer = setTimeout(() => {
      if (title !== note.title || content !== note.content) {
        save(title, content);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [title, content, note.title, note.content, save]);

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b flex items-center justify-between gap-4">
        <Input
          value={title}
          onChange={e => setTitle(e.target.value)}
          className="text-lg font-serif font-bold border-transparent bg-transparent hover:bg-muted/50 focus-visible:bg-muted/50 px-2 h-auto py-1"
          placeholder="Note Title"
        />
        <Button variant="ghost" size="icon" onClick={onDelete} className="text-destructive hover:text-destructive shrink-0">
          <Trash2 className="h-4 w-4" />
        </Button>
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
  const deleteDoc = useDeleteTravelDocument();

  if (isLoading) return <div className="text-muted-foreground p-4">Loading documents…</div>;

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
      {docs && docs.length > 0 ? (
        <div className="space-y-3">
          <h3 className="font-semibold text-sm text-muted-foreground uppercase tracking-wider">My Documents</h3>
          {docs.map((doc: any) => (
            <DocumentCard
              key={doc.id}
              doc={doc}
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
      ) : (
        <p className="text-muted-foreground text-center py-8">No documents added yet.</p>
      )}
    </div>
  );
}

function DocumentCard({
  doc,
  onDelete,
}: {
  doc: any;
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
        {onDelete && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onDelete}
            className="text-destructive hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
