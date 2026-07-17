import {
  useListFlights, useCreateFlight, useUpdateFlight, useDeleteFlight, getListFlightsQueryKey,
} from '@workspace/api-client-react';
import { useState, useRef, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Plane, PlaneTakeoff, Plus, Trash2, Pencil, Loader2, Search,
} from 'lucide-react';
import { format, parseISO } from 'date-fns';

// ─── Types ────────────────────────────────────────────────────────────────────
type AirlineSuggestion = { code: string; name: string };
type AirportSuggestion = { iata: string; name: string; city: string; country: string };

// ─── Base URL for API (mirrors the pattern used by the generated client) ──────
const API_BASE = '/api';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw err;
  }
  return res.json();
}

// ─── Autocomplete hook ────────────────────────────────────────────────────────
function useAutocomplete<T>(endpoint: string, query: string, minLen = 1) {
  const [results, setResults] = useState<T[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (query.length < minLen) { setResults([]); return; }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await fetchJson<T[]>(`${API_BASE}${endpoint}?q=${encodeURIComponent(query)}`);
        setResults(data);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 200);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, endpoint, minLen]);

  return { results, loading };
}

// ─── Autocomplete input component ─────────────────────────────────────────────
function AutocompleteInput<T extends Record<string, string>>({
  value, onChange, placeholder, endpoint, renderItem, getLabel, minLen = 1,
}: {
  value: string; onChange: (val: string) => void; placeholder?: string;
  endpoint: string; renderItem: (item: T) => React.ReactNode;
  getLabel: (item: T) => string; minLen?: number;
}) {
  const [open, setOpen] = useState(false);
  const { results, loading } = useAutocomplete<T>(endpoint, value, minLen);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          value={value}
          onChange={e => { onChange(e.target.value); setOpen(true); }}
          onFocus={() => { if (value.length >= minLen) setOpen(true); }}
          placeholder={placeholder}
          className="uppercase"
          autoComplete="off"
        />
        {loading && <Loader2 className="absolute right-3 top-2.5 h-4 w-4 animate-spin text-muted-foreground" />}
      </div>
      {open && results.length > 0 && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border bg-popover shadow-md overflow-hidden">
          {results.map((item, i) => (
            <button
              key={i} type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-accent transition-colors"
              onMouseDown={e => { e.preventDefault(); onChange(getLabel(item)); setOpen(false); }}
            >
              {renderItem(item)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Airline input ────────────────────────────────────────────────────────────
function AirlineInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <AutocompleteInput<AirlineSuggestion>
      value={value} onChange={onChange}
      placeholder="e.g. Lufthansa"
      endpoint="/search/airlines"
      minLen={1}
      getLabel={a => a.name}
      renderItem={a => (
        <span className="flex items-center gap-2 normal-case">
          <span className="font-mono text-xs bg-primary/10 text-primary px-1.5 py-0.5 rounded">{a.code}</span>
          <span>{a.name}</span>
        </span>
      )}
    />
  );
}

// ─── Airport input ────────────────────────────────────────────────────────────
function AirportInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <AutocompleteInput<AirportSuggestion>
      value={value} onChange={onChange}
      placeholder={placeholder ?? 'e.g. JFK or New York'}
      endpoint="/search/airports"
      minLen={2}
      getLabel={a => a.iata}
      renderItem={a => (
        <span className="flex items-center gap-2 normal-case">
          <span className="font-mono font-bold text-primary w-10 shrink-0">{a.iata}</span>
          <span className="truncate text-muted-foreground">{a.city}, {a.country} — {a.name}</span>
        </span>
      )}
    />
  );
}

// ─── Flight search panel (external booking site deep-links) ──────────────────
function FlightSearchPanel({
  origin, destination, date,
}: {
  origin: string; destination: string; date: string;
}) {
  const canLink = origin.length === 3 && destination.length === 3 && date.length === 10;

  // Kayak: /flights/JFK-LAX/2026-09-10
  const kayakUrl = canLink
    ? `https://www.kayak.com/flights/${origin.toUpperCase()}-${destination.toUpperCase()}/${date}`
    : null;

  // Google Flights: simple query string works as a deep-link into the search
  const googleUrl = canLink
    ? `https://www.google.com/travel/flights/search?q=Flights+from+${origin.toUpperCase()}+to+${destination.toUpperCase()}+on+${date}`
    : null;

  // Skyscanner: /transport/flights/org/dst/YYMMDD/
  const skyscannerDate = canLink ? date.replace(/-/g, '').slice(2) : null; // YYMMDD
  const skyscannerUrl = canLink
    ? `https://www.skyscanner.com/transport/flights/${origin.toLowerCase()}/${destination.toLowerCase()}/${skyscannerDate}/`
    : null;

  const sites = [
    { name: 'Google Flights', url: googleUrl, color: 'hover:border-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30' },
    { name: 'Kayak', url: kayakUrl, color: 'hover:border-orange-400 hover:bg-orange-50 dark:hover:bg-orange-950/30' },
    { name: 'Skyscanner', url: skyscannerUrl, color: 'hover:border-sky-500 hover:bg-sky-50 dark:hover:bg-sky-950/30' },
  ];

  return (
    <div className="space-y-2">
      {!canLink && (
        <p className="text-xs text-muted-foreground text-center py-1">
          Enter 3-letter airport codes and a departure date above to search for flights
        </p>
      )}
      <div className="grid grid-cols-3 gap-2">
        {sites.map(({ name, url, color }) => (
          <a
            key={name}
            href={url ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            onClick={!url ? (e) => e.preventDefault() : undefined}
            className={`flex flex-col items-center justify-center gap-1 rounded-lg border p-3 text-center text-sm font-medium transition-all
              ${url ? `cursor-pointer ${color}` : 'opacity-40 cursor-not-allowed bg-muted/30'}`}
          >
            <Search className="h-4 w-4 text-muted-foreground" />
            {name}
          </a>
        ))}
      </div>
      {canLink && (
        <p className="text-xs text-muted-foreground text-center">
          Opens a new tab — find your flight, then enter the details above
        </p>
      )}
    </div>
  );
}

// ─── Schema ───────────────────────────────────────────────────────────────────
const flightSchema = z.object({
  flightNumber: z.string().min(1, 'Flight number is required'),
  airline: z.string().min(1, 'Airline is required'),
  departureAirport: z.string().min(1, 'Departure airport is required'),
  arrivalAirport: z.string().min(1, 'Arrival airport is required'),
  departureDatetime: z.string().min(1, 'Departure time is required'),
  arrivalDatetime: z.string().min(1, 'Arrival time is required'),
  confirmationCode: z.string().optional(),
  direction: z.enum(['outbound', 'return', 'connecting']).optional(),
});

// ─── Flight list ──────────────────────────────────────────────────────────────
export function TripFlights({ tripId, editMode }: { tripId: number; editMode?: boolean }) {
  const { data: flights, isLoading } = useListFlights(tripId, { query: { enabled: !!tripId } });
  const [isAddOpen, setIsAddOpen] = useState(false);

  if (isLoading) return <div>Loading flights…</div>;

  return (
    <div className="space-y-6">
      {editMode && (
        <div className="flex justify-end">
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Flight</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader><DialogTitle>Add Flight</DialogTitle></DialogHeader>
              <FlightForm tripId={tripId} onSuccess={() => setIsAddOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      )}

      {(!flights || flights.length === 0) ? (
        <div className="text-center py-12 bg-muted/50 rounded-xl border border-dashed">
          <Plane className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
          <p className="text-lg font-medium">No flights added</p>
        </div>
      ) : (
        <div className="grid gap-4">
          {flights.map(flight => (
            <FlightCard key={flight.id} tripId={tripId} flight={flight} editMode={editMode} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Flight card ──────────────────────────────────────────────────────────────
function FlightCard({ tripId, flight, editMode }: { tripId: number; flight: any; editMode?: boolean }) {
  const queryClient = useQueryClient();
  const deleteFlight = useDeleteFlight();
  const [isEditOpen, setIsEditOpen] = useState(false);

  const handleDelete = () => {
    if (confirm('Delete this flight?')) {
      deleteFlight.mutate({ tripId, flightId: flight.id }, {
        onSuccess: () => {
          toast.success('Flight deleted');
          queryClient.invalidateQueries({ queryKey: getListFlightsQueryKey(tripId) });
        },
        onError: () => toast.error('Failed to delete flight'),
      });
    }
  };

  return (
    <div className="bg-card border rounded-xl p-6 shadow-sm relative overflow-hidden group">
      <div className="absolute top-0 right-0 p-4 flex gap-2">
        {editMode && (
          <>
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Pencil className="h-4 w-4" />
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
                <DialogHeader><DialogTitle>Edit Flight</DialogTitle></DialogHeader>
                <FlightForm tripId={tripId} flight={flight} onSuccess={() => setIsEditOpen(false)} />
              </DialogContent>
            </Dialog>
            <Button variant="ghost" size="icon" onClick={handleDelete}
              className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive">
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>

      <div className="flex flex-col md:flex-row gap-6 md:items-center justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-4">
            <div className="h-10 w-10 bg-primary/10 rounded-full flex items-center justify-center">
              <Plane className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h3 className="font-semibold text-lg">{flight.airline}</h3>
              <p className="text-sm text-muted-foreground flex gap-2">
                <span>{flight.flightNumber}</span>
                {flight.confirmationCode && (
                  <><span>•</span><span className="font-mono">{flight.confirmationCode}</span></>
                )}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex-1 text-center md:text-left">
              <p className="text-2xl font-bold">{format(parseISO(flight.departureDatetime), 'HH:mm')}</p>
              <p className="text-lg text-primary">{flight.departureAirport}</p>
              <p className="text-xs text-muted-foreground">{format(parseISO(flight.departureDatetime), 'MMM d, yyyy')}</p>
            </div>

            <div className="flex flex-col items-center px-4 flex-1">
              <span className="text-xs text-muted-foreground mb-1 uppercase">{flight.direction || 'flight'}</span>
              <div className="w-full flex items-center relative">
                <div className="h-px bg-border flex-1" />
                <PlaneTakeoff className="h-4 w-4 text-muted-foreground mx-2" />
                <div className="h-px bg-border flex-1" />
              </div>
            </div>

            <div className="flex-1 text-center md:text-right">
              <p className="text-2xl font-bold">{format(parseISO(flight.arrivalDatetime), 'HH:mm')}</p>
              <p className="text-lg text-primary">{flight.arrivalAirport}</p>
              <p className="text-xs text-muted-foreground">{format(parseISO(flight.arrivalDatetime), 'MMM d, yyyy')}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Flight form ──────────────────────────────────────────────────────────────
function FlightForm({ tripId, flight, onSuccess }: { tripId: number; flight?: any; onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createFlight = useCreateFlight();
  const updateFlight = useUpdateFlight();

  // Extract date-only for flight search (YYYY-MM-DD)
  const [searchDate, setSearchDate] = useState(
    flight?.departureDatetime ? flight.departureDatetime.slice(0, 10) : ''
  );

  const form = useForm<z.infer<typeof flightSchema>>({
    resolver: zodResolver(flightSchema),
    defaultValues: flight
      ? {
          ...flight,
          departureDatetime: flight.departureDatetime.slice(0, 16),
          arrivalDatetime: flight.arrivalDatetime.slice(0, 16),
        }
      : { flightNumber: '', airline: '', departureAirport: '', arrivalAirport: '', departureDatetime: '', arrivalDatetime: '', confirmationCode: '', direction: 'outbound' },
  });

  const depAirport = form.watch('departureAirport');
  const arrAirport = form.watch('arrivalAirport');
  const depDatetime = form.watch('departureDatetime');

  // Keep search date in sync with the datetime field
  useEffect(() => {
    if (depDatetime && depDatetime.length >= 10) setSearchDate(depDatetime.slice(0, 10));
  }, [depDatetime]);

  const onSubmit = (values: z.infer<typeof flightSchema>) => {
    const payload = {
      ...values,
      departureDatetime: new Date(values.departureDatetime).toISOString(),
      arrivalDatetime: new Date(values.arrivalDatetime).toISOString(),
    };

    if (flight) {
      updateFlight.mutate({ tripId, flightId: flight.id, data: payload }, {
        onSuccess: () => {
          toast.success('Flight updated');
          queryClient.invalidateQueries({ queryKey: getListFlightsQueryKey(tripId) });
          onSuccess();
        },
        onError: () => toast.error('Failed to update flight'),
      });
    } else {
      createFlight.mutate({ tripId, data: payload }, {
        onSuccess: () => {
          toast.success('Flight added');
          queryClient.invalidateQueries({ queryKey: getListFlightsQueryKey(tripId) });
          onSuccess();
        },
        onError: () => toast.error('Failed to add flight'),
      });
    }
  };

  const isPending = createFlight.isPending || updateFlight.isPending;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-2">
        {/* Airline */}
        <FormField control={form.control} name="airline" render={({ field }) => (
          <FormItem>
            <FormLabel>Airline</FormLabel>
            <FormControl>
              <AirlineInput value={field.value} onChange={field.onChange} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Airports */}
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="departureAirport" render={({ field }) => (
            <FormItem>
              <FormLabel>From</FormLabel>
              <FormControl>
                <AirportInput value={field.value} onChange={field.onChange} placeholder="City or code" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="arrivalAirport" render={({ field }) => (
            <FormItem>
              <FormLabel>To</FormLabel>
              <FormControl>
                <AirportInput value={field.value} onChange={field.onChange} placeholder="City or code" />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        {/* Datetimes */}
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="departureDatetime" render={({ field }) => (
            <FormItem>
              <FormLabel>Departure</FormLabel>
              <FormControl><Input type="datetime-local" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="arrivalDatetime" render={({ field }) => (
            <FormItem>
              <FormLabel>Arrival</FormLabel>
              <FormControl><Input type="datetime-local" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        {/* Confirmation + direction */}
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="confirmationCode" render={({ field }) => (
            <FormItem><FormLabel>Confirmation Code</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="direction" render={({ field }) => (
            <FormItem><FormLabel>Direction</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  <SelectItem value="outbound">Outbound</SelectItem>
                  <SelectItem value="return">Return</SelectItem>
                  <SelectItem value="connecting">Connecting</SelectItem>
                </SelectContent>
              </Select>
            <FormMessage /></FormItem>
          )} />
        </div>

        {/* Live flight search */}
        <div className="border-t pt-4">
          <p className="text-sm font-medium text-foreground mb-1">Search available flights</p>
          <p className="text-xs text-muted-foreground mb-3">
            Enter airport codes and a departure date above, then search for real-time options to auto-fill the form.
          </p>
          <FlightSearchPanel
            origin={depAirport}
            destination={arrAirport}
            date={searchDate}
          />
        </div>

        {/* Flight number */}
        <FormField control={form.control} name="flightNumber" render={({ field }) => (
          <FormItem>
            <FormLabel>Flight Number</FormLabel>
            <FormControl><Input {...field} placeholder="e.g. LH 441" /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Saving…' : 'Save Flight'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
