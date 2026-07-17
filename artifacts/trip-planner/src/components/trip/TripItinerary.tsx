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
import { Plus, Trash2, Pencil, CalendarRange, Clock } from 'lucide-react';
import { format, parseISO } from 'date-fns';

const itinerarySchema = z.object({
  date: z.string().min(1, 'Date is required'),
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  notes: z.string().optional(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
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

function formatTime(time: string | null | undefined) {
  if (!time) return null;
  // Convert "HH:MM" to "h:mm AM/PM"
  const [h, m] = time.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 || 12;
  return `${hour}:${String(m).padStart(2, '0')} ${ampm}`;
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

  const startFmt = formatTime(day.startTime);
  const endFmt = formatTime(day.endTime);
  const timeLabel = startFmt && endFmt
    ? `${startFmt} – ${endFmt}`
    : startFmt ?? endFmt ?? null;

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
        {timeLabel && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground mt-1">
            <Clock className="h-3 w-3 shrink-0" />
            <span>{timeLabel}</span>
          </div>
        )}
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
    defaultValues: day
      ? { date: day.date, title: day.title, description: day.description ?? '', notes: day.notes ?? '', startTime: day.startTime ?? '', endTime: day.endTime ?? '' }
      : { date: '', title: '', description: '', notes: '', startTime: '', endTime: '' },
  });

  const onSubmit = (values: z.infer<typeof itinerarySchema>) => {
    // Send undefined instead of '' so optional fields are omitted cleanly
    const payload = {
      ...values,
      startTime: values.startTime || undefined,
      endTime: values.endTime || undefined,
    };
    if (day) {
      updateDay.mutate({ tripId, itineraryDayId: day.id, data: payload }, {
        onSuccess: () => {
          toast.success('Updated');
          queryClient.invalidateQueries({ queryKey: getListItineraryDaysQueryKey(tripId) });
          onSuccess();
        },
        onError: (err: any) => toast.error(err?.data?.error ?? 'Failed to update'),
      });
    } else {
      createDay.mutate({ tripId, data: payload }, {
        onSuccess: () => {
          toast.success('Added');
          queryClient.invalidateQueries({ queryKey: getListItineraryDaysQueryKey(tripId) });
          onSuccess();
        },
        onError: (err: any) => toast.error(err?.data?.error ?? 'Failed to add'),
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

        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="startTime" render={({ field }) => (
            <FormItem>
              <FormLabel>Start Time <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
              <FormControl><Input type="time" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
          <FormField control={form.control} name="endTime" render={({ field }) => (
            <FormItem>
              <FormLabel>End Time <span className="text-muted-foreground font-normal">(optional)</span></FormLabel>
              <FormControl><Input type="time" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />
        </div>

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
