import { useListItineraryDays, useCreateItineraryDay, useUpdateItineraryDay, useDeleteItineraryDay, getListItineraryDaysQueryKey } from '@workspace/api-client-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Pencil, CalendarRange } from 'lucide-react';
import { format, parseISO } from 'date-fns';

const itinerarySchema = z.object({
  date: z.string().min(1, 'Date is required'),
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  notes: z.string().optional(),
});

export function TripItinerary({ tripId, editMode }: { tripId: number, editMode?: boolean }) {
  const { data: days, isLoading } = useListItineraryDays(tripId, { query: { enabled: !!tripId } });
  const [isAddOpen, setIsAddOpen] = useState(false);

  if (isLoading) return <div>Loading...</div>;

  const sortedDays = days?.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return (
    <div className="space-y-6">
      {editMode && (
        <div className="flex justify-end">
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Day</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add Itinerary Day</DialogTitle></DialogHeader>
              <ItineraryForm tripId={tripId} onSuccess={() => setIsAddOpen(false)} />
            </DialogContent>
          </Dialog>
        </div>
      )}

      {(!sortedDays || sortedDays.length === 0) ? (
         <div className="text-center py-12 bg-muted/50 rounded-xl border border-dashed">
           <CalendarRange className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
           <p className="text-lg font-medium">No itinerary mapped out</p>
         </div>
      ) : (
        <div className="space-y-6">
          {sortedDays.map((day, index) => (
            <ItineraryCard key={day.id} day={day} index={index + 1} tripId={tripId} editMode={editMode} />
          ))}
        </div>
      )}
    </div>
  );
}

function ItineraryCard({ tripId, day, index, editMode }: { tripId: number, day: any, index: number, editMode?: boolean }) {
  const queryClient = useQueryClient();
  const deleteDay = useDeleteItineraryDay();
  const [isEditOpen, setIsEditOpen] = useState(false);

  const handleDelete = () => {
    if (confirm('Delete this day from itinerary?')) {
      deleteDay.mutate({ tripId, itineraryDayId: day.id }, {
        onSuccess: () => {
          toast.success('Deleted');
          queryClient.invalidateQueries({ queryKey: getListItineraryDaysQueryKey(tripId) });
        }
      });
    }
  };

  return (
    <div className="bg-card border rounded-xl p-6 shadow-sm relative group flex flex-col md:flex-row gap-6">
      <div className="absolute top-4 right-4 flex gap-2">
        {editMode && (
          <>
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"><Pencil className="h-4 w-4" /></Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Edit Itinerary Day</DialogTitle></DialogHeader>
                <ItineraryForm tripId={tripId} day={day} onSuccess={() => setIsEditOpen(false)} />
              </DialogContent>
            </Dialog>
            <Button variant="ghost" size="icon" onClick={handleDelete} className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive">
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>

      <div className="md:w-32 shrink-0 flex md:flex-col items-center md:items-start gap-3 md:gap-1 md:border-r border-b md:border-b-0 pb-4 md:pb-0 border-border">
        <div className="text-primary font-bold tracking-tight text-sm uppercase">Day {index}</div>
        <div className="text-2xl font-serif">{format(parseISO(day.date), 'MMM d')}</div>
        <div className="text-muted-foreground text-sm">{format(parseISO(day.date), 'EEEE')}</div>
      </div>

      <div className="flex-1 space-y-4">
        <h3 className="text-2xl font-serif font-bold text-foreground pr-16">{day.title}</h3>
        {day.description && (
          <p className="text-muted-foreground whitespace-pre-wrap">{day.description}</p>
        )}
        {day.notes && (
          <div className="bg-muted/50 p-4 rounded-lg text-sm">
            <strong className="block mb-1 text-foreground">Notes</strong>
            <p className="text-muted-foreground whitespace-pre-wrap">{day.notes}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ItineraryForm({ tripId, day, onSuccess }: { tripId: number, day?: any, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createDay = useCreateItineraryDay();
  const updateDay = useUpdateItineraryDay();
  
  const form = useForm<z.infer<typeof itinerarySchema>>({
    resolver: zodResolver(itinerarySchema),
    defaultValues: day ? { ...day } : { date: '', title: '', description: '', notes: '' },
  });

  const onSubmit = (values: z.infer<typeof itinerarySchema>) => {
    if (day) {
      updateDay.mutate({ tripId, itineraryDayId: day.id, data: values }, {
        onSuccess: () => {
          toast.success('Updated');
          queryClient.invalidateQueries({ queryKey: getListItineraryDaysQueryKey(tripId) });
          onSuccess();
        }
      });
    } else {
      createDay.mutate({ tripId, data: values }, {
        onSuccess: () => {
          toast.success('Added');
          queryClient.invalidateQueries({ queryKey: getListItineraryDaysQueryKey(tripId) });
          onSuccess();
        }
      });
    }
  };

  const isPending = createDay.isPending || updateDay.isPending;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
        <FormField control={form.control} name="date" render={({ field }) => (
          <FormItem><FormLabel>Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="title" render={({ field }) => (
          <FormItem><FormLabel>Title</FormLabel><FormControl><Input placeholder="e.g. Arrival & Exploring" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="description" render={({ field }) => (
          <FormItem><FormLabel>Plan / Description</FormLabel><FormControl><Textarea className="h-24" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="notes" render={({ field }) => (
          <FormItem><FormLabel>Extra Notes</FormLabel><FormControl><Textarea {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={isPending}>{isPending ? 'Saving...' : 'Save Day'}</Button>
        </div>
      </form>
    </Form>
  );
}
