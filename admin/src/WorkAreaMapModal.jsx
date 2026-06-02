import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import * as turf from '@turf/turf';

const LV_CENTER = [36.1147, -115.1728];

export default function WorkAreaMapModal({ workArea, onClose }) {
  const containerRef = useRef(null);

  useEffect(() => {
    if (!containerRef.current) return;

    let center = LV_CENTER;
    try {
      const c = turf.centroid(workArea.polygon);
      const [lng, lat] = c.geometry.coordinates;
      center = [lat, lng];
    } catch {
      // fall back to Las Vegas center
    }

    const map = L.map(containerRef.current, {
      center,
      zoom: 11,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 20,
    }).addTo(map);

    const layer = L.geoJSON(workArea.polygon, {
      style: {
        color: '#EAB308',
        fillColor: '#EAB308',
        fillOpacity: 0.12,
        weight: 2.5,
      },
    }).addTo(map);

    try {
      map.fitBounds(layer.getBounds(), { padding: [32, 32] });
    } catch {
      map.setView(center, 11);
    }

    return () => {
      map.remove();
    };
  }, [workArea]);

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-panel border border-border rounded-lg w-full max-w-3xl flex flex-col"
        style={{ height: '78vh' }}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div>
            <div className="text-text font-semibold">{workArea.name}</div>
            <div className="text-muted text-xs mt-0.5">Work Area Boundary</div>
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
