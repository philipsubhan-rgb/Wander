import { useListAccommodations, useCreateAccommodation, useUpdateAccommodation, useDeleteAccommodation, getListAccommodationsQueryKey } from '@workspace/api-client-react';
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

const API_BASE = `${import.meta.env.BASE_URL}api`;

const DEFAULT_CHECKIN_TIME  = '15:00';
const DEFAULT_CHECKOUT_TIME = '11:00';

const accommSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  address: z.string().min(1, 'Address is required'),
  phone: z.string().optional(),
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

  // Close dropdown when clicking outside
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
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            …
          </span>
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

export function TripAccommodations({ tripId, editMode }: { tripId: number, editMode?: boolean }) {
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
            <DialogContent>
              <DialogHeader><DialogTitle>Add Accommodation</DialogTitle></DialogHeader>
              <AccommForm tripId={tripId} onSuccess={() => setIsAddOpen(false)} />
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
            <AccommCard key={stay.id} tripId={tripId} stay={stay} editMode={editMode} />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Card ──────────────────────────────────────────────────────────────────────

function AccommCard({ tripId, stay, editMode }: { tripId: number, stay: any, editMode?: boolean }) {
  const queryClient = useQueryClient();
  const deleteStay = useDeleteAccommodation();
  const [isEditOpen, setIsEditOpen] = useState(false);

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

  return (
    <div className="bg-card border rounded-xl p-6 shadow-sm relative group">
      <div className="absolute top-4 right-4 flex gap-2">
        {editMode && (
          <>
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"><Pencil className="h-4 w-4" /></Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Edit Stay</DialogTitle></DialogHeader>
                <AccommForm tripId={tripId} stay={stay} onSuccess={() => setIsEditOpen(false)} />
              </DialogContent>
            </Dialog>
            <Button variant="ghost" size="icon" onClick={handleDelete} className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive">
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>

      <div className="flex items-start gap-4">
        <div className="h-12 w-12 bg-primary/10 rounded-xl flex items-center justify-center shrink-0">
          <Home className="h-6 w-6 text-primary" />
        </div>
        <div className="space-y-3 pt-1">
          <div>
            <h3 className="font-serif text-xl font-semibold leading-none">{stay.name}</h3>
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider mt-1 block">{stay.type}</span>
          </div>
          
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
              <span>{format(parseISO(stay.checkIn), 'MMM d')} - {format(parseISO(stay.checkOut), 'MMM d')}</span>
            </div>
            {stay.confirmationCode && (
              <div className="bg-muted p-2 rounded text-xs font-mono inline-block">
                Code: {stay.confirmationCode}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Form ──────────────────────────────────────────────────────────────────────

function AccommForm({ tripId, stay, onSuccess }: { tripId: number, stay?: any, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createStay = useCreateAccommodation();
  const updateStay = useUpdateAccommodation();
  
  // Parse an ISO datetime string into { date: 'YYYY-MM-DD', time: 'HH:MM' }
  const splitDateTime = (iso: string, defaultTime: string) => {
    const local = iso.slice(0, 16); // 'YYYY-MM-DDTHH:MM'
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
        checkInDate:  ci.date,
        checkInTime:  ci.time,
        checkOutDate: co.date,
        checkOutTime: co.time,
      };
    })() : {
      name: '', address: '', phone: '',
      checkInDate: '', checkInTime: DEFAULT_CHECKIN_TIME,
      checkOutDate: '', checkOutTime: DEFAULT_CHECKOUT_TIME,
      type: 'hotel', confirmationCode: '',
    },
  });

  const onSubmit = (values: z.infer<typeof accommSchema>) => {
    const payload = {
      name: values.name,
      address: values.address,
      phone: values.phone || undefined,
      type: values.type,
      confirmationCode: values.confirmationCode || undefined,
      checkIn:  new Date(`${values.checkInDate}T${values.checkInTime}`).toISOString(),
      checkOut: new Date(`${values.checkOutDate}T${values.checkOutTime}`).toISOString(),
    };

    if (stay) {
      updateStay.mutate({ tripId, accommodationId: stay.id, data: payload }, {
        onSuccess: () => {
          toast.success('Updated');
          queryClient.invalidateQueries({ queryKey: getListAccommodationsQueryKey(tripId) });
          onSuccess();
        }
      });
    } else {
      createStay.mutate({ tripId, data: payload }, {
        onSuccess: () => {
          toast.success('Added');
          queryClient.invalidateQueries({ queryKey: getListAccommodationsQueryKey(tripId) });
          onSuccess();
        }
      });
    }
  };

  const isPending = createStay.isPending || updateStay.isPending;
  const checkInDate = form.watch('checkInDate');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">

        {/* Hotel name with autocomplete */}
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem>
            <FormLabel>Hotel / Property Name</FormLabel>
            <FormControl>
              <HotelNameInput
                value={field.value}
                onChange={field.onChange}
                onSelect={s => {
                  form.reset({
                    ...form.getValues(),
                    name: s.name,
                    address: s.address,
                    phone: s.phone ?? '',
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

        {/* Check-in: date + time (defaults to 3:00 PM) */}
        <div>
          <p className="text-sm font-medium mb-1.5">Check-in</p>
          <div className="grid grid-cols-2 gap-2">
            <FormField control={form.control} name="checkInDate" render={({ field }) => (
              <FormItem>
                <FormControl><Input type="date" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="checkInTime" render={({ field }) => (
              <FormItem>
                <FormControl><Input type="time" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
          </div>
        </div>

        {/* Check-out: date + time (defaults to 11:00 AM) */}
        <div>
          <p className="text-sm font-medium mb-1.5">Check-out</p>
          <div className="grid grid-cols-2 gap-2">
            <FormField control={form.control} name="checkOutDate" render={({ field }) => (
              <FormItem>
                <FormControl><Input type="date" min={checkInDate || undefined} {...field} /></FormControl>
                <FormMessage />
              </FormItem>
            )} />
            <FormField control={form.control} name="checkOutTime" render={({ field }) => (
              <FormItem>
                <FormControl><Input type="time" {...field} /></FormControl>
                <FormMessage />
              </FormItem>
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
            <FormItem><FormLabel>Confirmation Code</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>
        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={isPending}>{isPending ? 'Saving...' : 'Save Stay'}</Button>
        </div>
      </form>
    </Form>
  );
}
