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
import { Plane, PlaneTakeoff, Plus, Trash2, Pencil, Loader2 } from 'lucide-react';
import { format, parseISO } from 'date-fns';

// ─── Types ────────────────────────────────────────────────────────────────────
type AirlineSuggestion = { code: string; name: string };
type AirportSuggestion = { iata: string; name: string; city: string; country: string };
type ScheduledFlight = {
  flightNumber: string;
  airline: string;
  carrierCode: string;
  departureAirport: string;
  arrivalAirport: string;
  departureTime: string; // ISO 8601
  arrivalTime: string;   // ISO 8601
};

// ─── API helpers ──────────────────────────────────────────────────────────────
const API_BASE = '/api';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw err;
  }
  return res.json();
}

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

// ─── Autocomplete input ───────────────────────────────────────────────────────
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
        <span className="flex items-center gap-2">
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
        <span className="flex items-center gap-2">
          <span className="font-mono font-bold text-primary w-10 shrink-0">{a.iata}</span>
          <span className="truncate text-muted-foreground">{a.city}, {a.country} — {a.name}</span>
        </span>
      )}
    />
  );
}

// ─── Flight picker ────────────────────────────────────────────────────────────
function FlightPicker({
  origin, destination, date, onSelect,
}: {
  origin: string; destination: string; date: string;
  onSelect: (flight: ScheduledFlight) => void;
}) {
  const [flights, setFlights] = useState<ScheduledFlight[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyMissing, setKeyMissing] = useState(false);
  const [planRestricted, setPlanRestricted] = useState(false);
  const [selected, setSelected] = useState('');

  const ready = origin.length === 3 && destination.length === 3 && date.length === 10;

  useEffect(() => {
    if (!ready) {
      setFlights(null);
      setSelected('');
      setError(null);
      setKeyMissing(false);
      setPlanRestricted(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setKeyMissing(false);
    setPlanRestricted(false);
    setFlights(null);
    setSelected('');

    fetchJson<ScheduledFlight[]>(
      `${API_BASE}/search/flights?origin=${encodeURIComponent(origin)}&destination=${encodeURIComponent(destination)}&date=${encodeURIComponent(date)}`
    )
      .then(data => { if (!cancelled) setFlights(data); })
      .catch(err => {
        if (cancelled) return;
        if (err?.error === 'AVIATIONSTACK_KEY_MISSING') setKeyMissing(true);
        else if (err?.error === 'AVIATIONSTACK_PLAN_RESTRICTED') setPlanRestricted(true);
        else setError(err?.detail ?? err?.error ?? 'Could not load flights');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [origin, destination, date, ready]);

  const handleChange = (flightNumber: string) => {
    setSelected(flightNumber);
    const f = flights?.find(f => f.flightNumber === flightNumber);
    if (f) onSelect(f);
  };

  if (!ready) return null;

  return (
    <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
      <p className="text-sm font-medium">
        Available flights · {origin} → {destination} · {date}
      </p>

      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading available flights…
        </div>
      )}

      {keyMissing && (
        <div className="rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 text-xs space-y-1">
          <p className="font-semibold text-amber-800 dark:text-amber-400">Flight data not configured</p>
          <p className="text-amber-700 dark:text-amber-500 leading-relaxed">
            Add a free API key from{' '}
            <a href="https://aviationstack.com" target="_blank" rel="noopener noreferrer" className="underline font-medium">
              aviationstack.com
            </a>{' '}
            as the Replit Secret <code className="bg-amber-100 dark:bg-amber-900 px-1 rounded">AVIATIONSTACK_API_KEY</code>.
          </p>
        </div>
      )}

      {planRestricted && (
        <div className="rounded-md border border-muted bg-muted/40 p-3 text-xs space-y-1">
          <p className="font-semibold text-foreground">Live flight search requires a paid AviationStack plan</p>
          <p className="text-muted-foreground leading-relaxed">
            Enter your flight details manually below — airline, flight number, and departure/arrival times.
          </p>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      {flights && flights.length === 0 && (
        <p className="text-sm text-muted-foreground">No scheduled flights found for this route and date.</p>
      )}

      {flights && flights.length > 0 && (
        <Select value={selected} onValueChange={handleChange}>
          <SelectTrigger className="bg-background">
            <SelectValue placeholder="Select a flight to fill times automatically…" />
          </SelectTrigger>
          <SelectContent>
            {flights.map(f => (
              <SelectItem key={f.flightNumber} value={f.flightNumber}>
                <span className="flex items-center gap-3">
                  <span className="font-mono font-semibold text-primary">{f.flightNumber}</span>
                  <span className="text-muted-foreground">{f.airline}</span>
                  <span className="font-medium">
                    {format(parseISO(f.departureTime), 'HH:mm')}
                    {' → '}
                    {format(parseISO(f.arrivalTime), 'HH:mm')}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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

// ─── Trip flights list ────────────────────────────────────────────────────────
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
              <div className="w-full flex items-center">
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

  const form = useForm<z.infer<typeof flightSchema>>({
    resolver: zodResolver(flightSchema),
    defaultValues: flight
      ? {
          ...flight,
          departureDatetime: flight.departureDatetime.slice(0, 16),
          arrivalDatetime: flight.arrivalDatetime.slice(0, 16),
        }
      : {
          flightNumber: '', airline: '', departureAirport: '', arrivalAirport: '',
          departureDatetime: '', arrivalDatetime: '', confirmationCode: '', direction: 'outbound',
        },
  });

  const depAirport = form.watch('departureAirport');
  const arrAirport = form.watch('arrivalAirport');
  const depDatetime = form.watch('departureDatetime');
  const searchDate = depDatetime?.slice(0, 10) ?? '';

  // When a flight is picked from the dropdown, fill all related fields atomically
  const handleSelectFlight = (f: ScheduledFlight) => {
    form.reset(
      {
        ...form.getValues(),
        airline: f.airline,
        flightNumber: f.flightNumber,
        departureDatetime: f.departureTime.slice(0, 16),
        arrivalDatetime: f.arrivalTime.slice(0, 16),
      },
      { keepDirty: true, keepIsSubmitted: true, keepTouched: true, keepErrors: false },
    );
  };

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

        {/* Direction */}
        <FormField control={form.control} name="direction" render={({ field }) => (
          <FormItem>
            <FormLabel>Direction</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
              <SelectContent>
                <SelectItem value="outbound">Outbound</SelectItem>
                <SelectItem value="return">Return</SelectItem>
                <SelectItem value="connecting">Connecting</SelectItem>
              </SelectContent>
            </Select>
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

        {/* Departure date — drives the flight picker */}
        <FormField control={form.control} name="departureDatetime" render={({ field }) => (
          <FormItem>
            <FormLabel>Departure Date</FormLabel>
            <FormControl><Input type="datetime-local" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* ── Flight picker: auto-appears once From + To + Date are set ── */}
        <FlightPicker
          origin={depAirport}
          destination={arrAirport}
          date={searchDate}
          onSelect={handleSelectFlight}
        />

        {/* Arrival date — auto-filled by picker, or set manually */}
        <FormField control={form.control} name="arrivalDatetime" render={({ field }) => (
          <FormItem>
            <FormLabel>Arrival Date</FormLabel>
            <FormControl><Input type="datetime-local" {...field} /></FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Airline — auto-filled by picker */}
        <FormField control={form.control} name="airline" render={({ field }) => (
          <FormItem>
            <FormLabel>Airline</FormLabel>
            <FormControl>
              <AirlineInput value={field.value} onChange={field.onChange} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />

        {/* Flight number + Confirmation code */}
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="flightNumber" render={({ field }) => (
            <FormItem>
              <FormLabel>Flight Number</FormLabel>
              <FormControl><Input {...field} placeholder="e.g. LH441" /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="confirmationCode" render={({ field }) => (
            <FormItem>
              <FormLabel>Confirmation Code</FormLabel>
              <FormControl><Input {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

        <div className="flex justify-end pt-2">
          <Button type="submit" disabled={isPending}>
            {isPending ? 'Saving…' : 'Save Flight'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
