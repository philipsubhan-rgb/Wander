import { useParams, Link } from 'wouter';
import { useGetTrip, useUpdateTrip, getGetTripQueryKey, getGetTripSummaryQueryKey } from '@workspace/api-client-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pencil, ArrowLeft, Loader2, CalendarDays, Check, X } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { format, parseISO } from 'date-fns';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

import { TripOverview } from '@/components/trip/TripOverview';
import { TripFlights } from '@/components/trip/TripFlights';
import { TripAccommodations } from '@/components/trip/TripAccommodations';
import { TripActivities } from '@/components/trip/TripActivities';
import { TripCarRentals } from '@/components/trip/TripCarRentals';
import { TripItinerary } from '@/components/trip/TripItinerary';
import { TripPackingList } from '@/components/trip/TripPackingList';
import { TripNotes, TripDocuments } from '@/components/trip/TripPrivate';
import { TripSettings } from '@/components/trip/TripSettings';

function getGradientForDestination(destination: string) {
  const hash = destination.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue1 = hash % 360;
  const hue2 = (hash + 40) % 360;
  return `linear-gradient(135deg, hsl(${hue1}, 40%, 60%), hsl(${hue2}, 50%, 40%))`;
}

function InlineDateEditor({ trip, onClose }: { trip: any; onClose: () => void }) {
  const queryClient = useQueryClient();
  const updateTrip = useUpdateTrip();
  const [startDate, setStartDate] = useState((trip.startDate ?? '').slice(0, 10));
  const [endDate, setEndDate] = useState((trip.endDate ?? '').slice(0, 10));

  const handleSave = () => {
    if (!startDate || !endDate) {
      toast.error('Both dates are required');
      return;
    }
    if (endDate < startDate) {
      toast.error('End date must be after start date');
      return;
    }
    updateTrip.mutate(
      { tripId: trip.id, data: { startDate, endDate } },
      {
        onSuccess: () => {
          toast.success('Dates updated');
          queryClient.invalidateQueries({ queryKey: getGetTripQueryKey(trip.id) });
          queryClient.invalidateQueries({ queryKey: getGetTripSummaryQueryKey(trip.id) });
          onClose();
        },
        onError: (err: any) => {
          toast.error(err?.data?.error ?? err?.message ?? 'Failed to update dates');
        },
      }
    );
  };

  return (
    <div className="flex flex-wrap items-center gap-3 bg-white/15 backdrop-blur-md rounded-2xl px-4 py-3 border border-white/30">
      <CalendarDays className="h-4 w-4 text-white/80 shrink-0" />
      <div className="flex items-center gap-2">
        <Input
          type="date"
          value={startDate}
          onChange={e => setStartDate(e.target.value)}
          className="h-8 text-sm bg-white/20 border-white/30 text-white [color-scheme:dark] w-36"
        />
        <span className="text-white/70 text-sm">→</span>
        <Input
          type="date"
          value={endDate}
          onChange={e => setEndDate(e.target.value)}
          className="h-8 text-sm bg-white/20 border-white/30 text-white [color-scheme:dark] w-36"
        />
      </div>
      <div className="flex items-center gap-1">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={updateTrip.isPending}
          className="h-8 bg-white text-black hover:bg-white/90 rounded-full px-3"
        >
          {updateTrip.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={onClose}
          className="h-8 text-white hover:bg-white/20 rounded-full px-3"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}

export default function TripDetail({ editMode = false }: { editMode?: boolean }) {
  const { id } = useParams();
  const tripId = Number(id);
  const { data: trip, isLoading } = useGetTrip(tripId, { query: { enabled: !!tripId } });
  const { isAdmin } = useAuth();
  const [editingDates, setEditingDates] = useState(false);

  if (isLoading) return <div className="flex h-screen items-center justify-center"><Loader2 className="animate-spin h-8 w-8 text-primary"/></div>;
  if (!trip) return <div className="p-10 text-center text-xl">Trip not found</div>;

  return (
    <div className="min-h-screen pb-20 bg-background">
      <div className="relative h-[40vh] min-h-[300px] w-full bg-muted">
        {trip.coverImage ? (
          <img src={trip.coverImage} alt={trip.title} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full" style={{ background: getGradientForDestination(trip.destination) }} />
        )}
        <div className="absolute inset-0 bg-black/40" />
        <div className="absolute inset-0 p-6 md:p-10 max-w-7xl mx-auto flex flex-col justify-between text-white">
          <div>
            <Link href="/trips">
              <Button variant="ghost" className="text-white hover:bg-white/20 -ml-4">
                <ArrowLeft className="h-5 w-5 mr-2" /> Back to Trips
              </Button>
            </Link>
          </div>
          <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
            <div>
              <div className="inline-block px-3 py-1 bg-white/20 backdrop-blur-md rounded-full text-xs font-medium uppercase tracking-wider mb-4">
                {trip.status}
              </div>
              <h1 className="text-4xl md:text-5xl font-serif font-bold mb-3">{trip.title}</h1>

              {/* Date display — clickable in edit mode */}
              {editMode && isAdmin ? (
                editingDates ? (
                  <InlineDateEditor trip={trip} onClose={() => setEditingDates(false)} />
                ) : (
                  <button
                    onClick={() => setEditingDates(true)}
                    className="group flex items-center gap-2 text-lg md:text-xl text-white/90 hover:text-white transition-colors rounded-xl px-2 py-1 -ml-2 hover:bg-white/10"
                    title="Click to edit dates"
                  >
                    <span>
                      {trip.destination} • {format(parseISO(trip.startDate), 'MMM d')} – {format(parseISO(trip.endDate), 'MMM d, yyyy')}
                    </span>
                    <Pencil className="h-3.5 w-3.5 opacity-0 group-hover:opacity-70 transition-opacity shrink-0" />
                  </button>
                )
              ) : (
                <div className="text-lg md:text-xl text-white/90">
                  {trip.destination} • {format(parseISO(trip.startDate), 'MMM d')} – {format(parseISO(trip.endDate), 'MMM d, yyyy')}
                </div>
              )}
            </div>
            {!editMode && isAdmin && (
              <Link href={`/trips/${trip.id}/edit`}>
                <Button variant="secondary" className="bg-white text-black hover:bg-white/90 rounded-full shadow-sm hover-elevate">
                  <Pencil className="h-4 w-4 mr-2" /> Edit Trip
                </Button>
              </Link>
            )}
            {editMode && isAdmin && (
              <Link href={`/trips/${trip.id}`}>
                <Button variant="secondary" className="bg-white text-black hover:bg-white/90 rounded-full shadow-sm hover-elevate">
                  Done Editing
                </Button>
              </Link>
            )}
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 md:px-10 py-8">
        <Tabs defaultValue="overview" className="w-full">
          <div className="overflow-x-auto pb-2 scrollbar-hide">
            <TabsList className="inline-flex w-max min-w-full justify-start md:justify-center border-b rounded-none h-auto p-0 bg-transparent gap-8">
              <TabsTrigger value="overview" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base">Overview</TabsTrigger>
              <TabsTrigger value="itinerary" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base">Itinerary</TabsTrigger>
              <TabsTrigger value="flights" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base">Flights</TabsTrigger>
              <TabsTrigger value="accommodations" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base">Stays</TabsTrigger>
              <TabsTrigger value="activities" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base">Activities</TabsTrigger>
              <TabsTrigger value="car-rentals" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base">Car Rentals</TabsTrigger>
              <TabsTrigger value="packing" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base">Packing List</TabsTrigger>
              <TabsTrigger value="notes" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base">My Notes</TabsTrigger>
              <TabsTrigger value="documents" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base">Documents</TabsTrigger>
              {editMode && isAdmin && (
                <TabsTrigger value="settings" className="data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base">Settings</TabsTrigger>
              )}
            </TabsList>
          </div>

          <div className="mt-10">
            <TabsContent value="overview" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripOverview tripId={tripId} /></TabsContent>
            <TabsContent value="itinerary" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripItinerary tripId={tripId} editMode={editMode} tripStartDate={trip.startDate?.slice(0, 10)} tripEndDate={trip.endDate?.slice(0, 10)} tripDestination={trip.destination} tripCoverImage={trip.coverImage} /></TabsContent>
            <TabsContent value="flights" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripFlights tripId={tripId} editMode={editMode} tripStartDate={trip.startDate?.slice(0, 10)} tripEndDate={trip.endDate?.slice(0, 10)} /></TabsContent>
            <TabsContent value="accommodations" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripAccommodations tripId={tripId} editMode={editMode} tripStartDate={trip.startDate?.slice(0, 10)} tripEndDate={trip.endDate?.slice(0, 10)} /></TabsContent>
            <TabsContent value="activities" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripActivities tripId={tripId} editMode={editMode} tripStartDate={trip.startDate?.slice(0, 10)} tripEndDate={trip.endDate?.slice(0, 10)} tripDestination={trip.destination} /></TabsContent>
            <TabsContent value="car-rentals" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripCarRentals tripId={tripId} editMode={editMode} tripStartDate={trip.startDate?.slice(0, 10)} tripEndDate={trip.endDate?.slice(0, 10)} tripDestination={trip.destination} /></TabsContent>
            <TabsContent value="packing" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripPackingList tripId={tripId} editMode={editMode} /></TabsContent>
            <TabsContent value="notes" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripNotes tripId={tripId} /></TabsContent>
            <TabsContent value="documents" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripDocuments tripId={tripId} /></TabsContent>
            {editMode && isAdmin && (
              <TabsContent value="settings" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripSettings trip={trip} /></TabsContent>
            )}
          </div>
        </Tabs>
      </div>
    </div>
  );
}
