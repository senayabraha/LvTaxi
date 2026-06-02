import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLeafletMap } from './MapView.jsx';
import BuilderHeader from './BuilderHeader.jsx';
import BottomToolbar from './BottomToolbar.jsx';
import PointsListSheet from './PointsListSheet.jsx';
import { useTrackController } from './useTrackController.js';
import { useDrawController, DRAW_MODE } from './useDrawController.js';
import {
  parseGeoJsonFile,
  geoJsonToBuilderPoints,
  builderPointsToGeoJson,
  getGeoJsonBounds,
  downloadGeoJson,
  builderExportFilename,
} from '../lib/geojsonBuilder.js';

const MODE = { TRACK: 'track', DRAW: 'draw' };

export default function BuilderPage() {
  const [mode, setMode] = useState(MODE.DRAW);
  const [feature, setFeature] = useState(null);
  const [showPoints, setShowPoints] = useState(false);

  // GeoJSON import state.
  const [imported, setImported] = useState(null); // { name, count }
  const [importError, setImportError] = useState(null);
  const [pendingImport, setPendingImport] = useState(null); // { coords, mode, name }
  const fileRef = useRef(null);

  const mapContainerRef = useRef(null);
  const { mapRef, ready, layer, toggleLayer, findMe } =
    useLeafletMap(mapContainerRef);

  const onFeature = useCallback((f) => setFeature(f), []);

  // Hooks gate themselves on mode by accepting map=null when not active.
  const trackCtrl = useTrackController({
    map: ready && mode === MODE.TRACK ? mapRef.current : null,
    onFeature: mode === MODE.TRACK ? onFeature : undefined,
  });
  const drawCtrl = useDrawController({
    map: ready && mode === MODE.DRAW ? mapRef.current : null,
    onFeature: mode === MODE.DRAW ? onFeature : undefined,
  });

  function switchMode(next) {
    if (next === mode) return;
    setMode(next);
    setFeature(null);
    setShowPoints(false);
  }

  function onSaved() {
    setFeature(null);
  }

  // ── GeoJSON import ─────────────────────────────────────────────────────────
  async function handleImportFile(file) {
    setImportError(null);
    try {
      const parsed = await parseGeoJsonFile(file);
      const { points: pts, mode: gmode } = geoJsonToBuilderPoints(parsed);
      // Imported geometry is edited in Draw mode; switch first, then apply once
      // the map is attached to the draw controller (see effect below).
      if (mode !== MODE.DRAW) {
        setMode(MODE.DRAW);
        setFeature(null);
        setShowPoints(false);
      }
      setPendingImport({ coords: pts, mode: gmode, name: file.name });
    } catch (e) {
      setImportError(e.message ?? String(e));
    }
  }

  // Apply a pending import once Draw mode is active and the map is ready.
  useEffect(() => {
    if (!pendingImport) return;
    if (mode !== MODE.DRAW || !ready || !mapRef.current) return;
    const targetMode =
      pendingImport.mode === 'closed' ? DRAW_MODE.CLOSED : DRAW_MODE.OPEN;
    drawCtrl.importPoints(pendingImport.coords, targetMode);
    const bounds = getGeoJsonBounds(pendingImport.coords);
    if (bounds) {
      try {
        mapRef.current.fitBounds(bounds, { padding: [40, 40] });
      } catch {
        /* ignore degenerate bounds */
      }
    }
    setImported({ name: pendingImport.name, count: pendingImport.coords.length });
    setPendingImport(null);
  }, [pendingImport, mode, ready, drawCtrl, mapRef]);

  function handleClearImport() {
    drawCtrl.clearAll();
    setImported(null);
    setImportError(null);
    setPendingImport(null);
  }

  // ── GeoJSON export ─────────────────────────────────────────────────────────
  function handleExport() {
    setImportError(null);
    try {
      const isDraw = mode === MODE.DRAW;
      const pts = isDraw ? drawCtrl.points : trackCtrl.points;
      const gmode = isDraw && drawCtrl.mode === DRAW_MODE.CLOSED ? 'closed' : 'open';
      const buffer = isDraw ? drawCtrl.bufferM : trackCtrl.bufferM;
      const name = imported?.name
        ? imported.name.replace(/\.(geo)?json$/i, '')
        : undefined;
      const fc = builderPointsToGeoJson(pts, {
        mode: gmode,
        bufferMeters: gmode === 'open' ? buffer : undefined,
        name,
      });
      downloadGeoJson(fc, builderExportFilename());
    } catch (e) {
      setImportError(e.message ?? String(e));
    }
  }

  const points = mode === MODE.TRACK ? trackCtrl.points : drawCtrl.points;

  // Enough points to form a valid export for the active geometry mode.
  const minPts =
    mode === MODE.DRAW && drawCtrl.mode === DRAW_MODE.CLOSED ? 3 : 2;
  const canExport = points.length >= minPts;

  return (
    <div className="flex flex-col h-full bg-bg">
      <BuilderHeader
        mode={mode}
        onModeChange={switchMode}
        gpsAccuracy={mode === MODE.TRACK ? trackCtrl.accuracy : null}
        pointsCount={points.length}
        elapsedMs={mode === MODE.TRACK ? trackCtrl.elapsed : 0}
      />

      <div className="relative flex-1 min-h-0">
        <div ref={mapContainerRef} className="absolute inset-0" />
        <button
          onClick={toggleLayer}
          className="absolute right-3 top-3 z-[600] bg-white text-gray-800 text-xs font-semibold px-3 h-8 rounded-full shadow"
        >
          {layer === 'street' ? '🛰 Satellite' : '🗺 Street'}
        </button>
        <button
          onClick={findMe}
          className="absolute right-3 top-14 z-[600] bg-white text-gray-800 w-8 h-8 rounded-full shadow flex items-center justify-center"
          title="Center on me"
        >
          🎯
        </button>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".geojson,.json,application/geo+json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleImportFile(f);
          e.target.value = '';
        }}
      />

      <BottomToolbar
        mode={mode}
        trackCtrl={trackCtrl}
        drawCtrl={drawCtrl}
        feature={feature}
        onSaved={onSaved}
        onShowPoints={() => setShowPoints(true)}
        onImport={() => fileRef.current?.click()}
        onExport={handleExport}
        canExport={canExport}
        imported={imported}
        importError={importError}
        onClearImport={handleClearImport}
      />

      <PointsListSheet
        open={showPoints}
        title={mode === MODE.TRACK ? 'Recorded Points' : 'Drawn Points'}
        points={points}
        onDelete={(idx) =>
          mode === MODE.TRACK
            ? trackCtrl.deletePoint(idx)
            : drawCtrl.deletePointByIndex(idx)
        }
        onClose={() => setShowPoints(false)}
      />
    </div>
  );
}
