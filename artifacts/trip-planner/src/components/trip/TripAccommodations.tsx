import { useListAccommodations, useCreateAccommodation, useUpdateAccommodation, useDeleteAccommodation, getListAccommodationsQueryKey } from '@workspace/api-client-react';
import { ImageEditor } from '@/components/ImageEditor';
import { useState, useEffect, useRef } from 'react';
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
import { Home, MapPin, Calendar, Plus, Trash2, Pencil, Phone } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { MiniMap } from './MiniMap';
import { fetchWikiImage } from '@/lib/wiki-image';

const API_BASE = `${import.meta.env.BASE_URL}api`;

const DEFAULT_CHECKIN_TIME  = '15:00';
const DEFAULT_CHECKOUT_TIME = '11:00';

const STAY_GRADIENTS: Record<string, [string, string]> = {
  hotel:  ['#f59e0b', '#ea580c'],
  airbnb: ['#fb7185', '#db2777'],
  hostel: ['#38bdf8', '#2563eb'],
  resort: ['#2dd4bf', '#059669'],
  other:  ['#94a3b8', '#475569'],
};

const accommSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  address: z.string().min(1, 'Address is required'),
  phone: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  imageUrl: z.string().optional(),
  checkInDate:  z.string().min(1, 'Check-in date is required'),
  checkInTime:  z.string().min(1, 'Check-in time is required'),
  checkOutDate: z.string().min(1, 'Check-out date is required'),
  checkOutTime: z.string().min(1, 'Check-out time is required'),
  type: z.enum(['hotel', 'airbnb', 'hostel', 'resort', 'other']).optional(),
  confirmationCode: z.string().optional(),
});

// ── Hotel name autocomplete ───────────────────────────────────────────────────

interface HotelSuggestion {
  name: string;
  address: string;
  phone: string | null;
  lat: number;
  lon: number;
}

function HotelNameInput({
  value,
  onChange,
  onSelect,
}: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (s: HotelSuggestion) => void;
}) {
  const [suggestions, setSuggestions] = useState<HotelSuggestion[]>([]);
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
        const res = await fetch(`${API_BASE}/search/hotels?q=${encodeURIComponent(value)}`);
        if (res.ok) {
          const data: HotelSuggestion[] = await res.json();
          setSuggestions(data);
          setOpen(data.length > 0);
        }
      } catch {
        // ignore, user can type manually
      } finally {
        setLoading(false);
      }
    }, 400);
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
          placeholder="e.g. Marriott Tokyo"
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
                onSelect(s);
                setOpen(false);
              }}
            >
              <p className="font-medium leading-none">{s.name}</p>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{s.address}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export function TripAccommodations({ tripId, editMode, tripStartDate, tripEndDate }: { tripId: number, editMode?: boolean, tripStartDate?: string, tripEndDate?: string }) {
  const { data: stays, isLoading } = useListAccommodations(tripId, { query: { enabled: !!tripId } });
  const [isAddOpen, setIsAddOpen] = useState(false);

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="space-y-6">
      {editMode && (
        <div className="flex justify-end">
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Stay</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Add Accommodation</DialogTitle></DialogHeader>
              <AccommForm tripId={tripId} tripStartDate={tripStartDate} tripEndDate={tripEndDate} onSuccess={() => setIsAddOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      )}

      {(!stays || stays.length === 0) ? (
         <div className="text-center py-12 bg-muted/50 rounded-xl border border-dashed">
           <Home className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
           <p className="text-lg font-medium">No places to stay</p>
         </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-6">
          {stays.map(stay => (
            <AccommCard key={stay.id} tripId={tripId} stay={stay} editMode={editMode} tripStartDate={tripStartDate} tripEndDate={tripEndDate} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

function AccommCard({ tripId, stay, editMode, tripStartDate, tripEndDate }: { tripId: number, stay: any, editMode?: boolean, tripStartDate?: string, tripEndDate?: string }) {
  const queryClient = useQueryClient();
  const deleteStay = useDeleteAccommodation();
  const updateStayImg = useUpdateAccommodation();
  const [isEditOpen, setIsEditOpen] = useState(false);

  const handleImageSave = (url: string | null) => {
    updateStayImg.mutate({ tripId, accommodationId: stay.id, data: { imageUrl: url ?? '' } }, {
      onSuccess: () => { toast.success('Image updated'); queryClient.invalidateQueries({ queryKey: getListAccommodationsQueryKey(tripId) }); },
      onError: () => toast.error('Failed to update image'),
    });
  };

  const handleDelete = () => {
    if (confirm('Delete this accommodation?')) {
      deleteStay.mutate({ tripId, accommodationId: stay.id }, {
        onSuccess: () => {
          toast.success('Deleted');
          queryClient.invalidateQueries({ queryKey: getListAccommodationsQueryKey(tripId) });
        }
      });
    }
  };

  const [gradFrom, gradTo] = STAY_GRADIENTS[stay.type ?? 'other'] ?? STAY_GRADIENTS.other;
  const hasMap = stay.lat != null && stay.lon != null;

  // Auto-fetch a wiki image for existing records that don't have one stored
  const [liveImage, setLiveImage] = useState<string | null>(null);
  useEffect(() => {
    if (stay.imageUrl) return;
    fetchWikiImage(stay.name).then(url => { if (url) setLiveImage(url); });
  }, [stay.id, stay.imageUrl]);
  const displayImage = stay.imageUrl || liveImage;

  return (
    <div className="bg-card border rounded-xl shadow-sm overflow-hidden relative group">
      {/* ── Image / gradient header ── */}
      <div className="relative h-40">
        {displayImage ? (
          <img
            src={displayImage}
            alt={stay.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            style={{ background: `linear-gradient(to bottom right, ${gradFrom}, ${gradTo})` }}
            className="h-full w-full flex items-center justify-center"
          >
            <Home className="h-12 w-12 text-white/50" />
          </div>
        )}
        {/* Edit / delete overlay */}
        {editMode && (
          <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
              <DialogTrigger asChild>
                <Button variant="secondary" size="icon" className="h-8 w-8 bg-white/90 hover:bg-white text-foreground shadow">
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[90vh] overflow-y-auto">
                <DialogHeader><DialogTitle>Edit Stay</DialogTitle></DialogHeader>
                <AccommForm tripId={tripId} stay={stay} tripStartDate={tripStartDate} tripEndDate={tripEndDate} onSuccess={() => setIsEditOpen(false)} />
              </DialogContent>
            </Dialog>
            <ImageEditor searchHint={stay.name} onSave={handleImageSave} />
            <Button
              variant="secondary"
              size="icon"
              onClick={handleDelete}
              className="h-8 w-8 bg-white/90 hover:bg-white text-destructive hover:text-destructive shadow"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
        {/* Type badge */}
        <span className="absolute bottom-2 left-3 text-xs font-semibold text-white uppercase tracking-wider drop-shadow">
          {stay.type}
        </span>
      </div>

      {/* ── Card body ── */}
      <div className="p-5 space-y-3">
        <h3 className="font-serif text-xl font-semibold leading-tight">{stay.name}</h3>

        <div className="space-y-2 text-sm text-muted-foreground">
          <div className="flex items-start gap-2">
            <MapPin className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{stay.address}</span>
          </div>
          {stay.phone && (
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 shrink-0" />
              <a href={`tel:${stay.phone}`} className="hover:text-foreground transition-colors">{stay.phone}</a>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Calendar className="h-4 w-4 shrink-0" />
            <span>{format(parseISO(stay.checkIn), 'MMM d')} – {format(parseISO(stay.checkOut), 'MMM d')}</span>
          </div>
          {stay.confirmationCode && (
            <div className="bg-muted px-2 py-1.5 rounded text-xs font-mono inline-block">
              Code: {stay.confirmationCode}
            </div>
          )}
        </div>
      </div>

      {/* ── Mini map ── */}
      {hasMap && <MiniMap lat={stay.lat} lon={stay.lon} label={stay.name} />}
    </div>
  );
}

// ── Form ──────────────────────────────────────────────────────────────────────

function AccommForm({ tripId, stay, tripStartDate, tripEndDate, onSuccess }: { tripId: number, stay?: any, tripStartDate?: string, tripEndDate?: string, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createStay = useCreateAccommodation();
  const updateStay = useUpdateAccommodation();

  const splitDateTime = (iso: string, defaultTime: string) => {
    const local = iso.slice(0, 16);
    if (local.length >= 16) return { date: local.slice(0, 10), time: local.slice(11, 16) };
    return { date: '', time: defaultTime };
  };

  const form = useForm<z.infer<typeof accommSchema>>({
    resolver: zodResolver(accommSchema),
    defaultValues: stay ? (() => {
      const ci = splitDateTime(stay.checkIn,  DEFAULT_CHECKIN_TIME);
      const co = splitDateTime(stay.checkOut, DEFAULT_CHECKOUT_TIME);
      return {
        ...stay,
        phone: stay.phone ?? '',
        lat: stay.lat ?? undefined,
        lon: stay.lon ?? undefined,
        imageUrl: stay.imageUrl ?? undefined,
        checkInDate:  ci.date,
        checkInTime:  ci.time,
        checkOutDate: co.date,
        checkOutTime: co.time,
      };
    })() : {
      name: '', address: '', phone: '',
      checkInDate: '', checkInTime: DEFAULT_CHECKIN_TIME,
      checkOutDate: '', checkOutTime: DEFAULT_CHECKOUT_TIME,
      type: 'hotel' as const, confirmationCode: '',
    },
  });

  const onSubmit = (values: z.infer<typeof accommSchema>) => {
    const payload = {
      name: values.name,
      address: values.address,
      phone: values.phone || undefined,
      type: values.type,
      confirmationCode: values.confirmationCode || undefined,
      lat: values.lat,
      lon: values.lon,
      imageUrl: values.imageUrl || undefined,
      checkIn:  new Date(`${values.checkInDate}T${values.checkInTime}`).toISOString(),
      checkOut: new Date(`${values.checkOutDate}T${values.checkOutTime}`).toISOString(),
    };

    if (stay) {
      updateStay.mutate({ tripId, accommodationId: stay.id, data: payload }, {
        onSuccess: () => { toast.success('Updated'); queryClient.invalidateQueries({ queryKey: getListAccommodationsQueryKey(tripId) }); onSuccess(); }
      });
    } else {
      createStay.mutate({ tripId, data: payload }, {
        onSuccess: () => { toast.success('Added'); queryClient.invalidateQueries({ queryKey: getListAccommodationsQueryKey(tripId) }); onSuccess(); }
      });
    }
  };

  const isPending = createStay.isPending || updateStay.isPending;
  const checkInDate = form.watch('checkInDate');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">

        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem>
            <FormLabel>Hotel / Property Name</FormLabel>
            <FormControl>
              <HotelNameInput
                value={field.value}
                onChange={field.onChange}
                onSelect={s => {
                  form.setValue('name', s.name);
                  form.setValue('address', s.address);
                  form.setValue('phone', s.phone ?? '');
                  form.setValue('lat', s.lat);
                  form.setValue('lon', s.lon);
                  // Fetch Wikipedia image in background
                  fetchWikiImage(s.name).then(url => {
                    if (url) form.setValue('imageUrl', url);
                  });
                }}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <FormField control={form.control} name="address" render={({ field }) => (
          <FormItem><FormLabel>Address</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />

        <FormField control={form.control} name="phone" render={({ field }) => (
          <FormItem><FormLabel>Phone</FormLabel><FormControl><Input type="tel" placeholder="+1 212 555 0100" {...field} /></FormControl><FormMessage /></FormItem>
        )} />

        {/* Check-in */}
        <div>
          <p className="text-sm font-medium mb-1.5">Check-in</p>
          <div className="grid grid-cols-2 gap-2">
            <FormField control={form.control} name="checkInDate" render={({ field }) => (
              <FormItem><FormControl><Input type="date" min={tripStartDate} max={tripEndDate} {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="checkInTime" render={({ field }) => (
              <FormItem><FormControl><Input type="time" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
          </div>
        </div>

        {/* Check-out */}
        <div>
          <p className="text-sm font-medium mb-1.5">Check-out</p>
          <div className="grid grid-cols-2 gap-2">
            <FormField control={form.control} name="checkOutDate" render={({ field }) => (
              <FormItem><FormControl><Input type="date" min={checkInDate || tripStartDate} max={tripEndDate} {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="checkOutTime" render={({ field }) => (
              <FormItem><FormControl><Input type="time" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="type" render={({ field }) => (
            <FormItem><FormLabel>Type</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  <SelectItem value="hotel">Hotel</SelectItem>
                  <SelectItem value="airbnb">Airbnb</SelectItem>
                  <SelectItem value="hostel">Hostel</SelectItem>
                  <SelectItem value="resort">Resort</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
            <FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="confirmationCode" render={({ field }) => (
            <FormItem><FormLabel>Confirmation Code <span className="text-muted-foreground font-normal">(optional)</span></FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>

        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={isPending}>{isPending ? 'Saving...' : 'Save Stay'}</Button>
        </div>
      </form>
    </Form>
  );
}
