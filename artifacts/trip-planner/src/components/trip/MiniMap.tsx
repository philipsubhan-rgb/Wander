import { useEffect, useRef, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import 'leaflet/dist/leaflet.css';

// Mounts a Leaflet map into the given ref imperatively.
function LeafletMap({
  lat,
  lon,
  zoom,
  interactive,
  className,
}: {
  lat: number;
  lon: number;
  zoom: number;
  interactive: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const el = ref.current;
    let map: import('leaflet').Map | undefined;
    let destroyed = false;

    import('leaflet').then(L => {
      if (destroyed || !el) return;

      map = L.map(el, {
        zoomControl: interactive,
        dragging: interactive,
        scrollWheelZoom: interactive,
        doubleClickZoom: interactive,
        touchZoom: interactive,
        attributionControl: false,
        keyboard: false,
      }).setView([lat, lon], zoom);

      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
      }).addTo(map);

      L.circleMarker([lat, lon], {
        radius: 9,
        color: '#fff',
        weight: 2.5,
        fillColor: '#3b82f6',
        fillOpacity: 1,
      }).addTo(map);

      // Leaflet sometimes needs a size hint after mount inside hidden/animated containers
      setTimeout(() => map?.invalidateSize(), 100);
    });

    return () => {
      destroyed = true;
      map?.remove();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lat, lon]);

  return <div ref={ref} className={className} />;
}

// Expanded map rendered inside a Dialog — separate component so it mounts
// only after the Dialog DOM is ready.
function ExpandedMap({ lat, lon, label }: { lat: number; lon: number; label?: string }) {
  return (
    <div className="relative h-[520px] w-full">
      <LeafletMap lat={lat} lon={lon} zoom={15} interactive className="h-full w-full" />
      {label && (
        <div className="absolute bottom-3 left-3 z-[1000] bg-white/95 backdrop-blur-sm rounded-lg px-3 py-1.5 text-sm font-medium shadow-md max-w-[75%] truncate">
          {label}
        </div>
      )}
    </div>
  );
}

interface MiniMapProps {
  lat: number;
  lon: number;
  label?: string;
}

export function MiniMap({ lat, lon, label }: MiniMapProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <div className="relative">
        <LeafletMap
          lat={lat}
          lon={lon}
          zoom={14}
          interactive={false}
          className="h-36 w-full rounded-b-xl overflow-hidden"
        />
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="absolute top-2 right-2 z-[1000] bg-white/90 backdrop-blur-sm rounded-md p-1.5 shadow hover:bg-white transition-colors"
          title="Expand map"
        >
          <Maximize2 className="h-3.5 w-3.5 text-foreground" />
        </button>
        {label && (
          <div className="absolute bottom-2 left-2 z-[1000] bg-white/90 backdrop-blur-sm rounded-md px-2 py-1 text-xs font-medium shadow max-w-[70%] truncate">
            {label}
          </div>
        )}
      </div>

      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent className="max-w-2xl p-0 overflow-hidden rounded-xl">
          {/* Only render when open so the map mounts into a visible DOM node */}
          {expanded && <ExpandedMap lat={lat} lon={lon} label={label} />}
        </DialogContent>
      </Dialog>
    </>
  );
}
