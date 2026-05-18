import React, { useEffect, useRef, useState } from 'react';
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

const PHASE = { IDLE: 'idle', TRACKING: 'tracking', READY: 'ready' };

export default function TrackMode({ map, onPolygonReady }) {
  const [phase, setPhase] = useState(PHASE.IDLE);
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

  function clearAll() {
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
    setPoints([]);
  }

  function addPoint(pt) {
    setAccuracy(pt.accuracy);
    setPoints((arr) => {
      const next = [...arr, pt];
      if (map) {
        const mk = L.marker([pt.lat, pt.lng], { icon: makePointIcon(pt.type) }).addTo(
          map
        );
        markersRef.current.push(mk);
        if (next.length >= 2) {
          if (polylineRef.current) map.removeLayer(polylineRef.current);
          polylineRef.current = L.polyline(
            next.map((p) => [p.lat, p.lng]),
            { color: '#2563eb', weight: 3, opacity: 0.8 }
          ).addTo(map);
        }
      }
      return next;
    });
  }

  async function captureNow(type) {
    try {
      const pos = await getOnePosition();
      addPoint({ ...pos, type });
    } catch (err) {
      setError(err.message);
    }
  }

  function start() {
    clearAll();
    setError(null);
    setPhase(PHASE.TRACKING);
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
  }

  function stop() {
    if (captureTimerRef.current) clearInterval(captureTimerRef.current);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    if (watcherRef.current) watcherRef.current.stop();
    captureTimerRef.current = null;
    elapsedTimerRef.current = null;
    watcherRef.current = null;
    if (points.length < 2) {
      setError('Need at least 2 points');
      setPhase(PHASE.IDLE);
      return;
    }
    setPhase(PHASE.READY);
    buildFence(bufferM);
  }

  function buildFence(radius) {
    if (!map || points.length < 2) return;
    let buf;
    try {
      const line = turf.lineString(points.map((p) => [p.lng, p.lat]));
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
    onPolygonReady?.(buf);
  }

  function reset() {
    if (captureTimerRef.current) clearInterval(captureTimerRef.current);
    if (elapsedTimerRef.current) clearInterval(elapsedTimerRef.current);
    if (watcherRef.current) watcherRef.current.stop();
    clearAll();
    setPhase(PHASE.IDLE);
    setElapsed(0);
    setError(null);
    onPolygonReady?.(null);
  }

  useEffect(() => {
    return () => reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (phase === PHASE.READY) buildFence(bufferM);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bufferM]);

  const mins = Math.floor(elapsed / 60_000);
  const secs = Math.floor((elapsed % 60_000) / 1000);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-xs text-muted">
        <span>📡 GPS: {accuracy != null ? `±${Math.round(accuracy)}m` : '—'}</span>
        <span>📍 Pts: {points.length}</span>
        <span>⏱ {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}</span>
      </div>

      {phase === PHASE.IDLE ? (
        <>
          <div className="flex items-center gap-2 text-sm">
            <label className="text-muted">Auto-capture every</label>
            <input
              type="number"
              min={10}
              max={600}
              step={10}
              value={autoSec}
              onChange={(e) => setAutoSec(parseInt(e.target.value, 10) || 60)}
              className="w-20 bg-panel2 border border-border rounded px-2 h-8 text-text"
            />
            <span className="text-muted">sec</span>
          </div>
          <button
            onClick={start}
            className="w-full bg-good text-bg font-semibold h-10 rounded"
          >
            ▶ Start Tracking
          </button>
        </>
      ) : null}

      {phase === PHASE.TRACKING ? (
        <div className="flex gap-2">
          <button
            onClick={() => captureNow('manual')}
            className="flex-1 bg-accent text-bg font-semibold h-10 rounded"
          >
            ➕ Add Point
          </button>
          <button
            onClick={stop}
            className="flex-1 bg-bad text-white font-semibold h-10 rounded"
          >
            ■ Stop
          </button>
        </div>
      ) : null}

      {phase === PHASE.READY ? (
        <>
          <div className="flex items-center gap-2 text-sm">
            <label className="text-muted">Buffer radius</label>
            <input
              type="number"
              min={1}
              max={50}
              step={0.5}
              value={bufferM}
              onChange={(e) => setBufferM(parseFloat(e.target.value) || 4)}
              className="w-20 bg-panel2 border border-border rounded px-2 h-8 text-text"
            />
            <span className="text-muted">m per side</span>
          </div>
          <button
            onClick={reset}
            className="w-full bg-panel border border-border text-muted h-10 rounded"
          >
            ↺ New Recording
          </button>
        </>
      ) : null}

      {error ? <div className="text-bad text-xs">{error}</div> : null}
    </div>
  );
}
