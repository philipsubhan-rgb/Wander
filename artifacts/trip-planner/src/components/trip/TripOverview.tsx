import { useGetTripSummary, useGetTripTimeline } from '@workspace/api-client-react';
import { useState, useEffect } from 'react';
import { Calendar, Plane, Home, Compass, Users, CheckSquare, Car, UtensilsCrossed } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { fetchWikiImage } from '@/lib/wiki-image';

export function TripOverview({ tripId, onNavigate }: { tripId: number; onNavigate?: (tab: string) => void }) {
  const { data: summary } = useGetTripSummary(tripId, { query: { enabled: !!tripId } });
  const { data: timeline } = useGetTripTimeline(tripId, { query: { enabled: !!tripId } });

  return (
    <div className="space-y-10">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <StatCard icon={Calendar} label="Days" value={summary?.daysCount} onClick={() => onNavigate?.('itinerary')} />
        <StatCard icon={Plane} label="Flights" value={summary?.flightsCount} onClick={() => onNavigate?.('flights')} />
        <StatCard icon={Home} label="Stays" value={summary?.accommodationsCount} onClick={() => onNavigate?.('accommodations')} />
        <StatCard icon={Compass} label="Activities" value={summary?.activitiesCount} onClick={() => onNavigate?.('activities')} />
        <StatCard icon={Users} label="Travelers" value={summary?.participantsCount} onClick={() => onNavigate?.('packing')} />
        <StatCard icon={CheckSquare} label="Packed" value={`${summary?.packingCheckedCount || 0}/${summary?.packingItemsCount || 0}`} onClick={() => onNavigate?.('packing')} />
      </div>

      <div className="max-w-3xl">
        <h2 className="text-2xl font-serif font-bold mb-6">Timeline</h2>
        {timeline && timeline.length > 0 ? (
          <div className="space-y-8 relative before:absolute before:inset-0 before:ml-5 before:-translate-x-px before:h-full before:w-0.5 before:bg-gradient-to-b before:from-border/50 before:via-border before:to-transparent">
            {(timeline as any[]).map((event, i) => (
              <div key={`${event.type}-${event.id}-${i}`} className="relative flex items-start gap-6">
                {/* Timeline dot */}
                <div className="relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-card border shadow-sm mt-1">
                  {event.type === 'flight'        && <Plane            className="h-5 w-5 text-primary" />}
                  {event.type === 'accommodation' && <Home             className="h-5 w-5 text-primary" />}
                  {event.type === 'activity'      && <Compass          className="h-5 w-5 text-primary" />}
                  {event.type === 'itinerary'     && <Calendar         className="h-5 w-5 text-primary" />}
                  {event.type === 'car_rental'    && <Car              className="h-5 w-5 text-primary" />}
                  {event.type === 'reservation'   && <UtensilsCrossed  className="h-5 w-5 text-primary" />}
                </div>

                {/* Event card */}
                <div className="flex gap-4 w-full bg-card p-0 rounded-xl border shadow-sm overflow-hidden">
                  {/* Thumbnail */}
                  <EventThumbnail event={event} />

                  {/* Content */}
                  <div className="flex flex-col gap-1 flex-1 p-4 min-w-0">
                    <div className="flex items-start justify-between gap-4">
                      <h4 className="font-serif font-semibold text-base leading-snug">{event.title}</h4>
                      <span className="text-xs font-medium text-muted-foreground whitespace-nowrap bg-muted px-2 py-1 rounded-md shrink-0">
                        {format(parseISO(event.date), 'MMM d, yyyy')}
                      </span>
                    </div>
                    {(event.time || event.location) && (
                      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
                        {event.time && <span>{event.time}</span>}
                        {event.location && <span className="truncate">{event.location}</span>}
                      </div>
                    )}
                    {event.description && (
                      <p className="text-muted-foreground mt-2 text-sm border-t pt-2 line-clamp-2">{event.description}</p>
                    )}
                  </div>
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

// ── Event thumbnail ────────────────────────────────────────────────────────────

function EventThumbnail({ event }: { event: any }) {
  const [wikiImage, setWikiImage] = useState<string | null>(null);
  const [logoError, setLogoError] = useState(false);

  useEffect(() => {
    const fetchable = event.type === 'activity' || event.type === 'accommodation' || event.type === 'reservation';
    if (!fetchable) return;
    if (event.imageUrl) return;
    const query = event.location || event.title.replace(/^Check-in: /, '');
    fetchWikiImage(query).then(url => { if (url) setWikiImage(url); });
  }, [event.id, event.type, event.imageUrl]);

  const displayImage = event.imageUrl || wikiImage;

  // Flights: airline logo
  if (event.type === 'flight') {
    if (event.carrierCode && !logoError) {
      return (
        <div className="w-20 shrink-0 bg-muted/50 flex items-center justify-center">
          <img
            src={`https://pics.avs.io/200/80/${event.carrierCode!.toUpperCase()}.png`}
            alt=""
            className="w-16 h-auto object-contain p-1"
            onError={() => setLogoError(true)}
          />
        </div>
      );
    }
    return (
      <div className="w-20 shrink-0 bg-primary/5 flex items-center justify-center">
        <Plane className="h-8 w-8 text-primary/40" />
      </div>
    );
  }

  // Activities / accommodations / reservations: photo
  if (event.type === 'activity' || event.type === 'accommodation' || event.type === 'reservation') {
    if (displayImage) {
      return (
        <div className="w-24 shrink-0 overflow-hidden">
          <img src={displayImage} alt="" className="h-full w-full object-cover" />
        </div>
      );
    }
    const icon = event.type === 'accommodation'
      ? <Home className="h-7 w-7 text-white/60" />
      : event.type === 'reservation'
        ? <UtensilsCrossed className="h-7 w-7 text-white/60" />
        : <Compass className="h-7 w-7 text-white/60" />;
    const bg = event.type === 'accommodation' ? '#f59e0b'
      : event.type === 'reservation' ? '#f97316'
      : '#60a5fa';
    return (
      <div className="w-24 shrink-0 flex items-center justify-center" style={{ background: bg }}>
        {icon}
      </div>
    );
  }

  // Car rentals: car icon with blue tint
  if (event.type === 'car_rental') {
    return (
      <div className="w-20 shrink-0 flex items-center justify-center" style={{ background: '#3b82f6' }}>
        <Car className="h-7 w-7 text-white/70" />
      </div>
    );
  }

  // Itinerary days: calendar icon, no image
  return (
    <div className="w-20 shrink-0 bg-muted/50 flex items-center justify-center">
      <Calendar className="h-7 w-7 text-muted-foreground/60" />
    </div>
  );
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, onClick }: { icon: any; label: string; value: any; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className="bg-card border rounded-xl p-4 flex flex-col items-center justify-center text-center space-y-2 shadow-sm hover:shadow-md hover:border-primary/50 hover:bg-primary/5 transition-all cursor-pointer w-full group"
    >
      <div className="p-2 bg-primary/10 rounded-full group-hover:bg-primary/20 transition-colors">
        <Icon className="h-5 w-5 text-primary" />
      </div>
      <span className="text-2xl font-bold text-foreground">{value !== undefined ? value : '-'}</span>
      <span className="text-xs text-muted-foreground uppercase tracking-wider font-medium">{label}</span>
    </button>
  );
}
