import { useGetTripSummary, useGetTripTimeline, getGetTripTimelineQueryKey } from '@workspace/api-client-react';
import { useState, useEffect, useMemo, useCallback } from 'react';
import { Calendar, Plane, Home, Compass, Users, CheckSquare, Car, UtensilsCrossed, GripVertical } from 'lucide-react';
import MarcoBar from '@/components/MarcoBar';
import { format, parseISO } from 'date-fns';
import { fetchWikiImage } from '@/lib/wiki-image';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
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

interface TimelineEvent {
  id: number;
  type: string;
  date: string;
  title: string;
  description: string | null;
  location: string | null;
  time: string | null;
  imageUrl: string | null;
  carrierCode?: string | null;
  confirmationCode?: string | null;
}

function isDraggable(e: TimelineEvent) {
  return !e.time && (e.type === 'activity' || e.type === 'reservation');
}

// ── Main export ───────────────────────────────────────────────────────────────

export function TripOverview({ tripId, onNavigate, tripContext }: { tripId: number; onNavigate?: (tab: string) => void; tripContext?: Record<string, unknown> }) {
  const { data: summary } = useGetTripSummary(tripId, { query: { enabled: !!tripId } });
  const { data: rawTimeline } = useGetTripTimeline(tripId, { query: { enabled: !!tripId } });
  const queryClient = useQueryClient();

  // Group events by date; itinerary (day-title) entries are always pinned first
  const { sortedDates, eventsByDate: initialByDate } = useMemo(() => {
    const byDate: Record<string, TimelineEvent[]> = {};
    ((rawTimeline as TimelineEvent[]) ?? []).forEach(e => {
      if (!byDate[e.date]) byDate[e.date] = [];
      byDate[e.date].push(e);
    });
    // Pin itinerary events to the top of each day; preserve API order for everything else
    Object.keys(byDate).forEach(d => {
      byDate[d].sort((a, b) => {
        if (a.type === 'itinerary' && b.type !== 'itinerary') return -1;
        if (b.type === 'itinerary' && a.type !== 'itinerary') return 1;
        return 0;
      });
    });
    return { sortedDates: Object.keys(byDate).sort(), eventsByDate: byDate };
  }, [rawTimeline]);

  // Local per-date event state for optimistic DnD updates
  const [eventsByDate, setEventsByDate] = useState<Record<string, TimelineEvent[]>>(initialByDate);
  useEffect(() => setEventsByDate(initialByDate), [initialByDate]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  const makeHandleDragEnd = useCallback((date: string) => async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeStr = String(active.id);
    const overStr   = String(over.id);
    const activeType = activeStr.startsWith('activity-') ? 'activity' : 'reservation';
    const overType   = overStr.startsWith('activity-')   ? 'activity' : 'reservation';
    if (activeType !== overType) return;

    const type = activeType as 'activity' | 'reservation';
    const dateEvents = eventsByDate[date] ?? [];
    const typeItems  = dateEvents.filter(e => isDraggable(e) && e.type === type);
    const oldIdx = typeItems.findIndex(e => `${e.type}-${e.id}` === activeStr);
    const newIdx = typeItems.findIndex(e => `${e.type}-${e.id}` === overStr);
    if (oldIdx < 0 || newIdx < 0) return;

    const reordered = arrayMove(typeItems, oldIdx, newIdx);

    // Optimistic update for this date
    let typeCounter = 0;
    const updatedDate = dateEvents.map(e =>
      isDraggable(e) && e.type === type ? reordered[typeCounter++] : e
    );
    setEventsByDate(prev => ({ ...prev, [date]: updatedDate }));

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
        setEventsByDate(initialByDate);
        toast.error('Could not save order');
      }
    } catch {
      setEventsByDate(initialByDate);
      toast.error('Could not save order');
    }
  }, [eventsByDate, initialByDate, tripId, queryClient]);

  const hasEvents = sortedDates.length > 0;

  return (
    <div className="space-y-10">
      <MarcoBar tripId={tripId} tripContext={tripContext} />
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard icon={Calendar} label="Days"      value={summary?.daysCount}                                                    onClick={() => onNavigate?.('itinerary')} />
        <StatCard icon={Plane}    label="Flights"   value={summary?.flightsCount}                                                 onClick={() => onNavigate?.('flights')} />
        <StatCard icon={Home}     label="Stays"     value={summary?.accommodationsCount}                                          onClick={() => onNavigate?.('accommodations')} />
        <StatCard icon={Compass}  label="Activities" value={summary?.activitiesCount}                                             onClick={() => onNavigate?.('activities')} />
        <StatCard icon={Users}    label="Travelers" value={summary?.participantsCount}                                            onClick={() => onNavigate?.('packing')} />
        <StatCard icon={CheckSquare} label="Packed" value={`${summary?.packingCheckedCount || 0}/${summary?.packingItemsCount || 0}`} onClick={() => onNavigate?.('packing')} />
      </div>

      <div className="max-w-3xl">
        <h2 className="text-2xl font-serif font-bold mb-6">Timeline</h2>
        {hasEvents ? (
          <div className="space-y-8 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px before:h-full before:w-0.5 before:bg-gradient-to-b before:from-border/50 before:via-border before:to-transparent">
            {sortedDates.map(date => {
              const dateEvents = eventsByDate[date] ?? [];
              const draggableIds = dateEvents
                .filter(isDraggable)
                .map(e => `${e.type}-${e.id}`);

              return (
                <DndContext
                  key={date}
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={makeHandleDragEnd(date)}
                >
                  <SortableContext items={draggableIds} strategy={verticalListSortingStrategy}>
                    {dateEvents.map((event, i) =>
                      isDraggable(event)
                        ? <SortableTimelineCard key={`${event.type}-${event.id}-${i}`} event={event} />
                        : <TimelineCard key={`${event.type}-${event.id}-${i}`} event={event} />
                    )}
                  </SortableContext>
                </DndContext>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-12 bg-muted/50 rounded-xl border border-dashed">
            <Calendar className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">Timeline empty</p>
            <p className="text-muted-foreground">Add flights, stays, or activities to build your timeline.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Timeline card (non-draggable) ─────────────────────────────────────────────

function TimelineCard({ event }: { event: TimelineEvent }) {
  return (
    <div className="relative flex items-start gap-6">
      <TimelineDot event={event} />
      <EventCard event={event} dragListeners={undefined} dragRef={undefined} dragStyle={undefined} isDragging={false} />
    </div>
  );
}

// ── Sortable timeline card (draggable) ────────────────────────────────────────

function SortableTimelineCard({ event }: { event: TimelineEvent }) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: `${event.type}-${event.id}` });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="relative flex items-start gap-6"
      {...attributes}
    >
      <TimelineDot event={event} />
      <EventCard
        event={event}
        dragListeners={listeners as Record<string, unknown>}
        dragRef={undefined}
        dragStyle={undefined}
        isDragging={isDragging}
      />
    </div>
  );
}

// ── Timeline dot ──────────────────────────────────────────────────────────────

function TimelineDot({ event }: { event: TimelineEvent }) {
  return (
    <div className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-card border shadow-sm mt-1">
      {event.type === 'flight'        && <Plane            className="h-5 w-5 text-primary" />}
      {event.type === 'accommodation' && <Home             className="h-5 w-5 text-primary" />}
      {event.type === 'activity'      && <Compass          className="h-5 w-5 text-primary" />}
      {event.type === 'itinerary'     && <Calendar         className="h-5 w-5 text-primary" />}
      {event.type === 'car_rental'    && <Car              className="h-5 w-5 text-primary" />}
      {event.type === 'reservation'   && <UtensilsCrossed  className="h-5 w-5 text-primary" />}
    </div>
  );
}

// ── Event card ────────────────────────────────────────────────────────────────

function EventCard({
  event, dragListeners, isDragging,
}: {
  event: TimelineEvent;
  dragListeners?: Record<string, unknown>;
  dragRef?: unknown;
  dragStyle?: unknown;
  isDragging: boolean;
}) {
  return (
    <div className={`flex gap-4 w-full bg-card p-0 rounded-xl border shadow-sm overflow-hidden ${isDragging ? 'shadow-lg ring-2 ring-primary/30' : ''}`}>
      <EventThumbnail event={event} />

      <div className="flex flex-col gap-1 flex-1 p-4 min-w-0">
        <div className="flex items-start justify-between gap-4">
          <h4 className="font-serif font-semibold text-base leading-snug">{event.title}</h4>
          <div className="flex items-center gap-2 shrink-0">
            {dragListeners && (
              <button
                {...dragListeners}
                className="cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground/70 transition-colors touch-none"
                aria-label="Drag to reorder"
                tabIndex={-1}
              >
                <GripVertical className="h-4 w-4" />
              </button>
            )}
            <span className="text-xs font-medium text-muted-foreground whitespace-nowrap bg-muted px-2 py-1 rounded-md">
              {format(parseISO(event.date), 'MMM d, yyyy')}
            </span>
          </div>
        </div>
        {(event.time || event.location) && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {event.time && <span>{event.time}</span>}
            {event.location && <span className="truncate">{event.location}</span>}
          </div>
        )}
        {event.description && (
          <p className="text-muted-foreground mt-2 text-sm border-t pt-2 line-clamp-2">{event.description}</p>
        )}
      </div>
    </div>
  );
}

// ── Event thumbnail ────────────────────────────────────────────────────────────

function EventThumbnail({ event }: { event: TimelineEvent }) {
  const [wikiImage, setWikiImage] = useState<string | null>(null);
  const [logoError, setLogoError] = useState(false);

  useEffect(() => {
    const fetchable = event.type === 'activity' || event.type === 'accommodation' || event.type === 'reservation';
    if (!fetchable) return;
    if (event.imageUrl) return;
    const query = event.location || event.title.replace(/^Check-in: /, '');
    fetchWikiImage(query).then(url => { if (url) setWikiImage(url); });
  }, [event.id, event.type, event.imageUrl]);

  const displayImage = event.imageUrl || wikiImage;

  if (event.type === 'flight') {
    if (event.carrierCode && !logoError) {
      return (
        <div className="w-20 shrink-0 bg-muted/50 flex items-center justify-center">
          <img
            src={`https://pics.avs.io/200/80/${event.carrierCode!.toUpperCase()}.png`}
            alt=""
            className="w-16 h-auto object-contain p-1"
            onError={() => setLogoError(true)}
          />
        </div>
      );
    }
    return (
      <div className="w-20 shrink-0 bg-primary/5 flex items-center justify-center">
        <Plane className="h-8 w-8 text-primary/40" />
      </div>
    );
  }

  if (event.type === 'activity' || event.type === 'accommodation' || event.type === 'reservation') {
    if (displayImage) {
      return (
        <div className="w-24 shrink-0 overflow-hidden">
          <img src={displayImage} alt="" className="h-full w-full object-cover" />
        </div>
      );
    }
    const icon = event.type === 'accommodation'
      ? <Home className="h-7 w-7 text-white/60" />
      : event.type === 'reservation'
        ? <UtensilsCrossed className="h-7 w-7 text-white/60" />
        : <Compass className="h-7 w-7 text-white/60" />;
    const bg = event.type === 'accommodation' ? '#f59e0b'
      : event.type === 'reservation' ? '#f97316'
      : '#60a5fa';
    return (
      <div className="w-24 shrink-0 flex items-center justify-center" style={{ background: bg }}>
        {icon}
      </div>
    );
  }

  if (event.type === 'car_rental') {
    return (
      <div className="w-20 shrink-0 flex items-center justify-center" style={{ background: '#3b82f6' }}>
        <Car className="h-7 w-7 text-white/70" />
      </div>
    );
  }

  return (
    <div className="w-20 shrink-0 bg-muted/50 flex items-center justify-center">
      <Calendar className="h-7 w-7 text-muted-foreground/60" />
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, onClick }: { icon: any; label: string; value: any; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="bg-card border rounded-xl p-4 flex flex-col items-center justify-center text-center space-y-2 shadow-sm hover:shadow-md hover:border-primary/50 hover:bg-primary/5 transition-all cursor-pointer w-full group"
    >
      <div className="p-2 bg-primary/10 rounded-full group-hover:bg-primary/20 transition-colors">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <span className="text-2xl font-bold text-foreground">{value !== undefined ? value : '-'}</span>
      <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
    </button>
  );
}

