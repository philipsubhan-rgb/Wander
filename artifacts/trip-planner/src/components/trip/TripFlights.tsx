import { useListFlights, useCreateFlight, useUpdateFlight, useDeleteFlight, getListFlightsQueryKey } from '@workspace/api-client-react';
import { useState } from 'react';
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
import { Plane, PlaneTakeoff, PlaneLanding, Plus, Trash2, Pencil } from 'lucide-react';
import { format, parseISO } from 'date-fns';

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

export function TripFlights({ tripId, editMode }: { tripId: number, editMode?: boolean }) {
  const { data: flights, isLoading } = useListFlights(tripId, { query: { enabled: !!tripId } });
  const [isAddOpen, setIsAddOpen] = useState(false);

  if (isLoading) return <div>Loading flights...</div>;

  return (
    <div className="space-y-6">
      {editMode && (
        <div className="flex justify-end">
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Flight</Button>
            </DialogTrigger>
            <DialogContent>
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

function FlightCard({ tripId, flight, editMode }: { tripId: number, flight: any, editMode?: boolean }) {
  const queryClient = useQueryClient();
  const deleteFlight = useDeleteFlight();
  const [isEditOpen, setIsEditOpen] = useState(false);

  const handleDelete = () => {
    if (confirm('Delete this flight?')) {
      deleteFlight.mutate({ tripId, flightId: flight.id }, {
        onSuccess: () => {
          toast.success('Flight deleted');
          queryClient.invalidateQueries({ queryKey: getListFlightsQueryKey(tripId) });
        }
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
                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"><Pencil className="h-4 w-4" /></Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Edit Flight</DialogTitle></DialogHeader>
                <FlightForm tripId={tripId} flight={flight} onSuccess={() => setIsEditOpen(false)} />
              </DialogContent>
            </Dialog>
            <Button variant="ghost" size="icon" onClick={handleDelete} className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive">
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
                <div className="h-px bg-border flex-1"></div>
                <PlaneTakeoff className="h-4 w-4 text-muted-foreground mx-2" />
                <div className="h-px bg-border flex-1"></div>
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

function FlightForm({ tripId, flight, onSuccess }: { tripId: number, flight?: any, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createFlight = useCreateFlight();
  const updateFlight = useUpdateFlight();
  
  const form = useForm<z.infer<typeof flightSchema>>({
    resolver: zodResolver(flightSchema),
    defaultValues: flight ? {
      ...flight,
      departureDatetime: flight.departureDatetime.slice(0, 16),
      arrivalDatetime: flight.arrivalDatetime.slice(0, 16),
    } : {
      flightNumber: '', airline: '', departureAirport: '', arrivalAirport: '',
      departureDatetime: '', arrivalDatetime: '', confirmationCode: '', direction: 'outbound'
    },
  });

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
        }
      });
    } else {
      createFlight.mutate({ tripId, data: payload }, {
        onSuccess: () => {
          toast.success('Flight added');
          queryClient.invalidateQueries({ queryKey: getListFlightsQueryKey(tripId) });
          onSuccess();
        }
      });
    }
  };

  const isPending = createFlight.isPending || updateFlight.isPending;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="airline" render={({ field }) => (
            <FormItem><FormLabel>Airline</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="flightNumber" render={({ field }) => (
            <FormItem><FormLabel>Flight Number</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="departureAirport" render={({ field }) => (
            <FormItem><FormLabel>From (Code)</FormLabel><FormControl><Input {...field} maxLength={3} className="uppercase" /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="arrivalAirport" render={({ field }) => (
            <FormItem><FormLabel>To (Code)</FormLabel><FormControl><Input {...field} maxLength={3} className="uppercase" /></FormControl><FormMessage /></FormItem>
          )} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="departureDatetime" render={({ field }) => (
            <FormItem><FormLabel>Departure Time</FormLabel><FormControl><Input type="datetime-local" {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="arrivalDatetime" render={({ field }) => (
            <FormItem><FormLabel>Arrival Time</FormLabel><FormControl><Input type="datetime-local" {...field} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="confirmationCode" render={({ field }) => (
            <FormItem><FormLabel>Confirmation Code</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="direction" render={({ field }) => (
            <FormItem><FormLabel>Direction</FormLabel>
              <Select onValueChange={field.onChange} defaultValue={field.value}>
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
        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={isPending}>{isPending ? 'Saving...' : 'Save Flight'}</Button>
        </div>
      </form>
    </Form>
  );
}
