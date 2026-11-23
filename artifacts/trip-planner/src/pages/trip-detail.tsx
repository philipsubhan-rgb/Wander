import { useParams, Link } from 'wouter';
import {
  useGetTrip, useUpdateTrip, useListTripParticipants,
  getGetTripQueryKey, getGetTripSummaryQueryKey,
} from '@workspace/api-client-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Pencil, ArrowLeft, Loader2, CalendarDays, Check, X, BookOpen,
  LayoutGrid, Plane, BedDouble, Compass, Receipt, Car, CalendarCheck,
  Backpack, StickyNote, FolderOpen, Users, UsersRound, Settings as SettingsIcon,
  MoreHorizontal,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { format, parseISO } from 'date-fns';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

import { TripOverview } from '@/components/trip/TripOverview';
import { TripFlights } from '@/components/trip/TripFlights';
import { TripAccommodations } from '@/components/trip/TripAccommodations';
import { TripActivities } from '@/components/trip/TripActivities';
import { TripCarRentals } from '@/components/trip/TripCarRentals';
import { TripReservations } from '@/components/trip/TripReservations';
import { TripItinerary } from '@/components/trip/TripItinerary';
import { TripPackingList } from '@/components/trip/TripPackingList';
import { TripNotes, TripDocuments } from '@/components/trip/TripPrivate';
import { TripSettings } from '@/components/trip/TripSettings';
import { TripTravelers } from '@/components/trip/TripTravelers';
import { TripRoster } from '@/components/trip/TripRoster';
import { TripExpenses } from '@/components/trip/TripExpenses';
import MarcoBar from '@/components/MarcoBar';

function getGradientForDestination(destination: string) {
  const hash = destination.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hue1 = hash % 360;
  const hue2 = (hash + 40) % 360;
  return `linear-gradient(135deg, hsl(${hue1}, 40%, 60%), hsl(${hue2}, 50%, 40%))`;
}

// All trip sections in one place — drives the desktop tab rail, the mobile
// tab bar, and the mobile "More" sheet, so no tab can ever be unreachable.
interface TripTabDef {
  value: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
}

const TRIP_TABS: TripTabDef[] = [
  { value: 'overview', label: 'Overview', icon: LayoutGrid },
  { value: 'itinerary', label: 'Itinerary', icon: CalendarDays },
  { value: 'flights', label: 'Flights', icon: Plane },
  { value: 'accommodations', label: 'Stays', icon: BedDouble },
  { value: 'activities', label: 'Activities', icon: Compass },
  { value: 'expenses', label: 'Expenses', icon: Receipt },
  { value: 'car-rentals', label: 'Car Rentals', icon: Car },
  { value: 'reservations', label: 'Reservations', icon: CalendarCheck },
  { value: 'packing', label: 'Packing List', icon: Backpack },
  { value: 'notes', label: 'My Notes', icon: StickyNote },
  { value: 'documents', label: 'Documents', icon: FolderOpen },
  { value: 'party', label: 'Party', icon: UsersRound },
  { value: 'travelers', label: 'Travelers', icon: Users, adminOnly: true },
  { value: 'settings', label: 'Settings', icon: SettingsIcon, adminOnly: true },
];

// The four sections pinned to the mobile tab bar; everything else lives
// under "More" (still fully reachable — nothing is hidden).
const MOBILE_PRIMARY_TABS = ['overview', 'itinerary', 'flights', 'accommodations'] as const;

const DESKTOP_TRIGGER_CLASS =
  'data-[state=active]:bg-transparent data-[state=active]:shadow-none data-[state=active]:border-b-2 data-[state=active]:border-primary data-[state=active]:text-primary rounded-none px-2 py-4 text-base';

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
  const { isAdmin, user } = useAuth();
  const currentUserId = (user as any)?.id as number | undefined;
  const { data: participantsData } = useListTripParticipants(tripId, { query: { enabled: !!tripId } });
  const participants = (participantsData ?? []).map((p: any) => ({ id: p.id, name: p.name }));
  const [editingDates, setEditingDates] = useState(false);
  const [activeTab, setActiveTab] = useState('overview');
  const [moreOpen, setMoreOpen] = useState(false);

  if (isLoading) return <div className="flex h-screen items-center justify-center"><Loader2 className="animate-spin h-8 w-8 text-primary"/></div>;
  if (!trip) return <div className="p-10 text-center text-xl">Trip not found</div>;

  // canAdmin = global admin OR the user is a trip admin for this specific trip
  const canAdmin = isAdmin || !!(trip as any).isTripAdmin;

  const visibleTabs = TRIP_TABS.filter((t) => !t.adminOnly || canAdmin);
  const primaryTabs = visibleTabs.filter((t) => (MOBILE_PRIMARY_TABS as readonly string[]).includes(t.value));
  const moreTabs = visibleTabs.filter((t) => !(MOBILE_PRIMARY_TABS as readonly string[]).includes(t.value));
  const moreHasActive = moreTabs.some((t) => t.value === activeTab);

  return (
    <div className="min-h-screen pb-20 bg-background">
      <div className="relative h-[40vh] min-h-[300px] w-full bg-muted">
        {trip.coverImage ? (
          <img
            src={trip.coverImage.startsWith('/objects/') ? `/api/trips/${tripId}/cover` : trip.coverImage}
            alt={trip.title}
            className="w-full h-full object-cover"
          />
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

              {/* Date display — clickable in edit mode for trip admins */}
              {editMode && canAdmin ? (
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
            {!editMode && (
              <div className="flex flex-wrap gap-2">
                <Button asChild variant="secondary" className="bg-white/90 text-black hover:bg-white rounded-full shadow-sm hover-elevate">
                  <Link href={`/trips/${trip.id}/guide`} data-testid="link-generate-guide">
                    <BookOpen className="h-4 w-4 mr-2" /> Generate Guide
                  </Link>
                </Button>
                {canAdmin && (
                  <Link href={`/trips/${trip.id}/edit`}>
                    <Button variant="secondary" className="bg-white text-black hover:bg-white/90 rounded-full shadow-sm hover-elevate">
                      <Pencil className="h-4 w-4 mr-2" /> Edit Trip
                    </Button>
                  </Link>
                )}
              </div>
            )}
            {editMode && canAdmin && (
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
        <div className="mb-6">
          <MarcoBar tripId={tripId} />
        </div>
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          {/* Desktop tab rail — unchanged */}
          <div className="hidden md:block overflow-x-auto pb-2 scrollbar-hide">
            <TabsList className="inline-flex w-max min-w-full justify-start md:justify-center border-b rounded-none h-auto p-0 bg-transparent gap-8">
              {visibleTabs.map((tab) => (
                <TabsTrigger key={tab.value} value={tab.value} className={DESKTOP_TRIGGER_CLASS}>
                  {tab.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </div>

          {/* Mobile tab bar: 4 primary sections pinned, everything else under "More" */}
          <div className="md:hidden sticky top-0 z-40 -mx-4 px-2 bg-background/95 backdrop-blur border-b">
            <div className="flex items-stretch" role="tablist" aria-label="Trip sections">
              {primaryTabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.value;
                return (
                  <button
                    key={tab.value}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setActiveTab(tab.value)}
                    className={cn(
                      'flex-1 flex flex-col items-center justify-center gap-1 py-2 min-h-[60px] text-[11px] font-medium border-b-2 transition-colors',
                      active ? 'text-primary border-primary' : 'text-muted-foreground border-transparent',
                    )}
                  >
                    <Icon className="h-5 w-5" />
                    <span className="leading-none">{tab.label}</span>
                  </button>
                );
              })}
              <button
                onClick={() => setMoreOpen(true)}
                aria-label="More trip sections"
                className={cn(
                  'flex-1 flex flex-col items-center justify-center gap-1 py-2 min-h-[60px] text-[11px] font-medium border-b-2 transition-colors',
                  moreHasActive ? 'text-primary border-primary' : 'text-muted-foreground border-transparent',
                )}
              >
                <MoreHorizontal className="h-5 w-5" />
                <span className="leading-none">More</span>
              </button>
            </div>
          </div>

          <div className="mt-10">
            <TabsContent value="overview" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripOverview tripId={tripId} onNavigate={setActiveTab} /></TabsContent>
            <TabsContent value="itinerary" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripItinerary tripId={tripId} editMode={editMode} tripStartDate={trip.startDate?.slice(0, 10)} tripEndDate={trip.endDate?.slice(0, 10)} tripDestination={trip.destination} tripCoverImage={trip.coverImage} /></TabsContent>
            <TabsContent value="flights" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripFlights tripId={tripId} editMode={editMode} tripStartDate={trip.startDate?.slice(0, 10)} tripEndDate={trip.endDate?.slice(0, 10)} /></TabsContent>
            <TabsContent value="accommodations" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripAccommodations tripId={tripId} editMode={editMode} tripStartDate={trip.startDate?.slice(0, 10)} tripEndDate={trip.endDate?.slice(0, 10)} /></TabsContent>
            <TabsContent value="activities" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripActivities tripId={tripId} editMode={editMode} tripStartDate={trip.startDate?.slice(0, 10)} tripEndDate={trip.endDate?.slice(0, 10)} tripDestination={trip.destination} /></TabsContent>
            <TabsContent value="expenses" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripExpenses tripId={tripId} participants={participants} currentUserId={currentUserId} /></TabsContent>
            <TabsContent value="car-rentals" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripCarRentals tripId={tripId} editMode={editMode} tripStartDate={trip.startDate?.slice(0, 10)} tripEndDate={trip.endDate?.slice(0, 10)} tripDestination={trip.destination} /></TabsContent>
            <TabsContent value="reservations" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripReservations tripId={tripId} editMode={editMode} tripDestination={trip.destination} /></TabsContent>
            <TabsContent value="packing" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripPackingList tripId={tripId} /></TabsContent>
            <TabsContent value="notes" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripNotes tripId={tripId} /></TabsContent>
            <TabsContent value="documents" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripDocuments tripId={tripId} /></TabsContent>
            <TabsContent value="party" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripRoster tripId={tripId} canManage={canAdmin} /></TabsContent>
            {canAdmin && (
              <TabsContent value="travelers" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripTravelers tripId={tripId} /></TabsContent>
            )}
            {canAdmin && (
              <TabsContent value="settings" className="mt-0 focus-visible:outline-none focus-visible:ring-0"><TripSettings trip={trip} /></TabsContent>
            )}
          </div>
        </Tabs>

        {/* Mobile "More" sheet — every section reachable, none hidden */}
        <Drawer open={moreOpen} onOpenChange={setMoreOpen}>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Trip sections</DrawerTitle>
            </DrawerHeader>
            <div className="px-4 pb-10 grid gap-1">
              {visibleTabs.map((tab) => {
                const Icon = tab.icon;
                const active = activeTab === tab.value;
                return (
                  <button
                    key={tab.value}
                    onClick={() => {
                      setActiveTab(tab.value);
                      setMoreOpen(false);
                    }}
                    className={cn(
                      'flex items-center gap-3 rounded-xl px-3 min-h-[52px] text-left text-[15px] font-medium transition-colors',
                      active ? 'bg-primary/10 text-primary' : 'text-foreground active:bg-muted',
                    )}
                  >
                    <Icon className="h-5 w-5 shrink-0" />
                    {tab.label}
                    {active && <Check className="ml-auto h-4 w-4" />}
                  </button>
                );
              })}
            </div>
          </DrawerContent>
        </Drawer>
      </div>
    </div>
  );
}
