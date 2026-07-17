import { useGetTripSummary, useGetTripTimeline } from '@workspace/api-client-react';
import { Calendar, Plane, Home, Compass, Users, CheckSquare } from 'lucide-react';
import { format, parseISO } from 'date-fns';

export function TripOverview({ tripId }: { tripId: number }) {
  const { data: summary } = useGetTripSummary(tripId, { query: { enabled: !!tripId } });
  const { data: timeline } = useGetTripTimeline(tripId, { query: { enabled: !!tripId } });

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard icon={Calendar} label="Days" value={summary?.daysCount} />
        <StatCard icon={Plane} label="Flights" value={summary?.flightsCount} />
        <StatCard icon={Home} label="Stays" value={summary?.accommodationsCount} />
        <StatCard icon={Compass} label="Activities" value={summary?.activitiesCount} />
        <StatCard icon={Users} label="Travelers" value={summary?.participantsCount} />
        <StatCard icon={CheckSquare} label="Packed" value={`${summary?.packingCheckedCount || 0}/${summary?.packingItemsCount || 0}`} />
      </div>
      
      <div className="max-w-3xl">
        <h2 className="text-2xl font-serif font-bold mb-6">Timeline</h2>
        {timeline && timeline.length > 0 ? (
          <div className="space-y-8 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px before:h-full before:w-0.5 before:bg-gradient-to-b before:from-border/50 before:via-border before:to-transparent">
            {timeline.map((event, i) => (
              <div key={`${event.type}-${event.id}-${i}`} className="relative flex items-start gap-6">
                <div className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-card border shadow-sm mt-1">
                  {event.type === 'flight' && <Plane className="h-5 w-5 text-primary" />}
                  {event.type === 'accommodation' && <Home className="h-5 w-5 text-primary" />}
                  {event.type === 'activity' && <Compass className="h-5 w-5 text-primary" />}
                  {event.type === 'itinerary' && <Calendar className="h-5 w-5 text-primary" />}
                </div>
                <div className="flex flex-col gap-1 w-full bg-card p-5 rounded-xl border shadow-sm">
                  <div className="flex items-start justify-between gap-4">
                    <h4 className="font-serif font-semibold text-lg">{event.title}</h4>
                    <span className="text-sm font-medium text-muted-foreground whitespace-nowrap bg-muted px-2 py-1 rounded-md">
                      {format(parseISO(event.date), 'MMM d, yyyy')}
                    </span>
                  </div>
                  {(event.time || event.location) && (
                    <div className="flex flex-wrap items-center gap-4 text-sm text-muted-foreground mt-1">
                      {event.time && <span>{event.time}</span>}
                      {event.location && <span>{event.location}</span>}
                    </div>
                  )}
                  {event.description && (
                    <p className="text-muted-foreground mt-3 text-sm border-t pt-3">{event.description}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-center py-12 bg-muted/50 rounded-xl border border-dashed">
            <Calendar className="h-10 w-10 text-muted-foreground mx-auto mb-4" />
            <p className="text-lg font-medium">Timeline empty</p>
            <p className="text-muted-foreground">Add flights, stays, or activities to build your timeline.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: any, label: string, value: any }) {
  return (
    <div className="bg-card border rounded-xl p-4 flex flex-col items-center justify-center text-center space-y-2 shadow-sm hover:shadow-md transition-shadow">
      <div className="p-2 bg-primary/10 rounded-full">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <span className="text-2xl font-bold text-foreground">{value !== undefined ? value : '-'}</span>
      <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
    </div>
  );
}
