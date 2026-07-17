import { useListTrips, useCreateTrip, getListTripsQueryKey } from '@workspace/api-client-react';
import { useAuth } from '@/hooks/use-auth';
import { Link } from 'wouter';
import { Plus, Calendar, MapPin, Plane } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { format, parseISO } from 'date-fns';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

const tripSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  destination: z.string().min(1, 'Destination is required'),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().min(1, 'End date is required'),
  coverImage: z.string().optional(),
});

function getGradientForDestination(destination: string) {
  const hash = destination.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue1 = hash % 360;
  const hue2 = (hash + 40) % 360;
  return `linear-gradient(135deg, hsl(${hue1}, 40%, 60%), hsl(${hue2}, 50%, 40%))`;
}

export default function TripsDashboard() {
  const { data: trips, isLoading } = useListTrips();
  const { isAdmin } = useAuth();
  const [isNewTripOpen, setIsNewTripOpen] = useState(false);

  if (isLoading) {
    return (
      <div className="p-8 space-y-8 animate-pulse">
        <div className="h-10 w-48 bg-muted rounded-md" />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-[300px] bg-muted rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  const activeTrips = trips?.filter(t => t.status !== 'completed') || [];
  const pastTrips = trips?.filter(t => t.status === 'completed') || [];

  return (
    <div className="p-6 md:p-10 max-w-7xl mx-auto space-y-10">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-4xl font-serif font-bold text-foreground">Your Journeys</h1>
          <p className="text-muted-foreground mt-2 text-lg">Where to next?</p>
        </div>
        
        {isAdmin && (
          <Dialog open={isNewTripOpen} onOpenChange={setIsNewTripOpen}>
            <DialogTrigger asChild>
              <Button size="lg" className="rounded-full shadow-sm hover-elevate">
                <Plus className="h-5 w-5 mr-2" />
                New Trip
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Plan a New Trip</DialogTitle>
                <DialogDescription>
                  Enter the basic details to start planning. You can add more info later.
                </DialogDescription>
              </DialogHeader>
              <NewTripForm onSuccess={() => setIsNewTripOpen(false)} />
            </DialogContent>
          </Dialog>
        )}
      </div>

      {trips?.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center space-y-6 bg-card rounded-2xl border shadow-sm">
          <div className="h-20 w-20 bg-primary/10 rounded-full flex items-center justify-center text-primary">
            <Plane className="h-10 w-10" />
          </div>
          <div className="space-y-2 max-w-md">
            <h3 className="text-2xl font-serif font-semibold">No trips planned yet</h3>
            <p className="text-muted-foreground">
              {isAdmin 
                ? "Start planning your first adventure by creating a new trip." 
                : "You haven't been added to any trips yet. Check back soon!"}
            </p>
          </div>
          {isAdmin && (
            <Button onClick={() => setIsNewTripOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Create First Trip
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-12">
          {activeTrips.length > 0 && (
            <section className="space-y-6">
              <h2 className="text-2xl font-serif font-medium flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-primary" />
                Upcoming & Active
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {activeTrips.map(trip => (
                  <TripCard key={trip.id} trip={trip} />
                ))}
              </div>
            </section>
          )}

          {pastTrips.length > 0 && (
            <section className="space-y-6">
              <h2 className="text-2xl font-serif font-medium text-muted-foreground flex items-center gap-2">
                <span className="h-2 w-2 rounded-full bg-muted-foreground" />
                Past Adventures
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {pastTrips.map(trip => (
                  <TripCard key={trip.id} trip={trip} />
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function TripCard({ trip }: { trip: any }) {
  const isPast = trip.status === 'completed';
  
  return (
    <Link href={`/trips/${trip.id}`} className={`group block relative rounded-2xl overflow-hidden shadow-sm hover:shadow-md transition-all duration-300 border bg-card ${isPast ? 'opacity-80 hover:opacity-100 grayscale-[0.2]' : ''}`}>
      <div className="h-48 w-full relative overflow-hidden bg-muted">
        {trip.coverImage ? (
          <img 
            src={trip.coverImage} 
            alt={trip.title} 
            className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
          />
        ) : (
          <div 
            className="w-full h-full transition-transform duration-700 group-hover:scale-105 flex items-center justify-center"
            style={{ background: getGradientForDestination(trip.destination) }}
          >
            <span className="text-4xl font-serif font-bold text-white/30 truncate px-4">
              {trip.destination}
            </span>
          </div>
        )}
        <div className="absolute top-4 right-4 bg-background/90 backdrop-blur-sm px-3 py-1 rounded-full text-xs font-medium uppercase tracking-wider text-foreground shadow-sm">
          {trip.status}
        </div>
      </div>
      
      <div className="p-6 space-y-4">
        <div>
          <h3 className="text-xl font-serif font-semibold text-foreground group-hover:text-primary transition-colors line-clamp-1">
            {trip.title}
          </h3>
          <div className="flex items-center text-muted-foreground mt-2 text-sm gap-4">
            <div className="flex items-center gap-1.5">
              <MapPin className="h-4 w-4" />
              <span className="line-clamp-1">{trip.destination}</span>
            </div>
          </div>
        </div>
        
        <div className="pt-4 border-t border-border/50 flex items-center text-sm font-medium text-foreground gap-2">
          <Calendar className="h-4 w-4 text-primary" />
          <span>{format(parseISO(trip.startDate), 'MMM d')}</span>
          <span className="text-muted-foreground">-</span>
          <span>{format(parseISO(trip.endDate), 'MMM d, yyyy')}</span>
        </div>
      </div>
    </Link>
  );
}

function NewTripForm({ onSuccess }: { onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createTrip = useCreateTrip();
  
  const form = useForm<z.infer<typeof tripSchema>>({
    resolver: zodResolver(tripSchema),
    defaultValues: {
      title: '',
      destination: '',
      startDate: '',
      endDate: '',
      coverImage: '',
    },
  });

  const onSubmit = (values: z.infer<typeof tripSchema>) => {
    createTrip.mutate({ 
      data: { 
        ...values, 
        status: 'planning' 
      } 
    }, {
      onSuccess: () => {
        toast.success('Trip created successfully');
        queryClient.invalidateQueries({ queryKey: getListTripsQueryKey() });
        onSuccess();
      },
      onError: (error: any) => {
        toast.error(error.error || 'Failed to create trip');
      }
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Trip Title</FormLabel>
              <FormControl>
                <Input placeholder="e.g. Summer in Tuscany" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="destination"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Destination</FormLabel>
              <FormControl>
                <Input placeholder="e.g. Florence, Italy" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="grid grid-cols-2 gap-4">
          <FormField
            control={form.control}
            name="startDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start Date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="endDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>End Date</FormLabel>
                <FormControl>
                  <Input type="date" {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>
        <FormField
          control={form.control}
          name="coverImage"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Cover Image URL (Optional)</FormLabel>
              <FormControl>
                <Input placeholder="https://..." {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={createTrip.isPending}>
            {createTrip.isPending ? 'Creating...' : 'Create Trip'}
          </Button>
        </div>
      </form>
    </Form>
  );
}
