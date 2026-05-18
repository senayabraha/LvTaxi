import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';

const LV_CENTER = [36.1147, -115.1728];
const ZOOM = 14;

const STREET = L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 20,
  }
);
const SATELLITE = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  {
    attribution: 'Tiles © Esri',
    maxZoom: 19,
  }
);

// Hook: create a Leaflet map exactly once and return its ref.
export function useLeafletMap(containerRef, opts = {}) {
  const mapRef = useRef(null);
  const [layer, setLayer] = useState('street');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, {
      center: opts.center ?? LV_CENTER,
      zoom: opts.zoom ?? ZOOM,
      zoomControl: false,
    });
    L.control.zoom({ position: 'topright' }).addTo(map);
    STREET.addTo(map);
    mapRef.current = map;
    setReady(true);
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleLayer() {
    const m = mapRef.current;
    if (!m) return;
    if (layer === 'street') {
      m.removeLayer(STREET);
      SATELLITE.addTo(m);
      setLayer('satellite');
    } else {
      m.removeLayer(SATELLITE);
      STREET.addTo(m);
      setLayer('street');
    }
  }

  function findMe() {
    if (!mapRef.current || !navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        mapRef.current.setView(
          [pos.coords.latitude, pos.coords.longitude],
          17
        );
      },
      (err) => console.warn('[MapView] findMe', err.message),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 5_000 }
    );
  }

  return { mapRef, ready, layer, toggleLayer, findMe };
}

export default function MapView({ children, controls = true }) {
  const containerRef = useRef(null);
  const { mapRef, ready, layer, toggleLayer, findMe } =
    useLeafletMap(containerRef);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="absolute inset-0" />
      {controls ? (
        <>
          <button
            onClick={toggleLayer}
            className="absolute right-3 top-3 z-[1000] bg-white text-gray-800 text-xs font-semibold px-3 h-8 rounded-full shadow"
          >
            {layer === 'street' ? '🛰 Satellite' : '🗺 Street'}
          </button>
          <button
            onClick={findMe}
            className="absolute right-3 top-14 z-[1000] bg-white text-gray-800 w-8 h-8 rounded-full shadow flex items-center justify-center"
            title="Center on me"
          >
            🎯
          </button>
        </>
      ) : null}
      {ready && typeof children === 'function' ? children(mapRef.current) : null}
    </div>
  );
}
