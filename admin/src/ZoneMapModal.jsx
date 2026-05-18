import React, { useEffect, useRef } from 'react';
import L from 'leaflet';

export default function ZoneMapModal({ zone, onClose }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const center = [zone.lat, zone.lng];
    const map = L.map(containerRef.current, {
      center,
      zoom: 16,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 20,
    }).addTo(map);

    L.circle(center, {
      radius: zone.radius_meters,
      color: '#6B7280',
      fillColor: '#6B7280',
      fillOpacity: 0.08,
      weight: 1,
      dashArray: '5 5',
    }).addTo(map);

    const polygon =
      zone.use_driven_polygon && zone.driven_polygon
        ? zone.driven_polygon
        : zone.drawn_polygon;

    if (polygon) {
      const isPhaseB = zone.use_driven_polygon && zone.driven_polygon;
      const layer = L.geoJSON(polygon, {
        style: {
          color: isPhaseB ? '#16A34A' : '#EAB308',
          fillColor: isPhaseB ? '#16A34A' : '#EAB308',
          fillOpacity: 0.2,
          weight: 2,
        },
      }).addTo(map);
      try {
        map.fitBounds(layer.getBounds(), { padding: [40, 40] });
      } catch {
        map.setView(center, 16);
      }
    }

    return () => {
      map.remove();
    };
  }, [zone]);

  const phaseLabel =
    zone.use_driven_polygon && zone.driven_polygon
      ? '🟢 Phase B (Driven)'
      : zone.drawn_polygon
      ? '🟡 Phase A (Drawn)'
      : '⚪ Circle only';

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
            <div className="text-text font-semibold">{zone.name}</div>
            <div className="text-muted text-xs mt-0.5">
              {phaseLabel} · radius {zone.radius_meters}m
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
