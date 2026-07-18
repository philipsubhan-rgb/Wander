import { useState, useEffect, useMemo } from 'react';
import { format, parseISO, addDays } from 'date-fns';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ChevronDown, ChevronUp, Plane, Home, Compass, Car, Calendar,
  MapPin, Star, Pencil, Plus, CheckCircle2, BookMarked, Lightbulb,
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
} from '@workspace/api-client-react';
import { fetchWikiImage } from '@/lib/wiki-image';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  tripId: number;
  editMode?: boolean;
  tripStartDate?: string;
  tripEndDate?: string;
  tripDestination?: string;
  tripCoverImage?: string | null;
}

type EventType = 'flight' | 'accommodation' | 'activity' | 'car_rental' | 'itinerary';

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
  flight:        { icon: Plane,    bg: 'bg-blue-500',    label: 'Flight'     },
  accommodation: { icon: Home,     bg: 'bg-amber-500',   label: 'Stay'       },
  activity:      { icon: Compass,  bg: 'bg-emerald-500', label: 'Activity'   },
  car_rental:    { icon: Car,      bg: 'bg-violet-500',  label: 'Car Rental' },
  itinerary:     { icon: Calendar, bg: 'bg-rose-400',    label: 'Plan'       },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function to12h(time: string | null): string | null {
  if (!time) return null;
  const [h, m] = time.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// ── Event row ─────────────────────────────────────────────────────────────────

function EventRow({ event, isLast }: { event: TimelineEvent; isLast: boolean }) {
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
      {/* Time */}
      <div className="w-[4.5rem] shrink-0 pt-1 text-right">
        {timeFmt && (
          <span className="text-[11px] font-mono font-bold text-primary leading-none">{timeFmt}</span>
        )}
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

// ── Right panel ───────────────────────────────────────────────────────────────

function RightPanel({ events, note }: { events: TimelineEvent[]; note: any }) {
  const highlights = events.filter(e => e.type !== 'itinerary').slice(0, 6);
  const bookings   = events.filter(e => e.confirmationCode);

  if (!highlights.length && !bookings.length && !note?.notes) return null;

  return (
    <div className="space-y-3">
      {/* Today's highlights */}
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

      {/* Reservations */}
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

      {/* Tips */}
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
  tripId, date, dayNumber, events, note,
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

  useEffect(() => {
    if (!destination) return;
    fetchWikiImage(destination.split(',')[0].trim()).then(url => {
      if (url) setHeaderImg(url);
    });
  }, [destination]);

  const parsed  = parseISO(date);
  const weekday = format(parsed, 'EEEE').toUpperCase();
  const dateStr = format(parsed, 'MMMM d, yyyy').toUpperCase();

  const visibleEvents = events.filter(e => e.type !== 'itinerary');
  const title    = note?.title
    ?? (visibleEvents[0]?.location?.split(',')[0].trim() ?? null);
  const subtitle = note?.description ?? null;

  return (
    <div className="rounded-2xl overflow-hidden border shadow-sm">
      {/* ── Header (always visible) ── */}
      <button onClick={onToggle} className="w-full text-left focus:outline-none group/hdr">
        {/* Background */}
        <div className="relative overflow-hidden">
          {headerImg && (
            <img src={headerImg} alt="" className="absolute inset-0 h-full w-full object-cover" />
          )}
          <div className={`absolute inset-0 ${headerImg
            ? 'bg-gradient-to-r from-slate-900/96 via-slate-900/85 to-slate-900/60'
            : 'bg-gradient-to-r from-slate-900 to-slate-800'
          }`} />

          <div className="relative px-5 py-4 flex items-center gap-5">
            {/* Day badge */}
            <div className="shrink-0 w-14 text-center">
              <div className="text-[10px] font-black uppercase tracking-widest text-primary">Day</div>
              <div className="text-3xl font-serif font-bold text-white leading-none">{dayNumber}</div>
            </div>

            {/* Text */}
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-bold tracking-widest text-white/50 uppercase">
                {weekday} · {dateStr}
              </div>
              {title ? (
                <div className="text-base md:text-lg font-serif font-bold text-white mt-0.5 leading-tight truncate">
                  {title}
                </div>
              ) : (
                <div className="text-sm text-white/40 italic mt-0.5">No events planned</div>
              )}
              {subtitle && (
                <div className="text-xs italic text-white/50 mt-0.5 line-clamp-1">{subtitle}</div>
              )}
            </div>

            {/* Count + chevron */}
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
                  <div>
                    {visibleEvents.map((event, i) => (
                      <EventRow
                        key={`${event.type}-${event.id}-${i}`}
                        event={event}
                        isLast={i === visibleEvents.length - 1}
                      />
                    ))}
                  </div>
                ) : (
                  <div className="py-10 text-center text-muted-foreground text-sm border border-dashed rounded-xl">
                    No events scheduled for this day
                    {(
                      <p className="mt-1 text-xs">Add flights, stays, activities or car rentals from their respective tabs.</p>
                    )}
                  </div>
                )}
              </div>

              {/* Right: highlights + admin panel */}
              <div className="lg:w-64 xl:w-72 shrink-0 space-y-3">
                <RightPanel events={events} note={note} />

                {(
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
                )}
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

  // Generate one entry per day in the trip date range
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

  // Group timeline events by date
  const eventsByDate = useMemo(() => {
    const map: Record<string, TimelineEvent[]> = {};
    ((timeline as TimelineEvent[]) ?? []).forEach(e => {
      if (!map[e.date]) map[e.date] = [];
      map[e.date].push(e);
    });
    return map;
  }, [timeline]);

  // Map itinerary day notes by date
  const notesByDate = useMemo(() => {
    const map: Record<string, any> = {};
    (itineraryDays ?? []).forEach((d: any) => { map[d.date] = d; });
    return map;
  }, [itineraryDays]);

  // Day open state — first day open by default
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
