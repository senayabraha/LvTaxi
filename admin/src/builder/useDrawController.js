import { useCallback, useEffect, useRef, useState } from 'react';
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

export const DRAW_MODE = { OPEN: 'open', CLOSED: 'closed' };

export function useDrawController({ map, onFeature }) {
  const [points, setPoints] = useState([]);
  const [mode, setMode] = useState(DRAW_MODE.OPEN);
  const [bufferM, setBufferM] = useState(4);
  const [error, setError] = useState(null);

  const markersRef = useRef([]);
  const polylineRef = useRef(null);
  const fenceLayerRef = useRef(null);
  const pointsRef = useRef([]);
  const modeRef = useRef(DRAW_MODE.OPEN);
  const bufferRef = useRef(4);

  pointsRef.current = points;
  modeRef.current = mode;
  bufferRef.current = bufferM;

  const clearVisuals = useCallback(() => {
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
  }, [map]);

  const redrawPolyline = useCallback(
    (pts, m) => {
      if (polylineRef.current) map?.removeLayer(polylineRef.current);
      if (pts.length < 2 || !map) return;
      const latlngs = pts.map((p) => [p.lat, p.lng]);
      if (m === DRAW_MODE.CLOSED && pts.length >= 3) latlngs.push(latlngs[0]);
      polylineRef.current = L.polyline(latlngs, {
        color: '#2563eb',
        weight: 3,
        opacity: 0.8,
      }).addTo(map);
    },
    [map]
  );

  const rebuildFence = useCallback(
    (pts, m, radius) => {
      if (!map) return;
      if (fenceLayerRef.current) {
        map.removeLayer(fenceLayerRef.current);
        fenceLayerRef.current = null;
      }
      if (pts.length < 2) {
        onFeature?.(null);
        return;
      }
      let feature;
      try {
        const coords = pts.map((p) => [p.lng, p.lat]);
        if (m === DRAW_MODE.CLOSED) {
          if (pts.length < 3) {
            onFeature?.(null);
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
      onFeature?.(feature);
    },
    [map, onFeature]
  );

  const addVertex = useCallback(
    (lat, lng) => {
      if (!map) return;
      setPoints((arr) => {
        const id = arr.length === 0 ? 1 : Math.max(...arr.map((p) => p.id)) + 1;
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
            redrawPolyline(updated, modeRef.current);
            rebuildFence(updated, modeRef.current, bufferRef.current);
            return updated;
          });
        });
        mk.on('contextmenu', () => {
          setPoints((cur) => {
            const remaining = cur.filter((p) => p.id !== id);
            map.removeLayer(mk);
            markersRef.current = markersRef.current.filter((x) => x !== mk);
            redrawPolyline(remaining, modeRef.current);
            rebuildFence(remaining, modeRef.current, bufferRef.current);
            return remaining;
          });
        });
        markersRef.current.push(mk);
        redrawPolyline(next, modeRef.current);
        rebuildFence(next, modeRef.current, bufferRef.current);
        return next;
      });
    },
    [map, redrawPolyline, rebuildFence]
  );

  const deletePointByIndex = useCallback(
    (idx) => {
      setPoints((arr) => {
        const next = arr.filter((_, i) => i !== idx);
        const mk = markersRef.current[idx];
        if (mk) map?.removeLayer(mk);
        markersRef.current.splice(idx, 1);
        redrawPolyline(next, modeRef.current);
        rebuildFence(next, modeRef.current, bufferRef.current);
        return next;
      });
    },
    [map, redrawPolyline, rebuildFence]
  );

  const clearAll = useCallback(() => {
    clearVisuals();
    setPoints([]);
    onFeature?.(null);
    setError(null);
  }, [clearVisuals, onFeature]);

  // Map click handler.
  useEffect(() => {
    if (!map) return;
    function handler(e) {
      addVertex(e.latlng.lat, e.latlng.lng);
    }
    map.on('click', handler);
    return () => map.off('click', handler);
  }, [map, addVertex]);

  // Mode/buffer change → rebuild visuals from current points.
  useEffect(() => {
    redrawPolyline(pointsRef.current, mode);
    rebuildFence(pointsRef.current, mode, bufferM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, bufferM]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => clearVisuals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    points,
    mode,
    bufferM,
    error,
    setMode,
    setBufferM,
    clearAll,
    deletePointByIndex,
  };
}
