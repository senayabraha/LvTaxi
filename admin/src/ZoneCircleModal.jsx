import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { updateZoneFields } from './lib/zoneStore.js';
import { useToast } from './useToast.jsx';

export default function ZoneCircleModal({ zone, onClose, onSaved }) {
  const toast = useToast();
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);
  const circleRef = useRef(null);

  const [editLat, setEditLat] = useState(zone.lat);
  const [editLng, setEditLng] = useState(zone.lng);
  const [editRadius, setEditRadius] = useState(zone.radius_meters);
  const [radiusRaw, setRadiusRaw] = useState(String(zone.radius_meters));
  const [busy, setBusy] = useState(false);

  // Build the map once on mount
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [zone.lat, zone.lng],
      zoom: 16,
      zoomControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 20,
    }).addTo(map);

    // Polygon overlay for reference (non-interactive, dashed)
    const polygon =
      zone.use_driven_polygon && zone.driven_polygon
        ? zone.driven_polygon
        : zone.drawn_polygon;
    if (polygon) {
      const isPhaseB = zone.use_driven_polygon && zone.driven_polygon;
      L.geoJSON(polygon, {
        style: {
          color: isPhaseB ? '#16A34A' : '#EAB308',
          fillColor: isPhaseB ? '#16A34A' : '#EAB308',
          fillOpacity: 0.12,
          weight: 1.5,
          dashArray: '5 4',
        },
        interactive: false,
      }).addTo(map);
    }

    // Editable blue circle
    const circle = L.circle([zone.lat, zone.lng], {
      radius: zone.radius_meters,
      color: '#3B82F6',
      fillColor: '#3B82F6',
      fillOpacity: 0.1,
      weight: 2,
    }).addTo(map);
    circleRef.current = circle;

    // Draggable center marker
    const marker = L.marker([zone.lat, zone.lng], {
      draggable: true,
      title: 'Drag to move the zone center',
    }).addTo(map);
    markerRef.current = marker;

    // Circle follows marker during drag (live feedback)
    marker.on('drag', (e) => {
      circle.setLatLng(e.target.getLatLng());
    });

    // Commit position to state on drag end
    marker.on('dragend', (e) => {
      const ll = e.target.getLatLng();
      setEditLat(+ll.lat.toFixed(6));
      setEditLng(+ll.lng.toFixed(6));
    });

    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Update circle radius live when the input changes
  useEffect(() => {
    if (circleRef.current && editRadius >= 10) {
      circleRef.current.setRadius(editRadius);
    }
  }, [editRadius]);

  const changed =
    editLat !== zone.lat ||
    editLng !== zone.lng ||
    editRadius !== zone.radius_meters;

  async function handleSave() {
    setBusy(true);
    try {
      await updateZoneFields(zone, {
        lat: editLat,
        lng: editLng,
        radius_meters: editRadius,
      });
      toast(`"${zone.name}" circle updated`, 'success');
      onSaved?.();
      onClose();
    } catch (err) {
      toast(err.message ?? 'Save failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="bg-panel border border-border rounded-lg w-full max-w-2xl flex flex-col"
        style={{ height: '80vh' }}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <div>
            <div className="text-text font-semibold">{zone.name} — Edit Circle</div>
            <div className="text-muted text-xs mt-0.5">
              Drag the marker to move the center · adjust radius below
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

        {/* Map fills remaining height */}
        <div ref={containerRef} className="flex-1 min-h-0" />

        <footer className="border-t border-border px-5 py-3 shrink-0 space-y-3">
          <div className="flex items-center gap-6 flex-wrap">
            <div className="flex items-center gap-2 text-sm">
              <label className="text-muted">Radius</label>
              <input
                type="number"
                min={10}
                max={5000}
                value={radiusRaw}
                onChange={(e) => {
                  setRadiusRaw(e.target.value);
                  const n = parseInt(e.target.value);
                  if (!isNaN(n) && n >= 10) setEditRadius(n);
                }}
                onBlur={() => {
                  const n = parseInt(radiusRaw);
                  if (isNaN(n) || n < 10) setRadiusRaw(String(editRadius));
                }}
                className="bg-panel2 border border-border rounded h-8 w-24 px-2 text-text text-sm text-center"
              />
              <span className="text-muted text-xs">meters</span>
            </div>
            <div className="text-muted text-xs tabular-nums">
              Center: {editLat.toFixed(5)}, {editLng.toFixed(5)}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="flex-1 h-9 rounded text-sm bg-panel2 border border-border text-muted hover:text-text"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={busy || !changed}
              className="flex-1 h-9 rounded text-sm font-semibold bg-accent text-bg disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
