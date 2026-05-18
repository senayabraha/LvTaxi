import React, { useCallback, useRef, useState } from 'react';
import { useLeafletMap } from './MapView.jsx';
import BuilderHeader from './BuilderHeader.jsx';
import BottomToolbar from './BottomToolbar.jsx';
import PointsListSheet from './PointsListSheet.jsx';
import { useTrackController } from './useTrackController.js';
import { useDrawController } from './useDrawController.js';

const MODE = { TRACK: 'track', DRAW: 'draw' };

export default function BuilderPage() {
  const [mode, setMode] = useState(MODE.DRAW);
  const [feature, setFeature] = useState(null);
  const [showPoints, setShowPoints] = useState(false);

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

  const points = mode === MODE.TRACK ? trackCtrl.points : drawCtrl.points;

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

      <BottomToolbar
        mode={mode}
        trackCtrl={trackCtrl}
        drawCtrl={drawCtrl}
        feature={feature}
        onSaved={onSaved}
        onShowPoints={() => setShowPoints(true)}
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
