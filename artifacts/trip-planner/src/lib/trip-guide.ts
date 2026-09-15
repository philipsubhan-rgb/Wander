export type GuideRecord = Record<string, any>;

export interface GuideRouteStop {
  id: string;
  number: number;
  name: string;
  lat?: number;
  lon?: number;
}

export interface GuideRouteLeg {
  from: GuideRouteStop;
  to: GuideRouteStop;
  distance: string;
  duration: string;
  approximate: boolean;
}

function compact(value?: string | null, fallback = 'Trip stop') {
  return value?.trim() || fallback;
}

export function hasCoordinates(record: GuideRecord) {
  return record.lat !== null && record.lat !== undefined
    && record.lon !== null && record.lon !== undefined
    && Number.isFinite(Number(record.lat)) && Number.isFinite(Number(record.lon));
}

function haversineKm(a: GuideRouteStop, b: GuideRouteStop) {
  const earthRadius = 6371;
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(b.lat! - a.lat!);
  const longitudeDelta = radians(b.lon! - a.lon!);
  const halfChord = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(radians(a.lat!)) * Math.cos(radians(b.lat!)) * Math.sin(longitudeDelta / 2) ** 2;
  return earthRadius * 2 * Math.atan2(Math.sqrt(halfChord), Math.sqrt(1 - halfChord));
}

function durationForLeg(km: number) {
  const walkingMinutes = Math.max(4, Math.round(km / 4.8 * 60));
  const drivingMinutes = Math.max(4, Math.round(km / 25 * 60));
  return `${walkingMinutes} min walk · ${drivingMinutes} min drive`;
}

export function buildGuideStops({
  stays,
  activities,
  reservations,
  cars,
}: {
  stays: GuideRecord[];
  activities: GuideRecord[];
  reservations: GuideRecord[];
  cars: GuideRecord[];
}): GuideRouteStop[] {
  const raw: GuideRecord[] = [
    ...stays.map((item) => ({ ...item, kind: 'stay', label: item.name })),
    ...activities.map((item) => ({ ...item, kind: 'activity', label: item.title })),
    ...reservations.map((item) => ({ ...item, kind: 'reservation', label: item.title })),
    ...cars.map((item) => ({ ...item, kind: 'car', label: item.company })),
  ];

  return raw
    .sort((a, b) => String(a.date || a.checkIn || a.pickupDatetime || '').localeCompare(String(b.date || b.checkIn || b.pickupDatetime || '')))
    .map((item, index) => ({
      id: `${item.kind}-${item.id}`,
      number: index + 1,
      name: compact(item.label),
      ...(hasCoordinates(item)
        ? { lat: Number(item.lat), lon: Number(item.lon) }
        : {}),
    }));
}

export function buildRouteLegs(stops: GuideRouteStop[]): GuideRouteLeg[] {
  return stops.slice(1).map((to, index) => {
    const from = stops[index];
    const coordinatesAvailable = hasCoordinates(from) && hasCoordinates(to);
    const distanceKm = coordinatesAvailable
      ? haversineKm(from, to)
      : 0.8;

    return {
      from,
      to,
      distance: distanceKm < 1 ? `${Math.round(distanceKm * 1000)} m` : `${distanceKm.toFixed(1)} km`,
      duration: coordinatesAvailable ? durationForLeg(distanceKm) : 'Approx. 12 min walk · 5 min drive',
      approximate: !coordinatesAvailable,
    };
  });
}