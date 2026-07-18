import { useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { format, parseISO } from 'date-fns';
import { Car, MapPin, Clock, Plus, Trash2, Pencil, Camera, Phone, ExternalLink, ArrowRight } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MiniMap } from './MiniMap';
import { useAuth } from '@/hooks/use-auth';
import { carRentalLogoUrl } from '@/lib/car-rental-logo';
import { fetchWikiImage } from '@/lib/wiki-image';
import { ImagePickerContent } from '@/components/ImageEditor';
import {
  useListCarRentals,
  useCreateCarRental,
  useUpdateCarRental,
  useDeleteCarRental,
  getListCarRentalsQueryKey,
} from '@workspace/api-client-react';

const API_BASE = `${import.meta.env.BASE_URL}api`;

// ── Gradients per car type ─────────────────────────────────────────────────────

const CAR_GRADIENTS: Record<string, [string, string]> = {
  economy:     ['#38bdf8', '#0284c7'],
  compact:     ['#4ade80', '#16a34a'],
  midsize:     ['#fbbf24', '#d97706'],
  fullsize:    ['#94a3b8', '#475569'],
  suv:         ['#a78bfa', '#7c3aed'],
  luxury:      ['#f472b6', '#db2777'],
  van:         ['#2dd4bf', '#0891b2'],
  convertible: ['#fb923c', '#ea580c'],
  other:       ['#a8a29e', '#78716c'],
};

const CAR_TYPE_LABELS: Record<string, string> = {
  economy: 'Economy', compact: 'Compact', midsize: 'Midsize',
  fullsize: 'Full-size', suv: 'SUV', luxury: 'Luxury',
  van: 'Van', convertible: 'Convertible', other: 'Other',
};

// ── Form schema ────────────────────────────────────────────────────────────────

const carRentalSchema = z.object({
  company: z.string().min(1, 'Company is required'),
  pickupLocation: z.string().min(1, 'Pickup location is required'),
  dropoffLocation: z.string().optional(),
  pickupDate: z.string().min(1, 'Pickup date is required'),
  pickupTime: z.string().min(1, 'Pickup time is required'),
  dropoffDate: z.string().min(1, 'Drop-off date is required'),
  dropoffTime: z.string().min(1, 'Drop-off time is required'),
  carType: z.enum(['economy', 'compact', 'midsize', 'fullsize', 'suv', 'luxury', 'van', 'convertible', 'other']).optional(),
  confirmationCode: z.string().optional(),
  driverName: z.string().optional(),
  phone: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
  imageUrl: z.string().optional(),
  notes: z.string().optional(),
});

// ── Company autocomplete ───────────────────────────────────────────────────────

interface CompanySuggestion { name: string; address: string; phone: string | null; lat: number; lon: number; }

function CompanyInput({ value, onChange, onSelect, tripDestination }: {
  value: string;
  onChange: (v: string) => void;
  onSelect: (s: CompanySuggestion) => void;
  tripDestination?: string;
}) {
  const [suggestions, setSuggestions] = useState<CompanySuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.length < 2) { setSuggestions([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const qs = new URLSearchParams({ q: value });
        if (tripDestination) qs.set('near', tripDestination);
        const res = await fetch(`${API_BASE}/search/car-rentals?${qs}`);
        if (res.ok) {
          const data: CompanySuggestion[] = await res.json();
          setSuggestions(data);
          setOpen(data.length > 0);
        }
      } catch { /* ignore */ } finally { setLoading(false); }
    }, 400);
  }, [value, tripDestination]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input value={value} onChange={e => onChange(e.target.value)} placeholder="e.g. Hertz, Sixt, Europcar…" autoComplete="off" />
        {loading && <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">…</span>}
      </div>
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md overflow-hidden">
          {suggestions.map((s, i) => (
            <li key={i} className="px-3 py-2.5 cursor-pointer hover:bg-accent text-sm"
              onMouseDown={e => { e.preventDefault(); onSelect(s); setOpen(false); }}>
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

export function TripCarRentals({ tripId, editMode, tripStartDate, tripEndDate, tripDestination }: {
  tripId: number; editMode?: boolean; tripStartDate?: string; tripEndDate?: string; tripDestination?: string;
}) {
  const { data: rentals, isLoading } = useListCarRentals(tripId, { query: { enabled: !!tripId } });
  const [isAddOpen, setIsAddOpen] = useState(false);

  if (isLoading) return <div>Loading...</div>;

  return (
    <div className="space-y-6">
      {(
        <div className="flex justify-end">
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Car Rental</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Add Car Rental</DialogTitle></DialogHeader>
              <CarRentalForm tripId={tripId} tripStartDate={tripStartDate} tripEndDate={tripEndDate} tripDestination={tripDestination} onSuccess={() => setIsAddOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      )}

      {(!rentals || rentals.length === 0) ? (
        <div className="text-center py-12 bg-muted/50 rounded-xl border border-dashed">
          <Car className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
          <p className="text-lg font-medium">No car rentals yet</p>
        </div>
      ) : (
        <div className="grid md:grid-cols-2 gap-6">
          {rentals.map(rental => (
            <CarRentalCard key={rental.id} tripId={tripId} rental={rental} editMode={editMode}
              tripStartDate={tripStartDate} tripEndDate={tripEndDate} tripDestination={tripDestination} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

function CarRentalCard({ tripId, rental, editMode, tripStartDate, tripEndDate, tripDestination }: {
  tripId: number; rental: any; editMode?: boolean; tripStartDate?: string; tripEndDate?: string; tripDestination?: string;
}) {
  const queryClient = useQueryClient();
  const deleteRental = useDeleteCarRental();
  const updateRentalImg = useUpdateCarRental();
  const [cardDialog, setCardDialog] = useState<'none' | 'edit' | 'image'>('none');

  const handleImageSave = (url: string | null) => {
    updateRentalImg.mutate({ tripId, carRentalId: rental.id, data: { imageUrl: url ?? '' } }, {
      onSuccess: () => { toast.success('Image updated'); queryClient.invalidateQueries({ queryKey: getListCarRentalsQueryKey(tripId) }); },
      onError: () => toast.error('Failed to update image'),
    });
  };

  const handleDelete = () => {
    if (confirm('Delete this car rental?')) {
      deleteRental.mutate({ tripId, carRentalId: rental.id }, {
        onSuccess: () => { toast.success('Deleted'); queryClient.invalidateQueries({ queryKey: getListCarRentalsQueryKey(tripId) }); }
      });
    }
  };

  const [gradFrom, gradTo] = CAR_GRADIENTS[rental.carType ?? 'other'] ?? CAR_GRADIENTS.other;
  const hasMap = rental.lat != null && rental.lon != null;

  // Logo: use stored imageUrl if admin picked one, otherwise derive from company name via Clearbit
  const logoUrl = rental.imageUrl || carRentalLogoUrl(rental.company);
  const [logoError, setLogoError] = useState(false);

  const pickup  = parseISO(rental.pickupDatetime);
  const dropoff = parseISO(rental.dropoffDatetime);
  const sameLocation = !rental.dropoffLocation || rental.dropoffLocation === rental.pickupLocation;

  const mapsUrl = rental.lat != null && rental.lon != null
    ? `https://maps.google.com/?q=${rental.lat},${rental.lon}`
    : `https://maps.google.com/?q=${encodeURIComponent(rental.pickupLocation)}`;

  return (
    <div className="bg-card border rounded-xl shadow-sm overflow-hidden relative group hover:border-primary/50 transition-colors">
      {/* ── Header ── */}
      <div className="relative h-36"
        style={{ background: `linear-gradient(to bottom right, ${gradFrom}, ${gradTo})` }}>
        <div className="h-full w-full flex items-center justify-center p-4">
          {!logoError ? (
            <img
              src={logoUrl}
              alt={rental.company}
              className="h-14 w-auto max-w-[160px] object-contain filter drop-shadow-md brightness-0 invert"
              onError={() => setLogoError(true)}
            />
          ) : (
            <Car className="h-12 w-12 text-white/50" />
          )}
        </div>
        {(
          <>
            <Dialog open={cardDialog !== 'none'} onOpenChange={open => { if (!open) setCardDialog('none'); }}>
              <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle>{cardDialog === 'edit' ? 'Edit Car Rental' : 'Edit Image'}</DialogTitle>
                </DialogHeader>
                {cardDialog === 'edit' && (
                  <CarRentalForm tripId={tripId} rental={rental} tripStartDate={tripStartDate} tripEndDate={tripEndDate} tripDestination={tripDestination} onSuccess={() => setCardDialog('none')} />
                )}
                {cardDialog === 'image' && (
                  <ImagePickerContent searchHint={rental.company} onSave={url => { handleImageSave(url); setCardDialog('none'); }} onCancel={() => setCardDialog('none')} />
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
        <span className="absolute bottom-2 left-3 text-xs font-semibold text-white uppercase tracking-wider drop-shadow">
          {CAR_TYPE_LABELS[rental.carType ?? 'other'] ?? 'Other'}
        </span>
      </div>

      {/* ── Body ── */}
      <div className="p-5 space-y-3">
        <h3 className="font-serif text-xl font-semibold leading-tight">{rental.company}</h3>

        <div className="space-y-2 text-sm text-muted-foreground">
          {/* Pickup */}
          <div className="flex items-start gap-2">
            <MapPin className="h-4 w-4 shrink-0 mt-0.5 text-green-600" />
            <span className="flex-1 line-clamp-1">{rental.pickupLocation}</span>
            <a href={mapsUrl} target="_blank" rel="noopener noreferrer"
              className="shrink-0 text-primary hover:text-primary/80 transition-colors" title="Open in Google Maps">
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>

          {/* Drop-off (if different) */}
          {!sameLocation && (
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 shrink-0 mt-0.5 text-red-500" />
              <span className="flex-1 line-clamp-1">{rental.dropoffLocation}</span>
            </div>
          )}

          {/* Dates */}
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 shrink-0" />
            <span>{format(pickup, 'MMM d, h:mm a')}</span>
            <ArrowRight className="h-3 w-3 shrink-0" />
            <span>{format(dropoff, 'MMM d, h:mm a')}</span>
          </div>

          {/* Phone */}
          {rental.phone && (
            <div className="flex items-center gap-2">
              <Phone className="h-4 w-4 shrink-0" />
              <a href={`tel:${rental.phone}`} className="hover:text-foreground transition-colors">{rental.phone}</a>
            </div>
          )}

          {/* Driver */}
          {rental.driverName && (
            <div className="text-xs text-muted-foreground">Driver: {rental.driverName}</div>
          )}

          {/* Confirmation */}
          {rental.confirmationCode && (
            <div className="bg-muted px-2 py-1.5 rounded text-xs font-mono inline-block">
              Ref: {rental.confirmationCode}
            </div>
          )}
        </div>
      </div>

      {/* ── Mini map ── */}
      {hasMap && <MiniMap lat={rental.lat} lon={rental.lon} label={rental.company} />}
    </div>
  );
}

// ── Form ──────────────────────────────────────────────────────────────────────

function CarRentalForm({ tripId, rental, tripStartDate, tripEndDate, tripDestination, onSuccess }: {
  tripId: number; rental?: any; tripStartDate?: string; tripEndDate?: string; tripDestination?: string; onSuccess: () => void;
}) {
  const queryClient = useQueryClient();
  const createRental = useCreateCarRental();
  const updateRental = useUpdateCarRental();

  const splitDT = (iso: string) => {
    const s = iso.slice(0, 16);
    return s.length >= 16 ? { date: s.slice(0, 10), time: s.slice(11, 16) } : { date: '', time: '10:00' };
  };

  const form = useForm<z.infer<typeof carRentalSchema>>({
    resolver: zodResolver(carRentalSchema),
    defaultValues: rental ? (() => {
      const pu = splitDT(rental.pickupDatetime);
      const do_ = splitDT(rental.dropoffDatetime);
      return {
        ...rental,
        phone: rental.phone ?? '',
        driverName: rental.driverName ?? '',
        confirmationCode: rental.confirmationCode ?? '',
        dropoffLocation: rental.dropoffLocation ?? '',
        lat: rental.lat ?? undefined,
        lon: rental.lon ?? undefined,
        imageUrl: rental.imageUrl ?? undefined,
        pickupDate: pu.date, pickupTime: pu.time,
        dropoffDate: do_.date, dropoffTime: do_.time,
      };
    })() : {
      company: '', pickupLocation: '', dropoffLocation: '',
      pickupDate: '', pickupTime: '10:00',
      dropoffDate: '', dropoffTime: '10:00',
      carType: 'economy' as const, confirmationCode: '', driverName: '', phone: '',
    },
  });

  const onSubmit = (values: z.infer<typeof carRentalSchema>) => {
    const payload = {
      company: values.company,
      pickupLocation: values.pickupLocation,
      dropoffLocation: values.dropoffLocation || undefined,
      pickupDatetime:  `${values.pickupDate}T${values.pickupTime}`,
      dropoffDatetime: `${values.dropoffDate}T${values.dropoffTime}`,
      carType: values.carType,
      confirmationCode: values.confirmationCode || undefined,
      driverName: values.driverName || undefined,
      phone: values.phone || undefined,
      lat: values.lat,
      lon: values.lon,
      imageUrl: values.imageUrl || undefined,
      notes: values.notes || undefined,
    };

    if (rental) {
      updateRental.mutate({ tripId, carRentalId: rental.id, data: payload }, {
        onSuccess: () => { toast.success('Updated'); queryClient.invalidateQueries({ queryKey: getListCarRentalsQueryKey(tripId) }); onSuccess(); },
        onError: () => toast.error('Failed to update'),
      });
    } else {
      createRental.mutate({ tripId, data: payload }, {
        onSuccess: () => { toast.success('Added'); queryClient.invalidateQueries({ queryKey: getListCarRentalsQueryKey(tripId) }); onSuccess(); },
        onError: () => toast.error('Failed to add'),
      });
    }
  };

  const isPending = createRental.isPending || updateRental.isPending;
  const pickupDate = form.watch('pickupDate');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">

        {/* Company */}
        <FormField control={form.control} name="company" render={({ field }) => (
          <FormItem>
            <FormLabel>Rental Company</FormLabel>
            <FormControl>
              <CompanyInput
                value={field.value}
                onChange={field.onChange}
                tripDestination={tripDestination}
                onSelect={s => {
                  form.setValue('company', s.name);
                  form.setValue('pickupLocation', s.address);
                  form.setValue('phone', s.phone ?? '');
                  form.setValue('lat', s.lat);
                  form.setValue('lon', s.lon);
                  fetchWikiImage(s.name).then(url => { if (url) form.setValue('imageUrl', url); });
                }}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Pickup location */}
        <FormField control={form.control} name="pickupLocation" render={({ field }) => (
          <FormItem><FormLabel>Pickup Location</FormLabel><FormControl><Input placeholder="Airport terminal, address…" {...field} /></FormControl><FormMessage /></FormItem>
        )} />

        {/* Drop-off location */}
        <FormField control={form.control} name="dropoffLocation" render={({ field }) => (
          <FormItem>
            <FormLabel>Drop-off Location <span className="text-muted-foreground font-normal">(leave blank if same)</span></FormLabel>
            <FormControl><Input placeholder="Leave blank if same as pickup" {...field} value={field.value ?? ''} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Pickup date/time */}
        <div>
          <p className="text-sm font-medium mb-1.5">Pickup</p>
          <div className="grid grid-cols-2 gap-2">
            <FormField control={form.control} name="pickupDate" render={({ field }) => (
              <FormItem><FormControl><Input type="date" min={tripStartDate} max={tripEndDate} {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="pickupTime" render={({ field }) => (
              <FormItem><FormControl><Input type="time" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
          </div>
        </div>

        {/* Drop-off date/time */}
        <div>
          <p className="text-sm font-medium mb-1.5">Drop-off</p>
          <div className="grid grid-cols-2 gap-2">
            <FormField control={form.control} name="dropoffDate" render={({ field }) => (
              <FormItem><FormControl><Input type="date" min={pickupDate || tripStartDate} max={tripEndDate} {...field} /></FormControl><FormMessage /></FormItem>
            )} />
            <FormField control={form.control} name="dropoffTime" render={({ field }) => (
              <FormItem><FormControl><Input type="time" {...field} /></FormControl><FormMessage /></FormItem>
            )} />
          </div>
        </div>

        {/* Car type + confirmation */}
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="carType" render={({ field }) => (
            <FormItem><FormLabel>Car Type</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
                <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  {Object.entries(CAR_TYPE_LABELS).map(([v, l]) => (
                    <SelectItem key={v} value={v}>{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="confirmationCode" render={({ field }) => (
            <FormItem><FormLabel>Confirmation Code <span className="text-muted-foreground font-normal">(optional)</span></FormLabel><FormControl><Input {...field} value={field.value ?? ''} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>

        {/* Driver + Phone */}
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="driverName" render={({ field }) => (
            <FormItem><FormLabel>Driver Name</FormLabel><FormControl><Input placeholder="Primary driver" {...field} value={field.value ?? ''} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="phone" render={({ field }) => (
            <FormItem><FormLabel>Phone</FormLabel><FormControl><Input type="tel" placeholder="+1 800 555 0100" {...field} value={field.value ?? ''} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>

        {/* Notes */}
        <FormField control={form.control} name="notes" render={({ field }) => (
          <FormItem><FormLabel>Notes</FormLabel><FormControl><Input placeholder="Insurance, GPS, car seats…" {...field} value={field.value ?? ''} /></FormControl><FormMessage /></FormItem>
        )} />

        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={isPending}>{isPending ? 'Saving…' : 'Save Rental'}</Button>
        </div>
      </form>
    </Form>
  );
}
