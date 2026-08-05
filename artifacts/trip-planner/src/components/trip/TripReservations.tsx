import { useState, useEffect, useRef, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format, parseISO } from 'date-fns';
import {
  UtensilsCrossed, Landmark, Map, Train, Ticket, Sparkles, ClipboardList,
  MapPin, Phone, Clock, ExternalLink, Plus, Pencil, Camera, Trash2, Users, BookMarked,
  Globe, CalendarDays,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MiniMap } from './MiniMap';
import {
  useListReservations, useCreateReservation, useUpdateReservation, useDeleteReservation,
  getListReservationsQueryKey,
} from '@workspace/api-client-react';
import { invalidateReservationQueries } from '@/lib/invalidate-trip-queries';
import { useAuth } from '@/hooks/use-auth';
import { fetchWikiImage } from '@/lib/wiki-image';
import { ImagePickerContent } from '@/components/ImageEditor';

const API_BASE = `${import.meta.env.BASE_URL}api`;

// ── Types ─────────────────────────────────────────────────────────────────────

type ResType = 'restaurant' | 'attraction' | 'tour' | 'transport' | 'event' | 'spa' | 'other';

const TYPE_META: Record<ResType, { icon: React.ElementType; label: string; from: string; to: string }> = {
  restaurant: { icon: UtensilsCrossed, label: 'Restaurant',  from: '#f43f5e', to: '#e11d48' },
  attraction: { icon: Landmark,        label: 'Attraction',  from: '#3b82f6', to: '#1d4ed8' },
  tour:       { icon: Map,             label: 'Tour',        from: '#10b981', to: '#059669' },
  transport:  { icon: Train,           label: 'Transport',   from: '#64748b', to: '#334155' },
  event:      { icon: Ticket,          label: 'Event',       from: '#8b5cf6', to: '#6d28d9' },
  spa:        { icon: Sparkles,        label: 'Spa & Wellness', from: '#14b8a6', to: '#0f766e' },
  other:      { icon: ClipboardList,   label: 'Other',       from: '#a8a29e', to: '#78716c' },
};

// ── Schema ────────────────────────────────────────────────────────────────────

const schema = z.object({
  type:             z.enum(['restaurant','attraction','tour','transport','event','spa','other']).optional(),
  title:            z.string().min(1, 'Title is required'),
  venue:            z.string().optional(),
  address:          z.string().optional(),
  date:             z.string().min(1, 'Date is required'),
  time:             z.string().optional(),
  endTime:          z.string().optional(),
  confirmationCode: z.string().optional(),
  numberOfPeople:   z.number().int().positive().optional(),
  phone:            z.string().optional(),
  notes:            z.string().optional(),
  url:              z.string().optional(),
  imageUrl:         z.string().optional(),
  lat:              z.number().optional(),
  lon:              z.number().optional(),
});

// ── Venue autocomplete ────────────────────────────────────────────────────────

interface VenueSuggestion {
  name: string;
  address: string;
  lat: number;
  lon: number;
  website?: string | null;
  phone?: string | null;
}

function VenueInput({
  value, onChange, onSelect, near,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect?: (s: VenueSuggestion) => void;
  near?: string;
}) {
  const [suggestions, setSuggestions] = useState<VenueSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    clearTimeout(debounce.current);
    if (value.length < 2) { setSuggestions([]); return; }
    debounce.current = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: value });
        if (near) params.set('near', near);
        const res = await fetch(`${API_BASE}/search/places?${params}`);
        const data = await res.json();
        setSuggestions(Array.isArray(data) ? data.slice(0, 6) : []);
        setOpen(true);
      } catch {}
    }, 350);
  }, [value, near]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={wrap} className="relative">
      <Input
        value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); }}
        placeholder="Search for a venue…"
        autoComplete="off"
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full bg-popover border rounded-xl shadow-lg overflow-hidden max-h-60 overflow-y-auto">
          {suggestions.map((s, i) => (
            <li key={i}
              className="px-3 py-2.5 hover:bg-muted cursor-pointer text-sm border-b last:border-0"
              onMouseDown={e => { e.preventDefault(); onChange(s.name); onSelect?.(s); setOpen(false); setSuggestions([]); }}>
              <p className="font-medium text-foreground">{s.name}</p>
              <p className="text-xs text-muted-foreground truncate">{s.address}</p>
              {s.website && (
                <p className="text-xs text-primary truncate mt-0.5">{s.website.replace(/^https?:\/\//, '')}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Reservation card ──────────────────────────────────────────────────────────

function ReservationCard({ tripId, res, editMode }: { tripId: number; res: any; editMode?: boolean }) {
  const queryClient = useQueryClient();
  const deleteRes = useDeleteReservation();
  const updateResImg = useUpdateReservation();
  const [cardDialog, setCardDialog] = useState<'none' | 'edit' | 'image'>('none');
  const [photo, setPhoto] = useState<string | null>(res.imageUrl);
  const [logoErr, setLogoErr] = useState(false);

  // Keep photo in sync when imageUrl changes after a query refetch
  useEffect(() => {
    setPhoto(res.imageUrl ?? null);
    setLogoErr(false);
  }, [res.imageUrl]);

  useEffect(() => {
    if (photo) return;
    const q = res.venue || res.title;
    fetchWikiImage(q).then(url => { if (url) setPhoto(url); });
  }, [res.id]);

  const handleImageSave = (url: string | null) => {
    updateResImg.mutate({ tripId, reservationId: res.id, data: { imageUrl: url ?? '' } }, {
      onSuccess: () => { toast.success('Image updated'); invalidateReservationQueries(queryClient, tripId); },
      onError: () => toast.error('Failed to update image'),
    });
  };

  const meta = TYPE_META[res.type as ResType] ?? TYPE_META.other;
  const Icon = meta.icon;

  const timeFmt = (t: string | null) => {
    if (!t) return null;
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };

  const timeStr = res.time
    ? res.endTime
      ? `${timeFmt(res.time)} – ${timeFmt(res.endTime)}`
      : timeFmt(res.time)
    : null;

  const mapsUrl = res.lat && res.lon
    ? `https://maps.google.com/?q=${res.lat},${res.lon}`
    : res.address
      ? `https://maps.google.com/?q=${encodeURIComponent(res.address)}`
      : null;

  const handleDelete = () => {
    if (!confirm('Delete this reservation?')) return;
    deleteRes.mutate({ tripId, reservationId: res.id }, {
      onSuccess: () => {
        toast.success('Deleted');
        invalidateReservationQueries(queryClient, tripId);
      },
      onError: () => toast.error('Failed to delete'),
    });
  };

  return (
    <div className="bg-card border rounded-2xl shadow-sm overflow-hidden relative group hover:border-primary/40 transition-colors">
      {/* ── Header ── */}
      <div className="relative h-28 overflow-hidden">
        {photo && !logoErr ? (
          <img src={photo} alt={res.title} className="h-full w-full object-cover" />
        ) : (
          <div style={{ background: `linear-gradient(135deg, ${meta.from}, ${meta.to})` }}
            className="h-full w-full flex items-center justify-center">
            <Icon className="h-12 w-12 text-white/30" />
          </div>
        )}
        {/* Overlay gradient for readability */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />

        {/* Type badge */}
        <div className="absolute top-3 left-3">
          <span style={{ background: meta.from }} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-white text-[11px] font-bold uppercase tracking-wider">
            <Icon className="h-3 w-3" />
            {meta.label}
          </span>
        </div>

        {/* Admin controls — single Dialog avoids sibling-Dialog Radix conflicts */}
        {(
          <>
            <Dialog open={cardDialog !== 'none'} onOpenChange={open => { if (!open) setCardDialog('none'); }}>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{cardDialog === 'edit' ? 'Edit Reservation' : 'Edit Image'}</DialogTitle>
                </DialogHeader>
                {cardDialog === 'edit' && (
                  <ReservationForm tripId={tripId} reservation={res} onSuccess={() => setCardDialog('none')} />
                )}
                {cardDialog === 'image' && (
                  <ImagePickerContent searchHint={res.venue || res.title} onSave={url => { handleImageSave(url); setCardDialog('none'); }} onCancel={() => setCardDialog('none')} />
                )}
              </DialogContent>
            </Dialog>
            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button variant="secondary" size="icon" onClick={() => setCardDialog('edit')} className="h-7 w-7 bg-white/90 hover:bg-white text-foreground shadow">
                <Pencil className="h-3 w-3" />
              </Button>
              <Button variant="secondary" size="icon" onClick={() => setCardDialog('image')} className="h-7 w-7 bg-white/90 hover:bg-white text-foreground shadow" title="Change image">
                <Camera className="h-3 w-3" />
              </Button>
              <Button variant="secondary" size="icon" onClick={handleDelete} className="h-7 w-7 bg-white/90 hover:bg-white text-destructive shadow">
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
          </>
        )}

        {/* Title at bottom of image */}
        <div className="absolute bottom-0 inset-x-0 px-4 pb-2.5">
          <h3 className="font-serif text-white font-bold text-base leading-tight drop-shadow">{res.title}</h3>
          {res.venue && res.venue !== res.title && (
            <p className="text-white/80 text-xs leading-none mt-0.5 drop-shadow">{res.venue}</p>
          )}
        </div>
      </div>

      {/* ── Body ── */}
      <div className="p-4 space-y-2.5">
        {/* Date & time */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CalendarDays className="h-4 w-4 shrink-0 text-primary" />
          <span className="font-medium text-foreground">
            {format(parseISO(res.date), 'EEE, MMM d, yyyy')}
          </span>
          {timeStr && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <Clock className="h-3.5 w-3.5 shrink-0" />
              <span>{timeStr}</span>
            </>
          )}
        </div>

        {/* Address */}
        {res.address && (
          <div className="flex items-start gap-2 text-sm text-muted-foreground">
            <MapPin className="h-4 w-4 shrink-0 mt-0.5 text-muted-foreground" />
            <span className="flex-1 line-clamp-2 leading-snug">{res.address}</span>
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
                className="shrink-0 text-primary hover:text-primary/80 transition-colors" title="Open in Maps">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )}

        {/* Number of people */}
        {res.numberOfPeople && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Users className="h-4 w-4 shrink-0" />
            <span>{res.numberOfPeople} {res.numberOfPeople === 1 ? 'person' : 'people'}</span>
          </div>
        )}

        {/* Phone */}
        {res.phone && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Phone className="h-4 w-4 shrink-0" />
            <a href={`tel:${res.phone}`} className="hover:text-foreground transition-colors">{res.phone}</a>
          </div>
        )}

        {/* Confirmation code */}
        {res.confirmationCode && (
          <div className="flex items-center gap-2 text-sm">
            <BookMarked className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="font-mono text-xs bg-muted px-2 py-1 rounded text-foreground">
              {res.confirmationCode}
            </span>
          </div>
        )}

        {/* Notes */}
        {res.notes && (
          <p className="text-sm text-muted-foreground line-clamp-3 leading-relaxed border-t pt-2.5">
            {res.notes}
          </p>
        )}

        {/* Mini map */}
        {res.lat && res.lon && (
          <div className="mt-1">
            <MiniMap lat={res.lat} lon={res.lon} label={res.venue || res.title} />
          </div>
        )}

        {/* Website / booking URL — prominent CTA */}
        {res.url && (
          <a href={res.url} target="_blank" rel="noopener noreferrer"
            className="mt-1 flex items-center justify-center gap-2 w-full py-2 px-3 rounded-xl border border-primary/30 text-primary hover:bg-primary/5 transition-colors text-sm font-medium">
            <Globe className="h-4 w-4" />
            {res.url.includes('booking') || res.url.includes('reserve') || res.url.includes('opentable')
              ? 'View Booking'
              : 'Visit Website'}
          </a>
        )}
      </div>
    </div>
  );
}

// ── Reservation form ──────────────────────────────────────────────────────────

function ReservationForm({
  tripId, reservation, onSuccess, tripDestination,
}: {
  tripId: number;
  reservation?: any;
  onSuccess: () => void;
  tripDestination?: string;
}) {
  const queryClient = useQueryClient();
  const create = useCreateReservation();
  const update = useUpdateReservation();

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: reservation ? {
      type:             reservation.type ?? 'other',
      title:            reservation.title ?? '',
      venue:            reservation.venue ?? '',
      address:          reservation.address ?? '',
      date:             reservation.date ?? '',
      time:             reservation.time ?? '',
      endTime:          reservation.endTime ?? '',
      confirmationCode: reservation.confirmationCode ?? '',
      numberOfPeople:   reservation.numberOfPeople ?? undefined,
      phone:            reservation.phone ?? '',
      notes:            reservation.notes ?? '',
      url:              reservation.url ?? '',
      imageUrl:         reservation.imageUrl ?? '',
      lat:              reservation.lat ?? undefined,
      lon:              reservation.lon ?? undefined,
    } : {
      type: 'restaurant', title: '', venue: '', address: '', date: '', time: '', endTime: '',
      confirmationCode: '', phone: '', notes: '', url: '', imageUrl: '',
    },
  });

  const onSubmit = (values: z.infer<typeof schema>) => {
    const payload = {
      ...values,
      time:             values.time             || undefined,
      endTime:          values.endTime          || undefined,
      confirmationCode: values.confirmationCode || undefined,
      phone:            values.phone            || undefined,
      notes:            values.notes            || undefined,
      url:              values.url              || undefined,
      imageUrl:         values.imageUrl         || undefined,
      venue:            values.venue            || undefined,
      address:          values.address          || undefined,
    };
    const opts = {
      onSuccess: () => {
        toast.success(reservation ? 'Updated' : 'Reservation added');
        invalidateReservationQueries(queryClient, tripId);
        onSuccess();
      },
      onError: () => toast.error('Failed to save'),
    };
    if (reservation) {
      update.mutate({ tripId, reservationId: reservation.id, data: payload }, opts);
    } else {
      create.mutate({ tripId, data: payload as any }, opts);
    }
  };

  const isPending = create.isPending || update.isPending;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
        {/* Type */}
        <FormField control={form.control} name="type" render={({ field }) => (
          <FormItem>
            <FormLabel>Reservation Type</FormLabel>
            <Select value={field.value} onValueChange={field.onChange}>
              <FormControl>
                <SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger>
              </FormControl>
              <SelectContent>
                {(Object.entries(TYPE_META) as [ResType, typeof TYPE_META[ResType]][]).map(([k, v]) => {
                  const Ico = v.icon;
                  return (
                    <SelectItem key={k} value={k}>
                      <div className="flex items-center gap-2">
                        <Ico className="h-4 w-4 text-muted-foreground" />
                        {v.label}
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )} />

        {/* Title */}
        <FormField control={form.control} name="title" render={({ field }) => (
          <FormItem>
            <FormLabel>Reservation Name</FormLabel>
            <FormControl><Input placeholder="e.g. Dinner at Le Bernardin" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Venue autocomplete */}
        <FormField control={form.control} name="venue" render={({ field }) => (
          <FormItem>
            <FormLabel>Venue <span className="font-normal text-muted-foreground">(optional — search to auto-fill details)</span></FormLabel>
            <FormControl>
              <VenueInput
                value={field.value ?? ''}
                onChange={field.onChange}
                near={tripDestination}
                onSelect={s => {
                  form.setValue('venue',   s.name);
                  form.setValue('address', s.address);
                  form.setValue('lat',     s.lat);
                  form.setValue('lon',     s.lon);
                  if (s.phone   && !form.getValues('phone')) form.setValue('phone', s.phone);
                  if (s.website && !form.getValues('url'))   form.setValue('url',   s.website);
                  // Auto-set title from venue name if title is empty
                  if (!form.getValues('title')) form.setValue('title', s.name);
                  // Fetch wiki image
                  fetchWikiImage(s.name).then(url => {
                    if (url && !form.getValues('imageUrl')) form.setValue('imageUrl', url);
                  });
                }}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Address */}
        <FormField control={form.control} name="address" render={({ field }) => (
          <FormItem>
            <FormLabel>Address <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
            <FormControl><Input placeholder="Auto-filled from venue search" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Date & times */}
        <FormField control={form.control} name="date" render={({ field }) => (
          <FormItem>
            <FormLabel>Date</FormLabel>
            <FormControl><Input type="date" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="time" render={({ field }) => (
            <FormItem>
              <FormLabel>Start Time <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
              <FormControl><Input type="time" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="endTime" render={({ field }) => (
            <FormItem>
              <FormLabel>End Time <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
              <FormControl><Input type="time" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        {/* People + phone */}
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="numberOfPeople" render={({ field }) => (
            <FormItem>
              <FormLabel>Number of People <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
              <FormControl>
                <Input type="number" min={1} placeholder="e.g. 2"
                  value={field.value ?? ''}
                  onChange={e => field.onChange(e.target.value ? Number(e.target.value) : undefined)} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="phone" render={({ field }) => (
            <FormItem>
              <FormLabel>Phone <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
              <FormControl><Input placeholder="Auto-filled" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        {/* Confirmation code */}
        <FormField control={form.control} name="confirmationCode" render={({ field }) => (
          <FormItem>
            <FormLabel>Confirmation Code <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
            <FormControl><Input placeholder="e.g. ABC-12345" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Website / booking URL */}
        <FormField control={form.control} name="url" render={({ field }) => (
          <FormItem>
            <FormLabel>Website / Booking URL <span className="font-normal text-muted-foreground">(optional — auto-filled from venue)</span></FormLabel>
            <FormControl><Input placeholder="https://…" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Notes */}
        <FormField control={form.control} name="notes" render={({ field }) => (
          <FormItem>
            <FormLabel>Notes <span className="font-normal text-muted-foreground">(optional)</span></FormLabel>
            <FormControl><Textarea className="h-20 resize-none" placeholder="Dress code, dietary notes, access details…" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isPending}>{isPending ? 'Saving…' : 'Save Reservation'}</Button>
        </div>
      </form>
    </Form>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function TripReservations({
  tripId, editMode, tripDestination,
}: {
  tripId: number;
  editMode?: boolean;
  tripDestination?: string;
}) {
  const { data: reservations, isLoading } = useListReservations(tripId, { query: { queryKey: getListReservationsQueryKey(tripId), enabled: !!tripId } });
  const [isAddOpen, setIsAddOpen] = useState(false);

  // Group by date
  const grouped = useMemo(() => {
    const map: Record<string, any[]> = {};
    (reservations ?? []).forEach((r: any) => {
      if (!map[r.date]) map[r.date] = [];
      map[r.date].push(r);
    });
    return Object.entries(map).sort(([a], [b]) => a.localeCompare(b));
  }, [reservations]);

  if (isLoading) return (
    <div className="flex items-center justify-center py-24 text-muted-foreground text-sm">Loading…</div>
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-serif font-bold">Reservations</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Restaurants, attractions, tours, events and more
          </p>
        </div>
        {(
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" />Add Reservation</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
              <DialogHeader><DialogTitle>New Reservation</DialogTitle></DialogHeader>
              <ReservationForm tripId={tripId} tripDestination={tripDestination} onSuccess={() => setIsAddOpen(false)} />
            </DialogContent>
          </Dialog>
        )}
      </div>

      {/* Empty state */}
      {grouped.length === 0 && (
        <div className="text-center py-20 bg-muted/50 rounded-2xl border border-dashed">
          <ClipboardList className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
          <p className="font-semibold">No reservations yet</p>
          <p className="text-muted-foreground text-sm mt-1">
            Add restaurants, tours, events, spa bookings and more.
          </p>
          {(
            <Button className="mt-4" onClick={() => setIsAddOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />Add First Reservation
            </Button>
          )}
        </div>
      )}

      {/* Date groups */}
      {grouped.map(([date, items]) => (
        <div key={date}>
          <div className="flex items-center gap-3 mb-4">
            <div className="h-px flex-1 bg-border" />
            <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground px-2">
              <CalendarDays className="h-4 w-4" />
              {format(parseISO(date), 'EEEE, MMMM d, yyyy')}
            </div>
            <div className="h-px flex-1 bg-border" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {items
              .sort((a: any, b: any) => (a.time ?? '00:00').localeCompare(b.time ?? '00:00'))
              .map((r: any) => (
                <ReservationCard key={r.id} tripId={tripId} res={r} editMode={editMode} />
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
