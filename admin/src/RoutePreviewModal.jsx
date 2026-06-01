import React, { useEffect, useRef } from 'react';
import L from 'leaflet';

const ROUTE_COLORS = {
  staging: '#22c55e',
  drop_off: '#ef4444',
  loop_then_stage: '#f59e0b',
};

// Previews a saved training route's drawn path on a Leaflet map.
// path_coords is stored as [[lng, lat], ...]; Leaflet wants [lat, lng].
export default function RoutePreviewModal({ route, zoneName, onClose }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const coords = Array.isArray(route.path_coords) ? route.path_coords : [];
    const latlngs = coords
      .filter((c) => Array.isArray(c) && c.length >= 2)
      .map((c) => [c[1], c[0]]);

    const center = latlngs[0] ?? [36.1147, -115.1728];
    const map = L.map(containerRef.current, { center, zoom: 16, zoomControl: true });

    L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles © Esri', maxZoom: 19 }
    ).addTo(map);

    const color = ROUTE_COLORS[route.route_type] ?? '#F5C518';
    if (latlngs.length >= 2) {
      const line = L.polyline(latlngs, { color, weight: 4, opacity: 0.9 }).addTo(map);
      // Start (green-ish) and end (route color) markers.
      L.circleMarker(latlngs[0], { radius: 6, color: '#22c55e', fillOpacity: 1 }).addTo(map);
      L.circleMarker(latlngs[latlngs.length - 1], { radius: 6, color, fillOpacity: 1 }).addTo(map);
      try {
        map.fitBounds(line.getBounds(), { padding: [40, 40] });
      } catch {
        map.setView(center, 16);
      }
    } else if (latlngs.length === 1) {
      L.circleMarker(latlngs[0], { radius: 6, color, fillOpacity: 1 }).addTo(map);
    }

    return () => map.remove();
  }, [route]);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-panel border border-border rounded-lg w-full max-w-2xl flex flex-col"
        style={{ height: '72vh' }}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div>
            <div className="text-text font-semibold">{zoneName ?? 'Route'}</div>
            <div className="text-muted text-xs mt-0.5">
              {route.route_type} · {route.source} ·{' '}
              {Array.isArray(route.path_coords) ? route.path_coords.length : 0} points
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text text-lg leading-none"
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div ref={containerRef} className="flex-1 min-h-0 rounded-b-lg overflow-hidden" />
      </div>
    </div>
  );
}
