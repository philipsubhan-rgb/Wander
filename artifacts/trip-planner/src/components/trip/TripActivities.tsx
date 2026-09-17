import { useListActivities, useCreateActivity, useUpdateActivity, useDeleteActivity } from '@workspace/api-client-react';
import { invalidateActivityQueries } from '@/lib/invalidate-trip-queries';
import { ImagePickerContent } from '@/components/ImageEditor';
import { useState, useEffect, useRef, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Compass, MapPin, Clock, Plus, Trash2, Pencil, Camera, CalendarDays, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { MiniMap } from './MiniMap';
import { fetchWikiImage } from '@/lib/wiki-image';
import { useAuth } from '@/hooks/use-auth';

const API_BASE = `${import.meta.env.BASE_URL}api`;

const ACTIVITY_GRADIENTS: Record<string, [string, string]> = {
  sightseeing: ['#60a5fa', '#4f46e5'],
  dining:      ['#fb923c', '#dc2626'],
  adventure:   ['#4ade80', '#059669'],
  culture:     ['#c084fc', '#7c3aed'],
  relaxation:  ['#2dd4bf', '#0891b2'],
  transport:   ['#94a3b8', '#4b5563'],
  other:       ['#a8a29e', '#78716c'],
};

const activitySchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  date: z.string().min(1, 'Date is required'),
  time: z.string().optional(),
  location: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  imageUrl: z.string().optional(),
  locationUrl: z.string().optional(),
  type: z.enum(['sightseeing', 'dining', 'adventure', 'culture', 'relaxation', 'transport', 'other']).optional(),
});

// ── Location autocomplete ─────────────────────────────────────────────────────

interface PlaceSuggestion {
  name: string;
  address: string;
  lat: number;
  lon: number;
}

function LocationInput({
  value,
  onChange,
  onSelect,
  near,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect?: (s: PlaceSuggestion) => void;
  near?: string;
}) {
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.length < 3) { setSuggestions([]); setOpen(false); return; }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const url = `${API_BASE}/search/places?q=${encodeURIComponent(value)}${near ? `&near=${encodeURIComponent(near)}` : ''}`;
        const res = await fetch(url);
        if (res.ok) {
          const data: PlaceSuggestion[] = await res.json();
          setSuggestions(data);
          setOpen(data.length > 0);
        }
      } catch {
        // silently ignore — user can still type manually
      } finally {
        setLoading(false);
      }
    }, 350);
  }, [value]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="e.g. BMW Museum, Munich"
          autoComplete="off"
        />
        {loading && (
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">…</span>
        )}
      </div>
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md overflow-hidden">
          {suggestions.map((s, i) => (
            <li
              key={i}
              className="px-3 py-2.5 cursor-pointer hover:bg-accent text-sm"
              onMouseDown={e => {
                e.preventDefault();
                const label = s.address ? `${s.name}, ${s.address}` : s.name;
                onChange(label);
                onSelect?.(s);
                setOpen(false);
              }}
            >
              <p className="font-medium leading-none">{s.name}</p>
              {s.address && (
                <p className="text-xs text-muted-foreground mt-0.5 truncate">{s.address}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function TripActivities({ tripId, editMode, tripStartDate, tripEndDate, tripDestination }: { tripId: number, editMode?: boolean, tripStartDate?: string, tripEndDate?: string, tripDestination?: string }) {
  const { data: activities, isLoading } = useListActivities(tripId, { query: { enabled: !!tripId } });
  const [isAddOpen, setIsAddOpen] = useState(false);

  // Copy before sorting: sorting the React Query cache array in place corrupts
  // the cached data identity for every other consumer of this query.
  // NOTE: this hook must stay above the early return — calling it conditionally
  // breaks hook order and crashes the tab once loading finishes.
  const sortedActivities = useMemo(
    () => [...(activities ?? [])].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime()),
    [activities],
  );

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="space-y-6">
      {(
        <div className="flex justify-end">
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Activity</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add Activity</DialogTitle></DialogHeader>
              <ActivityForm tripId={tripId} tripStartDate={tripStartDate} tripEndDate={tripEndDate} tripDestination={tripDestination} onSuccess={() => setIsAddOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      )}

      {(!sortedActivities || sortedActivities.length === 0) ? (
         <div className="text-center py-12 bg-muted/50 rounded-xl border border-dashed">
           <Compass className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
           <p className="text-lg font-medium">No activities planned</p>
         </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {sortedActivities.map(activity => (
            <ActivityCard key={activity.id} tripId={tripId} activity={activity} editMode={editMode} tripStartDate={tripStartDate} tripEndDate={tripEndDate} tripDestination={tripDestination} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

function ActivityCard({ tripId, activity, editMode, tripStartDate, tripEndDate, tripDestination }: { tripId: number, activity: any, editMode?: boolean, tripStartDate?: string, tripEndDate?: string, tripDestination?: string }) {
  const queryClient = useQueryClient();
  const deleteActivity = useDeleteActivity();
  const updateActivity = useUpdateActivity();
  const [cardDialog, setCardDialog] = useState<'none' | 'edit' | 'image'>('none');
  const [isExpanded, setIsExpanded] = useState(false);

  const handleImageSave = (url: string | null) => {
    updateActivity.mutate({ tripId, activityId: activity.id, data: { imageUrl: url ?? '' } }, {
      onSuccess: () => { toast.success('Image updated'); invalidateActivityQueries(queryClient, tripId); },
      onError: () => toast.error('Failed to update image'),
    });
  };

  const handleDelete = () => {
    if (confirm('Delete this activity?')) {
      deleteActivity.mutate({ tripId, activityId: activity.id }, {
        onSuccess: () => {
          toast.success('Deleted');
          invalidateActivityQueries(queryClient, tripId);
        }
      });
    }
  };

  const [gradFrom, gradTo] = ACTIVITY_GRADIENTS[activity.type ?? 'other'] ?? ACTIVITY_GRADIENTS.other;

  // Auto-fetch wiki image for records without one
  const [liveImage, setLiveImage] = useState<string | null>(null);
  useEffect(() => {
    if (activity.imageUrl) return;
    const query = activity.location || activity.title;
    fetchWikiImage(query).then(url => { if (url) setLiveImage(url); });
  }, [activity.id, activity.imageUrl]);
  const displayImage = activity.imageUrl || liveImage;

  // Auto-geocode location text for records that have no lat/lon yet
  const [geoCoords, setGeoCoords] = useState<{ lat: number; lon: number } | null>(null);
  useEffect(() => {
    if (activity.lat != null && activity.lon != null) return;
    if (!activity.location) return;
    fetch(`${API_BASE}/search/places?q=${encodeURIComponent(activity.location)}`)
      .then(r => r.ok ? r.json() : [])
      .then((results: { lat: number; lon: number }[]) => {
        if (results[0]) setGeoCoords({ lat: results[0].lat, lon: results[0].lon });
      })
      .catch(() => {});
  }, [activity.id, activity.lat, activity.lon, activity.location]);

  const mapLat: number | null = activity.lat ?? geoCoords?.lat ?? null;
  const mapLon: number | null = activity.lon ?? geoCoords?.lon ?? null;
  const hasMap = mapLat != null && mapLon != null;

  const mapsUrl: string | null =
    activity.locationUrl ||
    (mapLat != null && mapLon != null ? `https://maps.google.com/?q=${mapLat},${mapLon}` : null) ||
    (activity.location ? `https://maps.google.com/?q=${encodeURIComponent(activity.location)}` : null);

  const timeFmt = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
  };

  return (
    <div className="bg-card border rounded-xl shadow-sm overflow-hidden relative group hover:border-primary/50 transition-colors">
      {/* ── Image / gradient header ── */}
      <div className="relative h-36">
        {displayImage ? (
          <img src={displayImage} alt={activity.title} className="h-full w-full object-cover" />
        ) : (
          <div style={{ background: `linear-gradient(to bottom right, ${gradFrom}, ${gradTo})` }}
            className="h-full w-full flex items-center justify-center">
            <Compass className="h-10 w-10 text-white/50" />
          </div>
        )}
        {/* Dark overlay gradient for text readability */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />

        {/* Edit / delete overlay — single Dialog avoids sibling-Dialog Radix conflicts */}
        {(
          <>
            <Dialog open={cardDialog !== 'none'} onOpenChange={open => { if (!open) setCardDialog('none'); }}>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{cardDialog === 'edit' ? 'Edit Activity' : 'Edit Image'}</DialogTitle>
                </DialogHeader>
                {cardDialog === 'edit' && (
                  <ActivityForm tripId={tripId} activity={activity} tripStartDate={tripStartDate} tripEndDate={tripEndDate} tripDestination={tripDestination} onSuccess={() => setCardDialog('none')} />
                )}
                {cardDialog === 'image' && (
                  <ImagePickerContent searchHint={activity.location || activity.title} onSave={url => { handleImageSave(url); setCardDialog('none'); }} onCancel={() => setCardDialog('none')} />
                )}
              </DialogContent>
            </Dialog>
            <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button variant="secondary" size="icon" onClick={() => setCardDialog('edit')} className="h-8 w-8 bg-white/90 hover:bg-white text-foreground shadow">
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button variant="secondary" size="icon" onClick={() => setCardDialog('image')} className="h-8 w-8 bg-white/90 hover:bg-white text-foreground shadow" title="Change image">
                <Camera className="h-3.5 w-3.5" />
              </Button>
              <Button variant="secondary" size="icon" onClick={handleDelete} className="h-8 w-8 bg-white/90 hover:bg-white text-destructive hover:text-destructive shadow">
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </>
        )}

        {/* Type badge */}
        <span className="absolute bottom-2 left-3 text-xs font-semibold text-white uppercase tracking-wider drop-shadow">
          {activity.type}
        </span>
      </div>

      {/* ── Card body ── */}
      <div className="p-4 space-y-3">
        <h3 className="font-serif text-lg font-semibold leading-tight">{activity.title}</h3>

        <div className="space-y-1.5 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 text-foreground font-medium">
            <CalendarDays className="h-4 w-4 text-primary shrink-0" />
            <span>{format(parseISO(activity.date), 'MMM d, yyyy')}</span>
            {activity.time && (
              <>
                <span className="text-muted-foreground">·</span>
                <Clock className="h-4 w-4 text-primary shrink-0" />
                <span>{timeFmt(activity.time)}</span>
              </>
            )}
          </div>
          {activity.location && (
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 shrink-0 mt-0.5" />
              <span className={`flex-1 ${isExpanded ? '' : 'line-clamp-1'}`}>{activity.location}</span>
              {mapsUrl && (
                <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
                  className="shrink-0 text-primary hover:text-primary/80 transition-colors"
                  title="Open in Google Maps" onClick={e => e.stopPropagation()}>
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
            </div>
          )}
        </div>

        {activity.description && (
          <p className={`text-sm text-muted-foreground border-t pt-3 ${isExpanded ? '' : 'line-clamp-2'}`}>
            {activity.description}
          </p>
        )}

        {/* ── Expanded content ── */}
        {isExpanded && (
          <div className="space-y-3 pt-1">
            {hasMap && (
              <div className="rounded-lg overflow-hidden border">
                <MiniMap lat={mapLat!} lon={mapLon!} label={activity.location ?? activity.title} />
              </div>
            )}
            {mapsUrl && (
              <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full py-2 px-3 rounded-lg border border-primary/30 text-primary hover:bg-primary/5 transition-colors text-sm font-medium">
                <ExternalLink className="h-4 w-4" />
                Open in Google Maps
              </a>
            )}
          </div>
        )}

        {/* ── Expand / collapse toggle ── */}
        <button
          onClick={() => setIsExpanded(prev => !prev)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-1 w-full justify-center pt-1 border-t"
        >
          {isExpanded ? (
            <><ChevronUp className="h-3.5 w-3.5" /> Show less</>
          ) : (
            <><ChevronDown className="h-3.5 w-3.5" /> Show more</>
          )}
        </button>
      </div>
    </div>
  );
}

// ── Form ──────────────────────────────────────────────────────────────────────

function ActivityForm({ tripId, activity, tripStartDate, tripEndDate, tripDestination, onSuccess }: { tripId: number, activity?: any, tripStartDate?: string, tripEndDate?: string, tripDestination?: string, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createActivity = useCreateActivity();
  const updateActivity = useUpdateActivity();

  const form = useForm<z.infer<typeof activitySchema>>({
    resolver: zodResolver(activitySchema),
    defaultValues: activity ? {
      title:       activity.title       ?? '',
      description: activity.description ?? '',
      // Slice to YYYY-MM-DD — <input type="date"> rejects ISO timestamps
      date:        activity.date ? String(activity.date).substring(0, 10) : '',
      // Strip seconds from HH:MM:SS if present
      time:        activity.time ? String(activity.time).substring(0, 5) : '',
      location:    activity.location    ?? '',
      type:        (activity.type ?? 'sightseeing') as 'sightseeing' | 'dining' | 'adventure' | 'culture' | 'relaxation' | 'transport' | 'other',
      lat:         activity.lat         ?? undefined,
      lon:         activity.lon         ?? undefined,
      imageUrl:    activity.imageUrl    ?? undefined,
      locationUrl: activity.locationUrl ?? undefined,
    } : {
      title: '', description: '', date: '', time: '', location: '', type: 'sightseeing' as const,
    },
  });

  const onSubmit = (values: z.infer<typeof activitySchema>) => {
    // Normalize optional fields: convert empty strings → undefined so the server
    // doesn't overwrite nullable columns with empty text.
    const data = {
      ...values,
      time:        values.time        || undefined,
      description: values.description || undefined,
      location:    values.location    || undefined,
      locationUrl: values.locationUrl || undefined,
      imageUrl:    values.imageUrl    || undefined,
    };
    if (activity) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      updateActivity.mutate({ tripId, activityId: activity.id, data: data as any }, {
        onSuccess: () => { toast.success('Activity updated'); invalidateActivityQueries(queryClient, tripId); onSuccess(); },
        onError: (err: unknown) => { const msg = err instanceof Error ? err.message : 'Unknown error'; toast.error(`Failed to save: ${msg}`); },
      });
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createActivity.mutate({ tripId, data: data as any }, {
        onSuccess: () => { toast.success('Activity added'); invalidateActivityQueries(queryClient, tripId); onSuccess(); },
        onError: (err: unknown) => { const msg = err instanceof Error ? err.message : 'Unknown error'; toast.error(`Failed to add: ${msg}`); },
      });
    }
  };

  const isPending = createActivity.isPending || updateActivity.isPending;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
        <FormField control={form.control} name="title" render={({ field }) => (
          <FormItem><FormLabel>Title</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="date" render={({ field }) => (
            <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" min={tripStartDate} max={tripEndDate} {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="time" render={({ field }) => (
            <FormItem><FormLabel>Time</FormLabel><FormControl><Input type="time" {...field} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>
        <FormField control={form.control} name="location" render={({ field }) => (
          <FormItem>
            <FormLabel>Location</FormLabel>
            <FormControl>
              <LocationInput
                value={field.value ?? ''}
                onChange={field.onChange}
                near={tripDestination}
                onSelect={s => {
                  field.onChange(`${s.name}, ${s.address}`);
                  form.setValue('lat', s.lat);
                  form.setValue('lon', s.lon);
                  form.setValue('locationUrl', `https://maps.google.com/?q=${s.lat},${s.lon}`);
                  fetchWikiImage(s.name).then(url => {
                    if (url) form.setValue('imageUrl', url);
                  });
                }}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="type" render={({ field }) => (
          <FormItem><FormLabel>Type</FormLabel>
            <Select onValueChange={field.onChange} value={field.value ?? 'other'}>
              <FormControl><SelectTrigger><SelectValue placeholder="Select type" /></SelectTrigger></FormControl>
              <SelectContent>
                <SelectItem value="sightseeing">Sightseeing</SelectItem>
                <SelectItem value="dining">Dining</SelectItem>
                <SelectItem value="adventure">Adventure</SelectItem>
                <SelectItem value="culture">Culture</SelectItem>
                <SelectItem value="relaxation">Relaxation</SelectItem>
                <SelectItem value="transport">Transport</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          <FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="locationUrl" render={({ field }) => (
          <FormItem>
            <FormLabel>Maps URL <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
            <FormControl>
              <Input
                {...field}
                value={field.value ?? ''}
                placeholder="Auto-filled when you pick from autocomplete, or paste any URL"
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="description" render={({ field }) => (
          <FormItem><FormLabel>Notes / Description</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={isPending}>{isPending ? 'Saving...' : 'Save Activity'}</Button>
        </div>
      </form>
    </Form>
  );
}
