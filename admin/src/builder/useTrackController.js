import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import * as turf from '@turf/turf';
import { startWatch, getOnePosition } from './gpsHooks.js';

function makePointIcon(type) {
  const color = type === 'manual' ? '#16a34a' : '#2563eb';
  return L.divIcon({
    className: '',
    html: `<div style="width:12px;height:12px;background:${color};border:2.5px solid #fff;border-radius:50%;box-shadow:0 1px 5px rgba(0,0,0,0.4)"></div>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  });
}

export const TRACK_PHASE = {
  IDLE: 'idle',
  TRACKING: 'tracking',
  READY: 'ready',
};

// Track-mode controller. Hook owns all Leaflet side-effects so the UI is
// rendered freely elsewhere (BottomToolbar).
export function useTrackController({ map, onFeature }) {
  const [phase, setPhase] = useState(TRACK_PHASE.IDLE);
  const [points, setPoints] = useState([]);
  const [bufferM, setBufferM] = useState(4);
  const [autoSec, setAutoSec] = useState(60);
  const [elapsed, setElapsed] = useState(0);
  const [accuracy, setAccuracy] = useState(null);
  const [error, setError] = useState(null);

  const markersRef = useRef([]);
  const polylineRef = useRef(null);
  const fenceLayerRef = useRef(null);
  const watcherRef = useRef(null);
  const captureTimerRef = useRef(null);
  const elapsedTimerRef = useRef(null);
  const startTsRef = useRef(null);
  const pointsRef = useRef([]);
  const bufferRef = useRef(4);

  pointsRef.current = points;
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
    (pts) => {
      if (!map) return;
      if (polylineRef.current) {
        map.removeLayer(polylineRef.current);
        polylineRef.current = null;
      }
      if (pts.length < 2) return;
      polylineRef.current = L.polyline(
        pts.map((p) => [p.lat, p.lng]),
        { color: '#2563eb', weight: 3, opacity: 0.8 }
      ).addTo(map);
    },
    [map]
  );

  const buildFence = useCallback(
    (pts, radius) => {
      if (!map || pts.length < 2) {
        onFeature?.(null);
        return;
      }
      let buf;
      try {
        const line = turf.lineString(pts.map((p) => [p.lng, p.lat]));
        buf = turf.buffer(line, radius, { units: 'meters', steps: 8 });
      } catch (e) {
        setError('Buffer failed: ' + e.message);
        return;
      }
      if (!buf) return;
      if (fenceLayerRef.current) map.removeLayer(fenceLayerRef.current);
      fenceLayerRef.current = L.geoJSON(buf, {
        style: {
          color: '#ea580c',
          weight: 3,
          opacity: 0.9,
          fillColor: '#ea580c',
          fillOpacity: 0.1,
        },
      }).addTo(map);
      onFeature?.(buf);
    },
    [map, onFeature]
  );

  const addPoint = useCallback(
    (pt) => {
      if (!map) return;
      setAccuracy(pt.accuracy);
      const mk = L.marker([pt.lat, pt.lng], {
        icon: makePointIcon(pt.type),
      }).addTo(map);
      markersRef.current.push(mk);
      setPoints((arr) => {
        const next = [...arr, pt];
        redrawPolyline(next);
        return next;
      });
    },
    [map, redrawPolyline]
  );

  const captureNow = useCallback(
    async (type) => {
      try {
        const pos = await getOnePosition();
        addPoint({ ...pos, type });
      } catch (err) {
        setError(err.message);
      }
    },
    [addPoint]
  );

  const start = useCallback(() => {
    clearVisuals();
    setPoints([]);
    setError(null);
    setElapsed(0);
    setPhase(TRACK_PHASE.TRACKING);
    startTsRef.current = Date.now();
    elapsedTimerRef.current = setInterval(
      () => setElapsed(Date.now() - startTsRef.current),
      1000
    );
    captureNow('auto');
    captureTimerRef.current = setInterval(
      () => captureNow('auto'),
      autoSec * 1000
    );
    watcherRef.current = startWatch({
      onPoint: (pt) => setAccuracy(pt.accuracy),
      onError: (err) => setError(err.message),
    });
  }, [autoSec, captureNow, clearVisuals]);

  const stop = useCallback(() => {
    if (captureTimerRef.current) clearInterval(captureTimerRef.current);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    if (watcherRef.current) watcherRef.current.stop();
    captureTimerRef.current = null;
    elapsedTimerRef.current = null;
    watcherRef.current = null;
    const pts = pointsRef.current;
    if (pts.length < 2) {
      setError('Need at least 2 points');
      setPhase(TRACK_PHASE.IDLE);
      return;
    }
    setPhase(TRACK_PHASE.READY);
    buildFence(pts, bufferRef.current);
  }, [buildFence]);

  const captureManual = useCallback(() => captureNow('manual'), [captureNow]);

  const reset = useCallback(() => {
    if (captureTimerRef.current) clearInterval(captureTimerRef.current);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    if (watcherRef.current) watcherRef.current.stop();
    captureTimerRef.current = null;
    elapsedTimerRef.current = null;
    watcherRef.current = null;
    clearVisuals();
    setPoints([]);
    setPhase(TRACK_PHASE.IDLE);
    setElapsed(0);
    setError(null);
    onFeature?.(null);
  }, [clearVisuals, onFeature]);

  const deletePoint = useCallback(
    (idx) => {
      setPoints((arr) => {
        const next = arr.filter((_, i) => i !== idx);
        const mk = markersRef.current[idx];
        if (mk && map) map.removeLayer(mk);
        markersRef.current.splice(idx, 1);
        redrawPolyline(next);
        if (phase === TRACK_PHASE.READY) {
          if (next.length < 2) {
            if (fenceLayerRef.current) map?.removeLayer(fenceLayerRef.current);
            fenceLayerRef.current = null;
            setPhase(TRACK_PHASE.IDLE);
            onFeature?.(null);
          } else {
            buildFence(next, bufferRef.current);
          }
        }
        return next;
      });
    },
    [map, redrawPolyline, phase, buildFence, onFeature]
  );

  // Rebuild fence when buffer changes (while in READY).
  useEffect(() => {
    if (phase === TRACK_PHASE.READY) {
      buildFence(pointsRef.current, bufferM);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufferM]);

  // Cleanup on unmount / map change.
  useEffect(() => {
    return () => reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    phase,
    points,
    bufferM,
    autoSec,
    elapsed,
    accuracy,
    error,
    setBufferM,
    setAutoSec,
    start,
    stop,
    captureManual,
    reset,
    deletePoint,
  };
}
