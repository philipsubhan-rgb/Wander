import { useEffect, useRef } from 'react';
import 'leaflet/dist/leaflet.css';

export interface GuideMapStop {
  id: string;
  number: number;
  name: string;
  lat: number;
  lon: number;
}

export function GuideMap({ stops }: { stops: GuideMapStop[] }) {
  const mapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = mapRef.current;
    if (!element || stops.length === 0) return;

    let map: import('leaflet').Map | undefined;
    let cancelled = false;

    import('leaflet').then((L) => {
      if (cancelled || !element) return;

      map = L.map(element, {
        zoomControl: false,
        attributionControl: true,
        scrollWheelZoom: false,
        dragging: false,
        doubleClickZoom: false,
        touchZoom: false,
        keyboard: false,
      });

      L.control.zoom({ position: 'bottomright' }).addTo(map);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);

      const points = stops.map((stop) => [stop.lat, stop.lon] as [number, number]);
      const bounds = L.latLngBounds(points);

      stops.forEach((stop) => {
        const marker = L.divIcon({
          className: 'wander-guide-marker',
          html: `<span>${stop.number}</span>`,
          iconSize: [30, 30],
          iconAnchor: [15, 15],
        });
        L.marker([stop.lat, stop.lon], { icon: marker })
          .bindTooltip(stop.name, { direction: 'top', offset: [0, -14] })
          .addTo(map!);
      });

      if (points.length > 1) {
        L.polyline(points, {
          color: '#2475b8',
          weight: 3,
          opacity: 0.82,
          dashArray: '7 8',
        }).addTo(map);
      }

      map.fitBounds(bounds, { padding: [34, 34], maxZoom: 14 });
      window.setTimeout(() => map?.invalidateSize(), 100);
    });

    return () => {
      cancelled = true;
      map?.remove();
    };
  }, [stops]);

  return <div ref={mapRef} className="wander-guide-map h-[360px] w-full bg-[#e8f0f4]" aria-label="Trip route map" />;
}