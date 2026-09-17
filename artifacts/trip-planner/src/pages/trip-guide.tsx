import React, { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams } from 'wouter';
import {
  ArrowLeft,
  ArrowUpRight,
  BookOpen,
  CalendarDays,
  Car,
  Clock3,
  FileText,
  Hotel,
  MapPin,
  Navigation,
  Paperclip,
  Plane,
  Printer,
  ReceiptText,
  Route as RouteIcon,
  Utensils,
} from 'lucide-react';
import {
  getGetTripQueryKey,
  getGetTripTimelineQueryKey,
  getListAccommodationsQueryKey,
  getListActivitiesQueryKey,
  getListCarRentalsQueryKey,
  getListFlightsQueryKey,
  getListReservationsQueryKey,
  getListTravelDocumentsQueryKey,
  getListTripNotesQueryKey,
  useGetTrip,
  useGetTripTimeline,
  useListAccommodations,
  useListActivities,
  useListCarRentals,
  useListFlights,
  useListReservations,
  useListTravelDocuments,
  useListTripNotes,
} from '@workspace/api-client-react';
import { format, isValid, parseISO, addDays, differenceInCalendarDays } from 'date-fns';
import { Button } from '@/components/ui/button';
import { formatFlightDateTime, formatFlightTime } from '@workspace/flight-time';
import { fetchWikiImage } from '@/lib/wiki-image';
import { GuideMap, type GuideMapStop } from '@/components/trip/GuideMap';
import { buildGuideStops, buildRouteLegs, type GuideRouteStop } from '@/lib/trip-guide';

type AnyRecord = Record<string, any>;
type GuideEvent = AnyRecord & { date: string; title: string; type?: string };

function asArray(value: unknown): AnyRecord[] {
  return Array.isArray(value) ? (value as AnyRecord[]) : [];
}

function dateValue(value?: string | null) {
  if (!value) return null;
  const parsed = parseISO(value);
  return isValid(parsed) ? parsed : null;
}

function formatGuideDate(value?: string | null, pattern = 'MMMM d, yyyy') {
  const parsed = dateValue(value);
  return parsed ? format(parsed, pattern) : 'Date to be confirmed';
}

function formatDateRange(start?: string, end?: string) {
  const first = dateValue(start);
  const last = dateValue(end);
  if (!first || !last) return 'Dates to be confirmed';
  if (format(first, 'yyyy') === format(last, 'yyyy')) {
    return `${format(first, 'MMMM d')} — ${format(last, 'MMMM d, yyyy')}`;
  }
  return `${format(first, 'MMMM d, yyyy')} — ${format(last, 'MMMM d, yyyy')}`;
}

function getDays(start?: string, end?: string) {
  const first = dateValue(start);
  const last = dateValue(end);
  if (!first || !last) return [];
  const length = Math.max(1, differenceInCalendarDays(last, first) + 1);
  return Array.from({ length }, (_, index) => addDays(first, index));
}

function titleCase(value?: string | null) {
  if (!value) return '';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compact(value?: string | null, fallback = 'Details to be confirmed') {
  return value?.trim() || fallback;
}

function ImageOrPlaceholder({
  src,
  query,
  alt,
  className,
}: {
  src?: string | null;
  query: string;
  alt: string;
  className?: string;
}) {
  const [wikiImage, setWikiImage] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    if (src || !query) return () => { active = false; };
    fetchWikiImage(query).then((image) => {
      if (active) setWikiImage(image);
    });
    return () => { active = false; };
  }, [query, src]);

  const image = failed ? null : src || wikiImage;
  if (image) {
    return (
      <img
        src={image}
        alt={alt}
        className={className}
        onError={() => setFailed(true)}
        data-testid={`img-guide-${query.replace(/\W+/g, '-').toLowerCase()}`}
      />
    );
  }
  return (
    <div
      className={`${className || ''} bg-[linear-gradient(135deg,#c2dce8,#e9e3d3)]`}
      aria-label={`${alt} image placeholder`}
      data-testid={`image-placeholder-${query.replace(/\W+/g, '-').toLowerCase()}`}
    />
  );
}

function SectionHeading({ eyebrow, title, detail }: { eyebrow: string; title: string; detail?: string }) {
  return (
    <div className="mb-7 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-primary" data-testid={`text-eyebrow-${eyebrow.toLowerCase().replace(/\W+/g, '-')}`}>
          {eyebrow}
        </p>
        <h2 className="mt-2 text-3xl font-medium tracking-tight text-[#16334d] md:text-4xl">{title}</h2>
      </div>
      {detail && <p className="max-w-xs text-sm leading-6 text-muted-foreground sm:text-right">{detail}</p>}
    </div>
  );
}

function EmptySection({ title, body }: { title: string; body: string }) {
  return (
    <div className="guide-card rounded-2xl border border-dashed border-primary/25 bg-primary/[0.035] px-6 py-9 text-center">
      <BookOpen className="mx-auto mb-3 h-7 w-7 text-primary/55" />
      <p className="font-serif text-xl text-[#16334d]">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}

function DetailLine({ icon: Icon, children, testId }: { icon: typeof MapPin; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start gap-2 text-sm leading-6 text-muted-foreground" data-testid={testId}>
      <Icon className="mt-1 h-3.5 w-3.5 shrink-0 text-primary/80" />
      <span>{children}</span>
    </div>
  );
}

function GuideSkeleton() {
  return (
    <div className="min-h-screen bg-background px-4 py-8 md:px-10">
      <div className="mx-auto max-w-5xl animate-pulse space-y-6">
        <div className="h-8 w-28 rounded-full bg-muted" />
        <div className="h-[440px] rounded-[2rem] bg-muted" />
        <div className="grid gap-4 md:grid-cols-3">
          <div className="h-28 rounded-2xl bg-muted" />
          <div className="h-28 rounded-2xl bg-muted" />
          <div className="h-28 rounded-2xl bg-muted" />
        </div>
        <div className="h-64 rounded-2xl bg-muted" />
      </div>
    </div>
  );
}

export default function TripGuide() {
  const { id } = useParams();
  const tripId = Number(id);
  const enabled = Number.isFinite(tripId) && tripId > 0;
  const tripQuery = useGetTrip(tripId, {
    query: { enabled, queryKey: getGetTripQueryKey(tripId) },
  });
  const timelineQuery = useGetTripTimeline(tripId, {
    query: { enabled, queryKey: getGetTripTimelineQueryKey(tripId) },
  });
  const flightsQuery = useListFlights(tripId, {
    query: { enabled, queryKey: getListFlightsQueryKey(tripId) },
  });
  const staysQuery = useListAccommodations(tripId, {
    query: { enabled, queryKey: getListAccommodationsQueryKey(tripId) },
  });
  const activitiesQuery = useListActivities(tripId, {
    query: { enabled, queryKey: getListActivitiesQueryKey(tripId) },
  });
  const carsQuery = useListCarRentals(tripId, {
    query: { enabled, queryKey: getListCarRentalsQueryKey(tripId) },
  });
  const reservationsQuery = useListReservations(tripId, {
    query: { enabled, queryKey: getListReservationsQueryKey(tripId) },
  });
  const notesQuery = useListTripNotes(tripId, {
    query: { enabled, queryKey: getListTripNotesQueryKey(tripId) },
  });
  const documentsQuery = useListTravelDocuments(tripId, {
    query: { enabled, queryKey: getListTravelDocumentsQueryKey(tripId) },
  });

  const trip = tripQuery.data as AnyRecord | undefined;
  const timeline = asArray(timelineQuery.data) as GuideEvent[];
  const flights = asArray(flightsQuery.data);
  const stays = asArray(staysQuery.data);
  const activities = asArray(activitiesQuery.data);
  const cars = asArray(carsQuery.data);
  const reservations = asArray(reservationsQuery.data);
  const notes = asArray(notesQuery.data);
  const documents = asArray(documentsQuery.data);
  const allStops = useMemo<GuideRouteStop[]>(
    () => buildGuideStops({ stays, activities, reservations, cars }),
    [activities, cars, reservations, stays],
  );
  const stopData = useMemo<GuideMapStop[]>(
    () => allStops.filter((stop): stop is GuideMapStop => Number.isFinite(stop.lat) && Number.isFinite(stop.lon)),
    [allStops],
  );
  const routeLegs = useMemo(() => buildRouteLegs(allStops), [allStops]);
  const days = useMemo(() => getDays(trip?.startDate, trip?.endDate), [trip?.startDate, trip?.endDate]);
  const eventsByDate = useMemo(() => {
    const grouped = new Map<string, GuideEvent[]>();
    timeline.forEach((event) => {
      const key = event.date?.slice(0, 10);
      if (!key) return;
      grouped.set(key, [...(grouped.get(key) || []), event]);
    });
    return grouped;
  }, [timeline]);
  const [destinationImage, setDestinationImage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!trip || trip.coverImage) return () => { active = false; };
    fetchWikiImage(trip.destination).then((image) => {
      if (active) setDestinationImage(image);
    });
    return () => { active = false; };
  }, [trip]);

  if (tripQuery.isLoading) return <GuideSkeleton />;
  if (tripQuery.isError || !trip) {
    return (
      <main className="flex min-h-[70vh] items-center justify-center bg-background px-6">
        <div className="max-w-md rounded-3xl border bg-card p-9 text-center shadow-sm">
          <Navigation className="mx-auto mb-4 h-9 w-9 text-primary" />
          <h1 className="font-serif text-3xl text-[#16334d]">This guide is unavailable</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">We could not load the trip details right now. Please try again.</p>
          <div className="mt-6 flex justify-center gap-3">
            <Button variant="outline" onClick={() => window.location.reload()} data-testid="button-retry-guide">Retry</Button>
            <Button asChild><Link href="/trips" data-testid="link-guide-back-error">Back to trips</Link></Button>
          </div>
        </div>
      </main>
    );
  }

  const cover = trip.coverImage?.startsWith('/objects/') ? `/api/trips/${tripId}/cover` : trip.coverImage || destinationImage;
  const allHighlights = [
    `${activities.length} planned ${activities.length === 1 ? 'experience' : 'experiences'}`,
    `${stays.length} ${stays.length === 1 ? 'stay' : 'stays'} arranged`,
    `${reservations.length} ${reservations.length === 1 ? 'reservation' : 'reservations'} held`,
  ];

  return (
    <main className="guide-page min-h-screen pb-20">
      <div className="guide-controls mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-5 md:px-10">
        <Link href={`/trips/${tripId}`} className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-primary" data-testid="link-guide-back">
          <ArrowLeft className="h-4 w-4" /> Back to trip
        </Link>
        <Button onClick={() => window.print()} className="rounded-full px-5 shadow-sm" data-testid="button-print-guide">
          <Printer className="h-4 w-4" /> Print / Save as PDF
        </Button>
      </div>

      <article className="guide-paper mx-auto max-w-5xl overflow-hidden md:rounded-[2rem]">
        <section className="guide-cover relative flex min-h-[650px] items-end overflow-hidden bg-[#153b57] px-7 py-10 text-[#f8fbfd] md:min-h-[730px] md:px-16 md:py-16" data-testid="section-guide-cover">
          {cover ? (
            <img src={cover} alt={trip.destination} className="absolute inset-0 h-full w-full object-cover opacity-75" data-testid="img-guide-cover" />
          ) : (
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_65%_20%,#79b6ce_0%,transparent_34%),linear-gradient(145deg,#153b57,#2475b8_58%,#d6a27f)]" />
          )}
          <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(15,45,67,.08),rgba(15,45,67,.88))]" />
          <div className="relative z-10 max-w-3xl">
            <div className="mb-8 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.28em] text-[#cfe9f1]">
              <span className="h-px w-10 bg-[#cfe9f1]" />
              Wander · Personal travel guide
            </div>
            <p className="max-w-2xl font-serif text-2xl italic text-[#cfe9f1] md:text-3xl" data-testid="text-guide-destination">{trip.destination}</p>
            <h1 className="mt-3 max-w-3xl text-5xl font-medium leading-[0.98] tracking-[-0.04em] md:text-8xl" data-testid="text-guide-title">{trip.title}</h1>
            <div className="mt-9 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-white/25 pt-5 text-sm text-white/85">
              <span className="inline-flex items-center gap-2" data-testid="text-guide-dates"><CalendarDays className="h-4 w-4" /> {formatDateRange(trip.startDate, trip.endDate)}</span>
              <span className="inline-flex items-center gap-2"><MapPin className="h-4 w-4" /> {trip.status ? titleCase(trip.status) : 'Planning'}</span>
            </div>
          </div>
        </section>

        <section className="px-7 py-12 md:px-16 md:py-16" data-testid="section-guide-introduction">
          <div className="grid gap-10 md:grid-cols-[1.3fr_.7fr] md:items-start">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-primary">The shape of the journey</p>
              <h2 className="mt-3 max-w-2xl text-4xl font-medium leading-tight tracking-tight text-[#16334d] md:text-5xl">A few days to look forward to.</h2>
              <p className="mt-6 max-w-2xl whitespace-pre-line text-base leading-8 text-muted-foreground" data-testid="text-guide-description">
                {compact(trip.description, `A considered itinerary for ${trip.destination}, gathered in one place for the days that matter.`)}
              </p>
            </div>
            <div className="guide-section-rule pt-5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">At a glance</p>
              <dl className="mt-4 space-y-4">
                <div className="flex items-baseline justify-between gap-4 border-b border-border/70 pb-3">
                  <dt className="text-sm text-muted-foreground">Days</dt>
                  <dd className="font-serif text-2xl text-[#16334d]">{days.length || '—'}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-border/70 pb-3">
                  <dt className="text-sm text-muted-foreground">Stops mapped</dt>
                  <dd className="font-serif text-2xl text-[#16334d]">{allStops.length || '—'}</dd>
                </div>
                <div className="flex items-baseline justify-between gap-4 border-b border-border/70 pb-3">
                  <dt className="text-sm text-muted-foreground">Travel documents</dt>
                  <dd className="font-serif text-2xl text-[#16334d]">{documents.length || '—'}</dd>
                </div>
              </dl>
            </div>
          </div>
          <div className="mt-12 grid gap-3 border-y border-primary/15 py-5 md:grid-cols-3" data-testid="section-guide-highlights">
            {allHighlights.map((highlight, index) => (
              <div className="flex items-center gap-3 text-sm text-[#16334d]" key={highlight}>
                <span className="grid h-7 w-7 place-items-center rounded-full bg-primary/10 text-xs font-bold text-primary">{index + 1}</span>
                {highlight}
              </div>
            ))}
          </div>
        </section>

        <section className="bg-[#edf5f6] px-7 py-12 md:px-16 md:py-16" data-testid="section-guide-itinerary">
          <SectionHeading eyebrow="01 · The days" title="Day by day" detail="Your itinerary, arranged in the order the city will unfold." />
          {days.length === 0 ? (
            <EmptySection title="Your days are still taking shape" body="Add trip dates to see a day-by-day itinerary in this guide." />
          ) : (
            <div className="space-y-5">
              {days.map((day, index) => {
                const key = format(day, 'yyyy-MM-dd');
                const events = eventsByDate.get(key) || [];
                return (
                  <div className="guide-card grid gap-5 rounded-2xl border border-[#c8dce0] bg-[#fbfcfa] p-5 md:grid-cols-[150px_1fr] md:p-7" key={key} data-testid={`card-guide-day-${key}`}>
                    <div className="border-b border-primary/15 pb-4 md:border-b-0 md:border-r md:pb-0">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">Day {String(index + 1).padStart(2, '0')}</p>
                      <p className="mt-2 font-serif text-2xl text-[#16334d]">{format(day, 'EEE')}</p>
                      <p className="mt-1 text-sm text-muted-foreground">{format(day, 'MMMM d')}</p>
                    </div>
                    <div>
                      {events.length === 0 ? (
                        <p className="py-2 text-sm italic leading-6 text-muted-foreground">A day to wander at your own pace.</p>
                      ) : (
                        <div className="space-y-4">
                          {events.map((event, eventIndex) => (
                            <div className="flex gap-4" key={`${event.type}-${event.id || eventIndex}`} data-testid={`event-guide-${event.id || eventIndex}`}>
                              <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                                  <h3 className="font-serif text-xl text-[#16334d]">{event.title}</h3>
                                  {event.time && <span className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">{event.time}</span>}
                                </div>
                                {event.location && <p className="mt-1 text-sm text-muted-foreground">{event.location}</p>}
                                {event.description && <p className="mt-2 text-sm leading-6 text-muted-foreground">{event.description}</p>}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="px-7 py-12 md:px-16 md:py-16" data-testid="section-guide-map">
          <SectionHeading eyebrow="02 · In the city" title="The route" detail="A visual index of the places gathered in your plan." />
          {stopData.length > 0 ? (
            <div className="guide-map-wrap overflow-hidden rounded-2xl border border-[#c8dce0] bg-[#e8f0f4]">
              <GuideMap stops={stopData} />
              <div className="grid gap-0 border-t border-[#c8dce0] bg-[#fbfcfa] md:grid-cols-2">
                {stopData.map((stop) => (
                  <div key={stop.id} className="flex items-center gap-3 border-b border-[#dce7e8] px-4 py-3 text-sm last:border-b-0" data-testid={`text-map-stop-${stop.id}`}>
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-bold text-white">{stop.number}</span>
                    <span className="truncate text-[#16334d]">{stop.name}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptySection title="No mapped stops yet" body="Add locations to stays, activities, reservations, or car rentals to draw the route." />
          )}
          {routeLegs.length > 0 && (
            <div className="mt-7 guide-card rounded-2xl border border-primary/15 bg-primary/[0.035] p-5 md:p-7" data-testid="section-route-legs">
              <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary"><RouteIcon className="h-4 w-4" /> Between stops</div>
              <div className="mt-5 divide-y divide-primary/10">
                {routeLegs.map((leg) => (
                  <div className="grid gap-2 py-4 first:pt-0 last:pb-0 md:grid-cols-[1fr_auto_auto] md:items-center md:gap-6" key={`${leg.from.id}-${leg.to.id}`}>
                    <p className="text-sm text-[#16334d]"><span className="font-medium">{leg.from.number}. {leg.from.name}</span><span className="mx-2 text-primary/45">to</span><span className="font-medium">{leg.to.number}. {leg.to.name}</span></p>
                    <span className="text-sm font-medium text-[#16334d]">{leg.distance}</span>
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Clock3 className="h-3.5 w-3.5" /> {leg.duration}</span>
                  </div>
                ))}
              </div>
              <p className="mt-5 border-t border-primary/10 pt-4 text-xs leading-5 text-muted-foreground">Distances are straight-line estimates from saved coordinates where available. Legs without coordinates use a clearly labeled approximate walking/driving estimate; check route conditions before setting out.</p>
            </div>
          )}
        </section>

        <section className="bg-[#f3eee5] px-7 py-12 md:px-16 md:py-16" data-testid="section-guide-bookings">
          <SectionHeading eyebrow="03 · The essentials" title="Reservations & bookings" detail="The confirmations worth having close at hand." />
          <div className="space-y-5">
            {flights.length > 0 && (
              <div className="guide-card rounded-2xl border border-[#ded4c5] bg-[#fbfcfa] p-5 md:p-7" data-testid="section-guide-flights">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary"><Plane className="h-4 w-4" /> Flights</div>
                <div className="mt-5 grid gap-4 md:grid-cols-2">
                  {flights.map((flight) => (
                    <div className="rounded-xl border border-border/70 p-4" key={flight.id} data-testid={`card-guide-flight-${flight.id}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div><p className="font-serif text-xl text-[#16334d]">{compact(flight.airline)}</p><p className="mt-1 text-xs uppercase tracking-[0.14em] text-primary">{compact(flight.flightNumber)}</p></div>
                        <span className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary">{titleCase(flight.direction || 'flight')}</span>
                      </div>
                      <div className="mt-4 flex items-center gap-3 text-sm text-[#16334d]"><span>{compact(flight.departureAirport)}</span><ArrowUpRight className="h-4 w-4 text-primary" /><span>{compact(flight.arrivalAirport)}</span></div>
                      <p className="mt-3 text-xs leading-5 text-muted-foreground">{formatFlightDateTime(flight.departureDatetime, flight.departureTimezone)} — {formatFlightTime(flight.arrivalDatetime, flight.arrivalTimezone)}</p>
                      {flight.confirmationCode && <p className="mt-3 border-t pt-3 text-xs text-muted-foreground">Confirmation <span className="font-semibold tracking-wider text-[#16334d]">{flight.confirmationCode}</span></p>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {stays.length > 0 && (
              <div className="guide-card rounded-2xl border border-[#ded4c5] bg-[#fbfcfa] p-5 md:p-7" data-testid="section-guide-stays">
                <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary"><Hotel className="h-4 w-4" /> Stays</div>
                <div className="mt-5 grid gap-4 md:grid-cols-2">
                  {stays.map((stay) => (
                    <div className="overflow-hidden rounded-xl border border-border/70" key={stay.id} data-testid={`card-guide-stay-${stay.id}`}>
                      <ImageOrPlaceholder src={stay.imageUrl} query={stay.name || stay.address} alt={stay.name || 'Accommodation'} className="h-36 w-full object-cover" />
                      <div className="p-4"><h3 className="font-serif text-xl text-[#16334d]">{compact(stay.name)}</h3><DetailLine icon={MapPin} testId={`text-guide-stay-address-${stay.id}`}>{compact(stay.address)}</DetailLine><p className="mt-3 text-xs text-muted-foreground">Check in {formatGuideDate(stay.checkIn, 'MMM d')} · Check out {formatGuideDate(stay.checkOut, 'MMM d, yyyy')}</p>{stay.confirmationCode && <p className="mt-2 text-xs text-muted-foreground">Confirmation <span className="font-semibold text-[#16334d]">{stay.confirmationCode}</span></p>}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {(activities.length > 0 || reservations.length > 0 || cars.length > 0) && (
              <div className="grid gap-5 md:grid-cols-2">
                {activities.length > 0 && (
                  <div className="guide-card rounded-2xl border border-[#ded4c5] bg-[#fbfcfa] p-5 md:p-7" data-testid="section-guide-activities">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary"><Navigation className="h-4 w-4" /> Experiences</div>
                    <div className="mt-5 space-y-4">{activities.map((activity) => <div key={activity.id} className="border-b border-border/70 pb-4 last:border-0 last:pb-0" data-testid={`card-guide-activity-${activity.id}`}><ImageOrPlaceholder src={activity.imageUrl} query={activity.location || activity.title} alt={activity.title || 'Planned experience'} className="mb-4 h-24 w-full rounded-lg object-cover" /><div className="flex items-start justify-between gap-3"><h3 className="font-serif text-xl text-[#16334d]">{compact(activity.title)}</h3>{activity.type && <span className="text-[10px] uppercase tracking-wider text-primary">{titleCase(activity.type)}</span>}</div><p className="mt-1 text-xs text-muted-foreground">{formatGuideDate(activity.date, 'EEE, MMM d')}{activity.time ? ` · ${activity.time}` : ''}</p>{activity.location && <DetailLine icon={MapPin}>{activity.location}</DetailLine>}</div>)}</div>
                  </div>
                )}
                {reservations.length > 0 && (
                  <div className="guide-card rounded-2xl border border-[#ded4c5] bg-[#fbfcfa] p-5 md:p-7" data-testid="section-guide-reservations">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary"><Utensils className="h-4 w-4" /> Reservations</div>
                    <div className="mt-5 space-y-4">{reservations.map((reservation) => <div key={reservation.id} className="border-b border-border/70 pb-4 last:border-0 last:pb-0" data-testid={`card-guide-reservation-${reservation.id}`}><ImageOrPlaceholder src={reservation.imageUrl} query={reservation.venue || reservation.title} alt={reservation.title || 'Reservation'} className="mb-4 h-24 w-full rounded-lg object-cover" /><div className="flex items-start justify-between gap-3"><h3 className="font-serif text-xl text-[#16334d]">{compact(reservation.title)}</h3>{reservation.type && <span className="text-[10px] uppercase tracking-wider text-primary">{titleCase(reservation.type)}</span>}</div><p className="mt-1 text-xs text-muted-foreground">{formatGuideDate(reservation.date, 'EEE, MMM d')}{reservation.time ? ` · ${reservation.time}` : ''}</p>{(reservation.venue || reservation.address) && <DetailLine icon={MapPin}>{reservation.venue || reservation.address}</DetailLine>}{reservation.confirmationCode && <p className="mt-2 text-xs text-muted-foreground">Confirmation <span className="font-semibold text-[#16334d]">{reservation.confirmationCode}</span></p>}</div>)}</div>
                  </div>
                )}
                {cars.length > 0 && (
                  <div className="guide-card rounded-2xl border border-[#ded4c5] bg-[#fbfcfa] p-5 md:p-7" data-testid="section-guide-cars">
                    <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary"><Car className="h-4 w-4" /> Car hire</div>
                    <div className="mt-5 space-y-4">{cars.map((car) => <div key={car.id} className="border-b border-border/70 pb-4 last:border-0 last:pb-0" data-testid={`card-guide-car-${car.id}`}><h3 className="font-serif text-xl text-[#16334d]">{compact(car.company)}</h3><p className="mt-1 text-xs uppercase tracking-wider text-primary">{titleCase(car.carType)}</p><DetailLine icon={MapPin}>{compact(car.pickupLocation)}{car.dropoffLocation ? ` → ${car.dropoffLocation}` : ''}</DetailLine><p className="mt-2 text-xs text-muted-foreground">{formatGuideDate(car.pickupDatetime, 'MMM d · h:mm a')} — {formatGuideDate(car.dropoffDatetime, 'MMM d · h:mm a')}</p>{car.confirmationCode && <p className="mt-2 text-xs text-muted-foreground">Confirmation <span className="font-semibold text-[#16334d]">{car.confirmationCode}</span></p>}</div>)}</div>
                  </div>
                )}
              </div>
            )}
            {flights.length === 0 && stays.length === 0 && activities.length === 0 && reservations.length === 0 && cars.length === 0 && <EmptySection title="No bookings have been added" body="Flights, stays, activities, and reservations will appear here as your plans come together." />}
          </div>
        </section>

        {(notes.length > 0 || documents.length > 0) && (
          <section className="px-7 py-12 md:px-16 md:py-16" data-testid="section-guide-private">
            <SectionHeading eyebrow="04 · Keep close" title="Notes & documents" detail="The personal details that make the plan yours." />
            <div className="grid gap-5 md:grid-cols-2">
              {notes.length > 0 && <div className="guide-card rounded-2xl border border-primary/15 bg-primary/[0.035] p-5 md:p-7" data-testid="section-guide-notes"><div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary"><FileText className="h-4 w-4" /> Personal notes</div><div className="mt-5 space-y-5">{notes.map((note) => <div key={note.id} className="border-b border-primary/10 pb-5 last:border-0 last:pb-0" data-testid={`card-guide-note-${note.id}`}><h3 className="font-serif text-xl text-[#16334d]">{compact(note.title, 'Untitled note')}</h3><p className="mt-2 whitespace-pre-line text-sm leading-7 text-muted-foreground">{note.content}</p>{note.authorName && <p className="mt-2 text-xs text-primary">Shared by {note.authorName}</p>}</div>)}</div></div>}
              {documents.length > 0 && <div className="guide-card rounded-2xl border border-primary/15 bg-primary/[0.035] p-5 md:p-7" data-testid="section-guide-documents"><div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary"><Paperclip className="h-4 w-4" /> Travel documents</div><div className="mt-5 space-y-4">{documents.map((document) => <div key={document.id} className="flex gap-3 border-b border-primary/10 pb-4 last:border-0 last:pb-0" data-testid={`card-guide-document-${document.id}`}><ReceiptText className="mt-1 h-4 w-4 shrink-0 text-primary" /><div><h3 className="font-serif text-xl text-[#16334d]">{titleCase(document.type)}</h3><p className="mt-1 text-sm text-muted-foreground">Document ending in {String(document.number || '').slice(-4) || '—'}</p>{document.expiryDate && <p className="mt-2 text-xs text-muted-foreground">Expires {formatGuideDate(document.expiryDate, 'MMMM d, yyyy')}</p>}{document.notes && <p className="mt-2 text-sm leading-6 text-muted-foreground">{document.notes}</p>}</div></div>)}</div></div>}
            </div>
          </section>
        )}

        <footer className="flex flex-col gap-3 border-t border-primary/15 bg-[#153b57] px-7 py-9 text-[#d9edf1] md:flex-row md:items-center md:justify-between md:px-16">
          <div><p className="font-serif text-2xl text-[#f8fbfd]">Wander well.</p><p className="mt-1 text-sm text-[#b5d4dc]">A personal guide for {trip.destination}.</p></div>
          <p className="text-xs uppercase tracking-[0.18em] text-[#8fb9c5]">Prepared with Wander</p>
        </footer>
      </article>
    </main>
  );
}