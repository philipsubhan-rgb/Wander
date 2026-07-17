import { 
  useUpdateTrip, useListTripParticipants, useAddTripParticipant, useRemoveTripParticipant, useListUsers, getGetTripQueryKey, getListTripParticipantsQueryKey 
} from '@workspace/api-client-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Users, Trash2, Plus, Shield } from 'lucide-react';

const tripSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  destination: z.string().min(1, 'Destination is required'),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().min(1, 'End date is required'),
  status: z.enum(['planning', 'confirmed', 'active', 'completed']),
  coverImage: z.string().optional(),
});

export function TripSettings({ trip }: { trip: any }) {
  const queryClient = useQueryClient();
  const updateTrip = useUpdateTrip();
  const { data: participants } = useListTripParticipants(trip.id);
  const { data: users } = useListUsers();
  const addParticipant = useAddTripParticipant();
  const removeParticipant = useRemoveTripParticipant();
  
  const [selectedUserId, setSelectedUserId] = useState<string>('');

  const form = useForm<z.infer<typeof tripSchema>>({
    resolver: zodResolver(tripSchema),
    defaultValues: {
      title: trip.title,
      destination: trip.destination,
      startDate: trip.startDate.slice(0, 10),
      endDate: trip.endDate.slice(0, 10),
      status: trip.status,
      coverImage: trip.coverImage || '',
    },
  });

  const onSubmit = (values: z.infer<typeof tripSchema>) => {
    updateTrip.mutate({ tripId: trip.id, data: values }, {
      onSuccess: () => {
        toast.success('Trip settings updated');
        queryClient.invalidateQueries({ queryKey: getGetTripQueryKey(trip.id) });
      }
    });
  };

  const handleAddParticipant = () => {
    if (!selectedUserId) return;
    addParticipant.mutate({ tripId: trip.id, data: { userId: Number(selectedUserId) } }, {
      onSuccess: () => {
        toast.success('Traveler added');
        queryClient.invalidateQueries({ queryKey: getListTripParticipantsQueryKey(trip.id) });
        setSelectedUserId('');
      },
      onError: (e: any) => toast.error(e.error || 'Failed to add traveler')
    });
  };

  const handleRemoveParticipant = (userId: number) => {
    removeParticipant.mutate({ tripId: trip.id, userId }, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListTripParticipantsQueryKey(trip.id) });
      }
    });
  };

  // filter users not already in trip
  const availableUsers = users?.filter(u => !participants?.some(p => p.id === u.id));

  return (
    <div className="grid md:grid-cols-2 gap-10">
      <div className="space-y-6">
        <h2 className="text-2xl font-serif font-bold">General Settings</h2>
        <div className="bg-card border rounded-xl p-6 shadow-sm">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="title" render={({ field }) => (
                <FormItem><FormLabel>Trip Title</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="destination" render={({ field }) => (
                <FormItem><FormLabel>Destination</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="startDate" render={({ field }) => (
                  <FormItem><FormLabel>Start Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="endDate" render={({ field }) => (
                  <FormItem><FormLabel>End Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem><FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="planning">Planning</SelectItem>
                      <SelectItem value="confirmed">Confirmed</SelectItem>
                      <SelectItem value="active">Active (Happening now)</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                    </SelectContent>
                  </Select>
                <FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="coverImage" render={({ field }) => (
                <FormItem><FormLabel>Cover Image URL</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="pt-4">
                <Button type="submit" disabled={updateTrip.isPending} className="w-full">
                  {updateTrip.isPending ? 'Saving...' : 'Save Settings'}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </div>

      <div className="space-y-6">
        <h2 className="text-2xl font-serif font-bold">Travelers</h2>
        <div className="bg-card border rounded-xl p-6 shadow-sm space-y-6">
          <div className="flex gap-2">
            <Select value={selectedUserId} onValueChange={setSelectedUserId}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Select traveler to add" />
              </SelectTrigger>
              <SelectContent>
                {availableUsers?.map(user => (
                  <SelectItem key={user.id} value={user.id.toString()}>
                    {user.name} (@{user.username})
                  </SelectItem>
                ))}
                {availableUsers?.length === 0 && <SelectItem value="none" disabled>No available users</SelectItem>}
              </SelectContent>
            </Select>
            <Button onClick={handleAddParticipant} disabled={!selectedUserId || addParticipant.isPending}>
              <Plus className="h-4 w-4 mr-2" /> Add
            </Button>
          </div>

          <div className="space-y-3">
            {participants?.map(user => (
              <div key={user.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 bg-primary/20 text-primary font-bold rounded-full flex items-center justify-center text-xs">
                    {user.name.charAt(0)}
                  </div>
                  <div>
                    <p className="font-medium text-sm flex items-center gap-1">
                      {user.name}
                      {user.role === 'admin' && <Shield className="h-3 w-3 text-primary" />}
                    </p>
                    <p className="text-xs text-muted-foreground">@{user.username}</p>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => handleRemoveParticipant(user.id)} className="h-8 w-8 text-destructive hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
