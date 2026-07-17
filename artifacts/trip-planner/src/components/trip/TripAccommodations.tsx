import { useListAccommodations, useCreateAccommodation, useUpdateAccommodation, useDeleteAccommodation, getListAccommodationsQueryKey } from '@workspace/api-client-react';
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
import { Home, MapPin, Calendar, Plus, Trash2, Pencil } from 'lucide-react';
import { format, parseISO } from 'date-fns';

const accommSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  address: z.string().min(1, 'Address is required'),
  checkIn: z.string().min(1, 'Check-in is required'),
  checkOut: z.string().min(1, 'Check-out is required'),
  type: z.enum(['hotel', 'airbnb', 'hostel', 'resort', 'other']).optional(),
  confirmationCode: z.string().optional(),
});

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

function AccommForm({ tripId, stay, onSuccess }: { tripId: number, stay?: any, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createStay = useCreateAccommodation();
  const updateStay = useUpdateAccommodation();
  
  const form = useForm<z.infer<typeof accommSchema>>({
    resolver: zodResolver(accommSchema),
    defaultValues: stay ? {
      ...stay,
      checkIn: stay.checkIn.slice(0, 16),
      checkOut: stay.checkOut.slice(0, 16),
    } : {
      name: '', address: '', checkIn: '', checkOut: '', type: 'hotel', confirmationCode: ''
    },
  });

  const onSubmit = (values: z.infer<typeof accommSchema>) => {
    const payload = {
      ...values,
      checkIn: new Date(values.checkIn).toISOString(),
      checkOut: new Date(values.checkOut).toISOString(),
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
  const checkIn = form.watch('checkIn');

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem><FormLabel>Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="address" render={({ field }) => (
          <FormItem><FormLabel>Address</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="checkIn" render={({ field }) => (
            <FormItem><FormLabel>Check-in</FormLabel><FormControl><Input type="datetime-local" {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="checkOut" render={({ field }) => (
            <FormItem><FormLabel>Check-out</FormLabel><FormControl><Input type="datetime-local" min={checkIn || undefined} {...field} /></FormControl><FormMessage /></FormItem>
          )} />
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
