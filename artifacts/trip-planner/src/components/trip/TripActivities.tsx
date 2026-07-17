import { useListActivities, useCreateActivity, useUpdateActivity, useDeleteActivity, getListActivitiesQueryKey } from '@workspace/api-client-react';
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
import { Compass, MapPin, Clock, Plus, Trash2, Pencil, CalendarDays } from 'lucide-react';
import { format, parseISO } from 'date-fns';

const API_BASE = `${import.meta.env.BASE_URL}api`;

// ── Location autocomplete ─────────────────────────────────────────────────────

interface PlaceSuggestion {
  name: string;
  address: string;
}

function LocationInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
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
        const res = await fetch(`${API_BASE}/search/places?q=${encodeURIComponent(value)}`);
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
                // Use full "Name, Address" string so the saved value is descriptive
                const label = s.address ? `${s.name}, ${s.address}` : s.name;
                onChange(label);
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

const activitySchema = z.object({
  title: z.string().min(1, 'Title is required'),
  description: z.string().optional(),
  date: z.string().min(1, 'Date is required'),
  time: z.string().optional(),
  location: z.string().optional(),
  type: z.enum(['sightseeing', 'dining', 'adventure', 'culture', 'relaxation', 'transport', 'other']).optional(),
});

export function TripActivities({ tripId, editMode, tripStartDate, tripEndDate }: { tripId: number, editMode?: boolean, tripStartDate?: string, tripEndDate?: string }) {
  const { data: activities, isLoading } = useListActivities(tripId, { query: { enabled: !!tripId } });
  const [isAddOpen, setIsAddOpen] = useState(false);

  if (isLoading) return <div>Loading...</div>;

  const sortedActivities = activities?.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return (
    <div className="space-y-6">
      {editMode && (
        <div className="flex justify-end">
          <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="h-4 w-4 mr-2" /> Add Activity</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Add Activity</DialogTitle></DialogHeader>
              <ActivityForm tripId={tripId} tripStartDate={tripStartDate} tripEndDate={tripEndDate} onSuccess={() => setIsAddOpen(false)} />
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
            <ActivityCard key={activity.id} tripId={tripId} activity={activity} editMode={editMode} tripStartDate={tripStartDate} tripEndDate={tripEndDate} />
          ))}
        </div>
      )}
    </div>
  );
}

function ActivityCard({ tripId, activity, editMode, tripStartDate, tripEndDate }: { tripId: number, activity: any, editMode?: boolean, tripStartDate?: string, tripEndDate?: string }) {
  const queryClient = useQueryClient();
  const deleteActivity = useDeleteActivity();
  const [isEditOpen, setIsEditOpen] = useState(false);

  const handleDelete = () => {
    if (confirm('Delete this activity?')) {
      deleteActivity.mutate({ tripId, activityId: activity.id }, {
        onSuccess: () => {
          toast.success('Deleted');
          queryClient.invalidateQueries({ queryKey: getListActivitiesQueryKey(tripId) });
        }
      });
    }
  };

  return (
    <div className="bg-card border rounded-xl p-5 shadow-sm relative group hover:border-primary/50 transition-colors">
      <div className="absolute top-3 right-3 flex gap-2">
        {editMode && (
          <>
            <Dialog open={isEditOpen} onOpenChange={setIsEditOpen}>
              <DialogTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity"><Pencil className="h-4 w-4" /></Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Edit Activity</DialogTitle></DialogHeader>
                <ActivityForm tripId={tripId} activity={activity} tripStartDate={tripStartDate} tripEndDate={tripEndDate} onSuccess={() => setIsEditOpen(false)} />
              </DialogContent>
            </Dialog>
            <Button variant="ghost" size="icon" onClick={handleDelete} className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity text-destructive hover:text-destructive">
              <Trash2 className="h-4 w-4" />
            </Button>
          </>
        )}
      </div>

      <div className="space-y-4">
        <div className="pr-12">
          <h3 className="font-serif text-lg font-semibold leading-tight mb-1">{activity.title}</h3>
          <span className="text-xs font-medium bg-secondary text-secondary-foreground px-2 py-0.5 rounded-full uppercase tracking-wider">{activity.type}</span>
        </div>

        <div className="space-y-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2 text-foreground font-medium">
            <CalendarDays className="h-4 w-4 text-primary" />
            <span>{format(parseISO(activity.date), 'MMM d, yyyy')}</span>
            {activity.time && (
              <>
                <span className="text-muted-foreground">•</span>
                <Clock className="h-4 w-4 text-primary ml-1" />
                <span>{activity.time}</span>
              </>
            )}
          </div>
          {activity.location && (
            <div className="flex items-start gap-2">
              <MapPin className="h-4 w-4 shrink-0 mt-0.5" />
              <span className="line-clamp-2">{activity.location}</span>
            </div>
          )}
        </div>
        
        {activity.description && (
          <p className="text-sm text-muted-foreground border-t pt-3 line-clamp-3">
            {activity.description}
          </p>
        )}
      </div>
    </div>
  );
}

function ActivityForm({ tripId, activity, tripStartDate, tripEndDate, onSuccess }: { tripId: number, activity?: any, tripStartDate?: string, tripEndDate?: string, onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createActivity = useCreateActivity();
  const updateActivity = useUpdateActivity();
  
  const form = useForm<z.infer<typeof activitySchema>>({
    resolver: zodResolver(activitySchema),
    defaultValues: activity ? {
      ...activity,
    } : {
      title: '', description: '', date: '', time: '', location: '', type: 'sightseeing'
    },
  });

  const onSubmit = (values: z.infer<typeof activitySchema>) => {
    if (activity) {
      updateActivity.mutate({ tripId, activityId: activity.id, data: values }, {
        onSuccess: () => {
          toast.success('Updated');
          queryClient.invalidateQueries({ queryKey: getListActivitiesQueryKey(tripId) });
          onSuccess();
        }
      });
    } else {
      createActivity.mutate({ tripId, data: values }, {
        onSuccess: () => {
          toast.success('Added');
          queryClient.invalidateQueries({ queryKey: getListActivitiesQueryKey(tripId) });
          onSuccess();
        }
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
              <LocationInput value={field.value ?? ''} onChange={field.onChange} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )} />
        <FormField control={form.control} name="type" render={({ field }) => (
          <FormItem><FormLabel>Type</FormLabel>
            <Select onValueChange={field.onChange} defaultValue={field.value}>
              <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
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
        <FormField control={form.control} name="description" render={({ field }) => (
          <FormItem><FormLabel>Notes/Description</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={isPending}>{isPending ? 'Saving...' : 'Save Activity'}</Button>
        </div>
      </form>
    </Form>
  );
}
