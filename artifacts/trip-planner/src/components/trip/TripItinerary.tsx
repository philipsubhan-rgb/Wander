import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { format, parseISO, addDays } from 'date-fns';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ChevronDown, ChevronUp, Plane, Home, Compass, Car, Calendar,
  MapPin, Star, Pencil, Plus, CheckCircle2, BookMarked, Lightbulb, UtensilsCrossed,
  ArrowRightLeft, GripVertical,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import {
  useGetTripTimeline,
  useListItineraryDays,
  useCreateItineraryDay,
  useUpdateItineraryDay,
  getListItineraryDaysQueryKey,
  getGetTripTimelineQueryKey,
} from '@workspace/api-client-react';
import { fetchWikiImage } from '@/lib/wiki-image';
import { getTransitionIndices } from '@/lib/itinerary-transitions';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  tripId: number;
  editMode?: boolean;
  tripStartDate?: string;
  tripEndDate?: string;
  tripDestination?: string;
  tripCoverImage?: string | null;
}

type EventType = 'flight' | 'accommodation' | 'activity' | 'car_rental' | 'itinerary' | 'reservation';

interface TimelineEvent {
  id: number;
  type: EventType;
  date: string;
  title: string;
  description: string | null;
  location: string | null;
  time: string | null;
  imageUrl: string | null;
  carrierCode: string | null;
  confirmationCode?: string | null;
}

// ── Config ────────────────────────────────────────────────────────────────────

const TYPE_CFG: Record<EventType, { icon: React.ElementType; bg: string; label: string }> = {
  flight:        { icon: Plane,             bg: 'bg-blue-500',    label: 'Flight'      },
  accommodation: { icon: Home,              bg: 'bg-amber-500',   label: 'Stay'        },
  activity:      { icon: Compass,           bg: 'bg-emerald-500', label: 'Activity'    },
  car_rental:    { icon: Car,               bg: 'bg-violet-500',  label: 'Car Rental'  },
  itinerary:     { icon: Calendar,          bg: 'bg-rose-400',    label: 'Plan'        },
  reservation:   { icon: UtensilsCrossed,   bg: 'bg-orange-500',  label: 'Reservation' },
};

// Whether this event can be manually reordered (non-timed activities/reservations)
function isDraggable(e: TimelineEvent) {
  return !e.time && (e.type === 'activity' || e.type === 'reservation');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function to12h(time: string | null): string | null {
  if (!time) return null;
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// ── Event row ─────────────────────────────────────────────────────────────────

function EventRow({
  event, isLast, dragListeners,
}: {
  event: TimelineEvent;
  isLast: boolean;
  dragListeners?: Record<string, unknown>;
}) {
  const cfg = TYPE_CFG[event.type] ?? TYPE_CFG.activity;
  const Icon = cfg.icon;
  const [photo, setPhoto] = useState<string | null>(event.imageUrl);
  const [logoErr, setLogoErr] = useState(false);

  useEffect(() => {
    if (photo || event.type === 'itinerary' || event.type === 'flight') return;
    fetchWikiImage(event.location || event.title).then(url => {
      if (url) setPhoto(url);
    });
  }, [event.id]);

  const timeFmt = to12h(event.time);

  return (
    <div className="flex gap-3">
      {/* Time column — doubles as drag handle for non-timed draggable events */}
      <div className="w-[4.5rem] shrink-0 pt-1 flex items-start justify-end">
        {timeFmt ? (
          <span className="text-[11px] font-mono font-bold text-primary leading-none mt-px">{timeFmt}</span>
        ) : dragListeners ? (
          <button
            {...dragListeners}
            className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors touch-none"
            aria-label="Drag to reorder"
            tabIndex={-1}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      {/* Spine + dot */}
      <div className="flex flex-col items-center shrink-0">
        <div className={`h-8 w-8 rounded-full ${cfg.bg} flex items-center justify-center z-10 shrink-0`}>
          <Icon className="h-4 w-4 text-white" />
        </div>
        {!isLast && <div className="w-px flex-1 bg-border min-h-[1rem] mt-0.5" />}
      </div>

      {/* Content */}
      <div className={`flex-1 min-w-0 ${!isLast ? 'pb-5' : 'pb-1'}`}>
        <div className="flex gap-3 items-start">
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-sm leading-snug text-foreground">{event.title}</p>
            {event.location && (
              <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                <MapPin className="h-3 w-3 shrink-0" />
                <span className="truncate">{event.location}</span>
              </p>
            )}
            {event.description && (
              <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                {event.description}
              </p>
            )}
            {event.confirmationCode && (
              <span className="inline-flex items-center gap-1 mt-1.5 text-[11px] font-mono bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                <BookMarked className="h-2.5 w-2.5 shrink-0" />
                {event.confirmationCode}
              </span>
            )}
          </div>

          {/* Thumbnail */}
          {event.type === 'flight' && event.carrierCode && !logoErr ? (
            <div className="h-10 w-16 shrink-0 bg-muted/50 rounded-lg flex items-center justify-center overflow-hidden">
              <img
                src={`https://pics.avs.io/200/80/${event.carrierCode.toUpperCase()}.png`}
                alt=""
                className="h-full w-full object-contain p-1"
                onError={() => setLogoErr(true)}
              />
            </div>
          ) : photo && event.type !== 'itinerary' ? (
            <div className="h-12 w-16 shrink-0 rounded-lg overflow-hidden">
              <img src={photo} alt="" className="h-full w-full object-cover" />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ── Sortable event row (wraps EventRow with dnd-kit) ─────────────────────────

function SortableEventRow({ event, isLast }: { event: TimelineEvent; isLast: boolean }) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: `${event.type}-${event.id}` });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      {...attributes}
    >
      <EventRow event={event} isLast={isLast} dragListeners={listeners as Record<string, unknown>} />
    </div>
  );
}

// ── Transition divider ────────────────────────────────────────────────────────

function TransitionDivider() {
  return (
    <div className="flex gap-3 my-1">
      <div className="w-[4.5rem] shrink-0" />
      <div className="flex flex-col items-center shrink-0">
        <div className="w-px flex-none h-3 bg-border" />
        <div className="h-6 w-6 rounded-full bg-muted border border-border flex items-center justify-center z-10 shrink-0">
          <ArrowRightLeft className="h-3 w-3 text-muted-foreground" />
        </div>
        <div className="w-px flex-none h-3 bg-border" />
      </div>
      <div className="flex items-center">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70">
          Transition Day
        </span>
      </div>
    </div>
  );
}

// ── Right panel ───────────────────────────────────────────────────────────────

function RightPanel({ events, note }: { events: TimelineEvent[]; note: any }) {
  const highlights = events.filter(e => e.type !== 'itinerary').slice(0, 6);
  const bookings   = events.filter(e => e.confirmationCode);

  if (!highlights.length && !bookings.length && !note?.notes) return null;

  return (
    <div className="space-y-3">
      {highlights.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ background: '#1a2744' }}>
          <div className="px-4 py-2.5 border-b border-white/10 flex items-center gap-2">
            <Star className="h-3.5 w-3.5 fill-amber-400 text-amber-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-amber-400">Today's Highlights</span>
          </div>
          <ul className="px-4 py-3 space-y-2">
            {highlights.map((e, i) => (
              <li key={i} className="flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-px" />
                <span className="text-white/90 text-xs leading-snug">{e.title}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {bookings.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ background: '#243060' }}>
          <div className="px-4 py-2.5 border-b border-white/10 flex items-center gap-2">
            <BookMarked className="h-3.5 w-3.5 text-sky-400" />
            <span className="text-[10px] font-black uppercase tracking-widest text-sky-400">Reservations</span>
          </div>
          <ul className="px-4 py-3 space-y-3">
            {bookings.map((e, i) => (
              <li key={i}>
                <p className="text-white/90 text-xs font-semibold leading-snug">{e.title}</p>
                {e.location && <p className="text-white/50 text-[11px] mt-0.5">{e.location}</p>}
                <p className="font-mono text-sky-300 text-[11px] mt-0.5">{e.confirmationCode}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {note?.notes && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-amber-200 flex items-center gap-2">
            <Lightbulb className="h-3.5 w-3.5 text-amber-600" />
            <span className="text-[10px] font-black uppercase tracking-widest text-amber-700">Tips & Reminders</span>
          </div>
          <p className="px-4 py-3 text-xs text-amber-900 whitespace-pre-wrap leading-relaxed">{note.notes}</p>
        </div>
      )}
    </div>
  );
}

// ── Day card ──────────────────────────────────────────────────────────────────

function DayCard({
  tripId, date, dayNumber, events: propEvents, note,
  isOpen, onToggle, editMode, destination,
}: {
  tripId: number;
  date: string;
  dayNumber: number;
  events: TimelineEvent[];
  note: any;
  isOpen: boolean;
  onToggle: () => void;
  editMode?: boolean;
  destination?: string;
}) {
  const [noteOpen, setNoteOpen] = useState(false);
  const [headerImg, setHeaderImg] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionDraft, setDescriptionDraft] = useState('');
  const descriptionInputRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();

  const createDay = useCreateItineraryDay();
  const updateDay = useUpdateItineraryDay();

  const saveTitle = useCallback((value: string) => {
    const trimmed = value.trim();
    setEditingTitle(false);
    if (trimmed === (note?.title ?? '')) return;
    const payload = {
      date,
      title: trimmed,
      description: note?.description || undefined,
      notes: note?.notes || undefined,
    };
    const opts = {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItineraryDaysQueryKey(tripId) });
      },
      onError: () => toast.error('Failed to save title'),
    };
    if (note) {
      updateDay.mutate({ tripId, dayId: note.id, data: payload }, opts);
    } else {
      createDay.mutate({ tripId, data: payload }, opts);
    }
  }, [note, date, tripId, queryClient, createDay, updateDay]);

  const saveDescription = useCallback((value: string) => {
    const trimmed = value.trim();
    setEditingDescription(false);
    if (trimmed === (note?.description ?? '')) return;
    // Don't create a new day record with no title — title inline edit handles that
    if (!note && !trimmed) return;
    const payload = {
      date,
      title: note?.title || '',
      // Send '' (not undefined) when cleared: undefined fields are ignored by
      // the API, which made it impossible to clear a day description.
      description: trimmed,
      notes: note?.notes || undefined,
    };
    const opts = {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListItineraryDaysQueryKey(tripId) });
      },
      onError: () => toast.error('Failed to save description'),
    };
    if (note) {
      updateDay.mutate({ tripId, dayId: note.id, data: payload }, opts);
    } else {
      createDay.mutate({ tripId, data: payload }, opts);
    }
  }, [note, date, tripId, queryClient, createDay, updateDay]);

  // Local events state for optimistic DnD updates
  const [localEvents, setLocalEvents] = useState<TimelineEvent[]>(propEvents);
  useEffect(() => setLocalEvents(propEvents), [propEvents]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  useEffect(() => {
    if (!destination) return;
    fetchWikiImage(destination.split(',')[0].trim()).then(url => {
      if (url) setHeaderImg(url);
    });
  }, [destination]);

  const parsed  = parseISO(date);
  const weekday = format(parsed, 'EEEE').toUpperCase();
  const dateStr = format(parsed, 'MMMM d, yyyy').toUpperCase();

  const visibleEvents = localEvents.filter(e => e.type !== 'itinerary');
  const title    = note?.title ?? (visibleEvents[0]?.location?.split(',')[0].trim() ?? null);
  const subtitle = note?.description ?? null;

  // All draggable event IDs (activities then reservations)
  const draggableIds = visibleEvents
    .filter(isDraggable)
    .map(e => `${e.type}-${e.id}`);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeStr = String(active.id);
    const overStr   = String(over.id);

    // Determine the event type being dragged
    const activeType = activeStr.startsWith('activity-') ? 'activity' : 'reservation';
    const overType   = overStr.startsWith('activity-')   ? 'activity' : 'reservation';

    // Prevent cross-type drops
    if (activeType !== overType) return;

    const type = activeType as 'activity' | 'reservation';
    const typeItems = visibleEvents.filter(e => isDraggable(e) && e.type === type);
    const oldIdx = typeItems.findIndex(e => `${e.type}-${e.id}` === activeStr);
    const newIdx = typeItems.findIndex(e => `${e.type}-${e.id}` === overStr);
    if (oldIdx < 0 || newIdx < 0) return;

    const reordered = arrayMove(typeItems, oldIdx, newIdx);

    // Optimistically update: rebuild full event list with reordered type group
    let typeCounter = 0;
    const updated = localEvents.map(e =>
      isDraggable(e) && e.type === type ? reordered[typeCounter++] : e
    );
    setLocalEvents(updated);

    // Persist to API
    const url = type === 'activity'
      ? `/api/trips/${tripId}/activities/reorder`
      : `/api/trips/${tripId}/reservations/reorder`;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ids: reordered.map(e => e.id) }),
      });
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: getGetTripTimelineQueryKey(tripId) });
      } else {
        setLocalEvents(propEvents);
        toast.error('Could not save order');
      }
    } catch {
      setLocalEvents(propEvents);
      toast.error('Could not save order');
    }
  }, [localEvents, visibleEvents, propEvents, tripId, queryClient]);

  return (
    <div className="rounded-2xl overflow-hidden border shadow-sm">
      {/* ── Header (always visible) ── */}
      <button onClick={onToggle} className="w-full text-left focus:outline-none group/hdr">
        <div className="relative overflow-hidden">
          {headerImg && (
            <img src={headerImg} alt="" className="absolute inset-0 h-full w-full object-cover" />
          )}
          <div className={`absolute inset-0 ${headerImg
            ? 'bg-gradient-to-r from-slate-900/96 via-slate-900/85 to-slate-900/60'
            : 'bg-gradient-to-r from-slate-900 to-slate-800'
          }`} />

          <div className="relative px-5 py-4 flex items-center gap-5">
            <div className="shrink-0 w-14 text-center">
              <div className="text-[10px] font-black uppercase tracking-widest text-primary">Day</div>
              <div className="text-3xl font-serif font-bold text-white leading-none">{dayNumber}</div>
            </div>

            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-bold tracking-widest text-white/50 uppercase">
                {weekday} · {dateStr}
              </div>
              {editingTitle ? (
                <input
                  ref={titleInputRef}
                  className="bg-transparent text-base md:text-lg font-serif font-bold text-white mt-0.5 leading-tight outline-none border-b border-white/40 focus:border-white/80 w-full transition-colors"
                  value={titleDraft}
                  onChange={e => setTitleDraft(e.target.value)}
                  onBlur={() => saveTitle(titleDraft)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') { e.preventDefault(); titleInputRef.current?.blur(); }
                    if (e.key === 'Escape') { setEditingTitle(false); }
                  }}
                  onClick={e => e.stopPropagation()}
                  placeholder="Add a day title…"
                />
              ) : (
                <div
                  className="group/title flex items-center gap-1.5 cursor-text mt-0.5"
                  onClick={e => {
                    e.stopPropagation();
                    setTitleDraft(note?.title ?? '');
                    setEditingTitle(true);
                    setTimeout(() => titleInputRef.current?.focus(), 0);
                  }}
                >
                  {title ? (
                    <span className="text-base md:text-lg font-serif font-bold text-white leading-tight truncate">
                      {title}
                    </span>
                  ) : (
                    <span className="text-sm text-white/35 italic">Add a title…</span>
                  )}
                  <Pencil className="h-3 w-3 text-white/40 opacity-0 group-hover/title:opacity-100 transition-opacity shrink-0" />
                </div>
              )}
              {editingDescription ? (
                <textarea
                  ref={descriptionInputRef}
                  rows={2}
                  className="bg-transparent text-xs italic text-white/70 mt-0.5 outline-none border-b border-white/40 focus:border-white/80 w-full transition-colors resize-none leading-snug"
                  value={descriptionDraft}
                  onChange={e => setDescriptionDraft(e.target.value)}
                  onBlur={() => saveDescription(descriptionDraft)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); descriptionInputRef.current?.blur(); }
                    if (e.key === 'Escape') { setEditingDescription(false); }
                  }}
                  onClick={e => e.stopPropagation()}
                  placeholder="Add a plan…"
                />
              ) : (
                <div
                  className="group/desc flex items-center gap-1 cursor-text mt-0.5"
                  onClick={e => {
                    e.stopPropagation();
                    setDescriptionDraft(note?.description ?? '');
                    setEditingDescription(true);
                    setTimeout(() => descriptionInputRef.current?.focus(), 0);
                  }}
                >
                  {subtitle ? (
                    <span className="text-xs italic text-white/50 line-clamp-1">{subtitle}</span>
                  ) : (
                    <span className="text-xs italic text-white/25 opacity-0 group-hover/desc:opacity-100 transition-opacity">Add a plan…</span>
                  )}
                  {subtitle && (
                    <Pencil className="h-2.5 w-2.5 text-white/30 opacity-0 group-hover/desc:opacity-100 transition-opacity shrink-0" />
                  )}
                </div>
              )}
            </div>

            <div className="shrink-0 flex items-center gap-2 text-white/60">
              {visibleEvents.length > 0 && (
                <span className="hidden sm:inline-flex items-center text-[11px] bg-white/10 group-hover/hdr:bg-white/15 transition-colors px-2 py-1 rounded-full">
                  {visibleEvents.length} event{visibleEvents.length !== 1 ? 's' : ''}
                </span>
              )}
              {isOpen
                ? <ChevronUp className="h-5 w-5" />
                : <ChevronDown className="h-5 w-5" />}
            </div>
          </div>
        </div>
      </button>

      {/* ── Expanded body ── */}
      {isOpen && (
        <div className="bg-card border-t">
          <div className="p-5 md:p-6">
            <div className="flex flex-col lg:flex-row gap-6">
              {/* Left: timeline */}
              <div className="flex-1 min-w-0">
                {visibleEvents.length > 0 ? (
                  <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                  >
                    <SortableContext items={draggableIds} strategy={verticalListSortingStrategy}>
                      {(() => {
                        const transitionAfterIndices = getTransitionIndices(visibleEvents);
                        return visibleEvents.map((event, i) => (
                          <div key={`row-wrapper-${event.type}-${event.id}-${i}`}>
                            {isDraggable(event)
                              ? (
                                <SortableEventRow
                                  event={event}
                                  isLast={i === visibleEvents.length - 1}
                                />
                              ) : (
                                <EventRow
                                  event={event}
                                  isLast={i === visibleEvents.length - 1}
                                />
                              )}
                            {transitionAfterIndices.has(i) && <TransitionDivider />}
                          </div>
                        ));
                      })()}
                    </SortableContext>
                  </DndContext>
                ) : (
                  <div className="py-10 text-center text-muted-foreground text-sm border border-dashed rounded-xl">
                    No events scheduled for this day
                    <p className="mt-1 text-xs">Add flights, stays, activities or car rentals from their respective tabs.</p>
                  </div>
                )}
              </div>

              {/* Right: highlights + admin panel */}
              <div className="lg:w-64 xl:w-72 shrink-0 space-y-3">
                <RightPanel events={localEvents} note={note} />

                <Dialog open={noteOpen} onOpenChange={setNoteOpen}>
                  <DialogTrigger asChild>
                    <Button variant="outline" size="sm" className="w-full text-xs">
                      {note
                        ? <><Pencil className="h-3 w-3 mr-1.5" />Edit Day Notes</>
                        : <><Plus className="h-3 w-3 mr-1.5" />Add Day Notes</>}
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>
                        {note ? 'Edit' : 'Add'} Notes — Day {dayNumber} ({format(parsed, 'EEE, MMM d')})
                      </DialogTitle>
                    </DialogHeader>
                    <DayNoteForm
                      tripId={tripId}
                      date={date}
                      note={note}
                      onSuccess={() => setNoteOpen(false)}
                    />
                  </DialogContent>
                </Dialog>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Day note form ─────────────────────────────────────────────────────────────

const dayNoteSchema = z.object({
  title:       z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  notes:       z.string().optional(),
});

function DayNoteForm({ tripId, date, note, onSuccess }: {
  tripId: number;
  date: string;
  note?: any;
  onSuccess: () => void;
}) {
  const queryClient = useQueryClient();
  const create = useCreateItineraryDay();
  const update = useUpdateItineraryDay();

  const form = useForm<z.infer<typeof dayNoteSchema>>({
    resolver: zodResolver(dayNoteSchema),
    defaultValues: {
      title:       note?.title       ?? '',
      description: note?.description ?? '',
      notes:       note?.notes       ?? '',
    },
  });

  const onSubmit = (values: z.infer<typeof dayNoteSchema>) => {
    const payload = {
      date,
      title:       values.title,
      description: values.description || undefined,
      notes:       values.notes       || undefined,
    };
    const opts = {
      onSuccess: () => {
        toast.success(note ? 'Day notes updated' : 'Day notes added');
        queryClient.invalidateQueries({ queryKey: getListItineraryDaysQueryKey(tripId) });
        onSuccess();
      },
      onError: () => toast.error('Failed to save'),
    };
    if (note) {
      update.mutate({ tripId, dayId: note.id, data: payload }, opts);
    } else {
      create.mutate({ tripId, data: payload }, opts);
    }
  };

  const isPending = create.isPending || update.isPending;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
        <FormField control={form.control} name="title" render={({ field }) => (
          <FormItem>
            <FormLabel>Day Title</FormLabel>
            <FormControl>
              <Input placeholder="e.g. Arrival & City Exploration" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="description" render={({ field }) => (
          <FormItem>
            <FormLabel>Day Plan <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
            <FormControl>
              <Textarea className="h-20 resize-none" placeholder="Overview of the day's plan…" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="notes" render={({ field }) => (
          <FormItem>
            <FormLabel>Tips & Reminders <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
            <FormControl>
              <Textarea className="h-20 resize-none" placeholder="Quick tips, things to remember…" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isPending}>{isPending ? 'Saving…' : 'Save'}</Button>
        </div>
      </form>
    </Form>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function TripItinerary({ tripId, editMode, tripStartDate, tripEndDate, tripDestination }: Props) {
  const { data: timeline, isLoading: tlLoading } = useGetTripTimeline(tripId, { query: { enabled: !!tripId } });
  const { data: itineraryDays, isLoading: dayLoading } = useListItineraryDays(tripId, { query: { enabled: !!tripId } });

  const days = useMemo(() => {
    if (!tripStartDate || !tripEndDate) return [];
    const result: { date: string; dayNumber: number }[] = [];
    let cur = parseISO(tripStartDate);
    const end = parseISO(tripEndDate);
    let n = 1;
    while (cur <= end) {
      result.push({ date: format(cur, 'yyyy-MM-dd'), dayNumber: n });
      cur = addDays(cur, 1);
      n++;
    }
    return result;
  }, [tripStartDate, tripEndDate]);

  const eventsByDate = useMemo(() => {
    const map: Record<string, TimelineEvent[]> = {};
    ((timeline as TimelineEvent[]) ?? []).forEach(e => {
      if (!map[e.date]) map[e.date] = [];
      map[e.date].push(e);
    });
    return map;
  }, [timeline]);

  const notesByDate = useMemo(() => {
    const map: Record<string, any> = {};
    (itineraryDays ?? []).forEach((d: any) => { map[d.date] = d; });
    return map;
  }, [itineraryDays]);

  const [openDates, setOpenDates] = useState<Set<string>>(
    () => new Set(tripStartDate ? [tripStartDate] : [])
  );

  const toggle = (date: string) => setOpenDates(prev => {
    const next = new Set(prev);
    next.has(date) ? next.delete(date) : next.add(date);
    return next;
  });

  if (tlLoading || dayLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-muted-foreground text-sm">
        Loading itinerary…
      </div>
    );
  }

  if (!tripStartDate || !tripEndDate) {
    return (
      <div className="text-center py-20 bg-muted/50 rounded-xl border border-dashed">
        <Calendar className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
        <p className="font-semibold">Trip dates not set</p>
        <p className="text-muted-foreground text-sm mt-1">
          Set start and end dates to generate the day-by-day itinerary.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {days.map(({ date, dayNumber }) => (
        <DayCard
          key={date}
          tripId={tripId}
          date={date}
          dayNumber={dayNumber}
          events={eventsByDate[date] ?? []}
          note={notesByDate[date]}
          isOpen={openDates.has(date)}
          onToggle={() => toggle(date)}
          editMode={editMode}
          destination={tripDestination}
        />
      ))}
    </div>
  );
}
