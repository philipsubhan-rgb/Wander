import { useParams, Link } from 'wouter';
import { useGetTrip } from '@workspace/api-client-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Pencil, ArrowLeft, Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { format, parseISO } from 'date-fns';

import { TripOverview } from '@/components/trip/TripOverview';
import { TripFlights } from '@/components/trip/TripFlights';
import { TripAccommodations } from '@/components/trip/TripAccommodations';
import { TripActivities } from '@/components/trip/TripActivities';
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

export default function TripDetail({ editMode = false }: { editMode?: boolean }) {
  const { id } = useParams();
  const tripId = Number(id);
  const { data: trip, isLoading } = useGetTrip(tripId, { query: { enabled: !!tripId } });
  const { isAdmin } = useAuth();

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
              <h1 className="text-4xl md:text-5xl font-serif font-bold mb-2">{trip.title}</h1>
              <div className="text-lg md:text-xl text-white/90">
                {trip.destination} • {format(parseISO(trip.startDate), 'MMM d')} - {format(parseISO(trip.endDate), 'MMM d, yyyy')}
              </div>
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
            <TabsContent value="itinerary" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripItinerary tripId={tripId} editMode={editMode} /></TabsContent>
            <TabsContent value="flights" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripFlights tripId={tripId} editMode={editMode} /></TabsContent>
            <TabsContent value="accommodations" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripAccommodations tripId={tripId} editMode={editMode} /></TabsContent>
            <TabsContent value="activities" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripActivities tripId={tripId} editMode={editMode} /></TabsContent>
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
