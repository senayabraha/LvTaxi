import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import * as turf from '@turf/turf';

function vertexIcon() {
  return L.divIcon({
    className: '',
    html: '<div style="width:14px;height:14px;background:#2563eb;border:2.5px solid #fff;border-radius:50%;box-shadow:0 1px 5px rgba(0,0,0,0.4);cursor:grab"></div>',
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

const MODE = { OPEN: 'open', CLOSED: 'closed' };

export default function DrawMode({ map, onPolygonReady }) {
  const [points, setPoints] = useState([]);
  const [mode, setMode] = useState(MODE.OPEN);
  const [bufferM, setBufferM] = useState(4);
  const [error, setError] = useState(null);

  const markersRef = useRef([]);
  const polylineRef = useRef(null);
  const fenceLayerRef = useRef(null);

  function clearVisuals() {
    markersRef.current.forEach((m) => map?.removeLayer(m));
    markersRef.current = [];
    if (polylineRef.current) {
      map?.removeLayer(polylineRef.current);
      polylineRef.current = null;
    }
    if (fenceLayerRef.current) {
      map?.removeLayer(fenceLayerRef.current);
      fenceLayerRef.current = null;
    }
  }

  function redrawPolyline(pts, m) {
    if (polylineRef.current) map?.removeLayer(polylineRef.current);
    if (pts.length < 2 || !map) return;
    const latlngs = pts.map((p) => [p.lat, p.lng]);
    if (m === MODE.CLOSED && pts.length >= 3) latlngs.push(latlngs[0]);
    polylineRef.current = L.polyline(latlngs, {
      color: '#2563eb',
      weight: 3,
      opacity: 0.8,
    }).addTo(map);
  }

  function rebuildFence(pts, m, radius) {
    if (!map) return;
    if (fenceLayerRef.current) {
      map.removeLayer(fenceLayerRef.current);
      fenceLayerRef.current = null;
    }
    if (pts.length < 2) {
      onPolygonReady?.(null);
      return;
    }
    let feature;
    try {
      const coords = pts.map((p) => [p.lng, p.lat]);
      if (m === MODE.CLOSED) {
        if (pts.length < 3) {
          onPolygonReady?.(null);
          return;
        }
        feature = turf.polygon([[...coords, coords[0]]]);
      } else {
        feature = turf.buffer(turf.lineString(coords), radius, {
          units: 'meters',
          steps: 8,
        });
      }
    } catch (e) {
      setError('Buffer failed: ' + e.message);
      return;
    }
    if (!feature) return;
    fenceLayerRef.current = L.geoJSON(feature, {
      style: {
        color: '#ea580c',
        weight: 3,
        opacity: 0.9,
        fillColor: '#ea580c',
        fillOpacity: 0.1,
      },
    }).addTo(map);
    onPolygonReady?.(feature);
  }

  function addVertex(lat, lng) {
    setPoints((arr) => {
      const id = arr.length + 1;
      const next = [...arr, { id, lat, lng }];
      const mk = L.marker([lat, lng], {
        icon: vertexIcon(),
        draggable: true,
      }).addTo(map);
      mk.on('drag', (e) => {
        const ll = e.target.getLatLng();
        setPoints((cur) => {
          const updated = cur.map((p) =>
            p.id === id ? { ...p, lat: ll.lat, lng: ll.lng } : p
          );
          redrawPolyline(updated, mode);
          rebuildFence(updated, mode, bufferM);
          return updated;
        });
      });
      mk.on('contextmenu', () => {
        // right-click / long-press to delete
        setPoints((cur) => {
          const remaining = cur.filter((p) => p.id !== id);
          map.removeLayer(mk);
          markersRef.current = markersRef.current.filter((x) => x !== mk);
          redrawPolyline(remaining, mode);
          rebuildFence(remaining, mode, bufferM);
          return remaining;
        });
      });
      markersRef.current.push(mk);
      redrawPolyline(next, mode);
      rebuildFence(next, mode, bufferM);
      return next;
    });
  }

  // Wire map click handler. Re-wire if mode/buffer change so closures are fresh.
  useEffect(() => {
    if (!map) return;
    function handler(e) {
      addVertex(e.latlng.lat, e.latlng.lng);
    }
    map.on('click', handler);
    return () => map.off('click', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, mode, bufferM]);

  useEffect(() => {
    rebuildFence(points, mode, bufferM);
    redrawPolyline(points, mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, bufferM]);

  function clearAll() {
    clearVisuals();
    setPoints([]);
    onPolygonReady?.(null);
    setError(null);
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => clearVisuals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-3">
      <div className="text-xs text-muted">
        Tap the map to add vertices. Drag to move. Right-click to delete.
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => setMode(MODE.OPEN)}
          className={`flex-1 h-9 rounded text-sm font-medium ${
            mode === MODE.OPEN
              ? 'bg-accent text-bg'
              : 'bg-panel border border-border text-muted'
          }`}
        >
          Path (buffer)
        </button>
        <button
          onClick={() => setMode(MODE.CLOSED)}
          className={`flex-1 h-9 rounded text-sm font-medium ${
            mode === MODE.CLOSED
              ? 'bg-accent text-bg'
              : 'bg-panel border border-border text-muted'
          }`}
        >
          Polygon (closed)
        </button>
      </div>

      {mode === MODE.OPEN ? (
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted">Buffer</label>
          <input
            type="number"
            min={1}
            max={50}
            step={0.5}
            value={bufferM}
            onChange={(e) => setBufferM(parseFloat(e.target.value) || 4)}
            className="w-20 bg-panel2 border border-border rounded px-2 h-8 text-text"
          />
          <span className="text-muted">m</span>
        </div>
      ) : null}

      <div className="text-xs text-muted">📍 Vertices: {points.length}</div>

      <button
        onClick={clearAll}
        disabled={points.length === 0}
        className="w-full bg-panel border border-border text-muted h-9 rounded text-sm disabled:opacity-50"
      >
        Clear
      </button>

      {error ? <div className="text-bad text-xs">{error}</div> : null}
    </div>
  );
}
