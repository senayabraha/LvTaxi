import React, { useState } from 'react';
import MapView from './MapView.jsx';
import TrackMode from './TrackMode.jsx';
import DrawMode from './DrawMode.jsx';
import SavePanel from './SavePanel.jsx';

const TAB = { DRAW: 'draw', TRACK: 'track' };

export default function BuilderPage() {
  const [mode, setMode] = useState(TAB.DRAW);
  const [feature, setFeature] = useState(null);
  const [bumpKey, setBumpKey] = useState(0);

  function reset() {
    setFeature(null);
    setBumpKey((k) => k + 1);
  }

  function switchMode(next) {
    setMode(next);
    reset();
  }

  return (
    <div className="flex flex-col md:flex-row h-full">
      {/* Map: takes available width on desktop, fixed height on mobile */}
      <div className="relative flex-1 min-h-[280px] md:min-h-0">
        <MapView>
          {(map) =>
            mode === TAB.TRACK ? (
              <Bridge>
                <TrackMode
                  key={`track-${bumpKey}`}
                  map={map}
                  onPolygonReady={setFeature}
                />
              </Bridge>
            ) : (
              <Bridge>
                <DrawMode
                  key={`draw-${bumpKey}`}
                  map={map}
                  onPolygonReady={setFeature}
                />
              </Bridge>
            )
          }
        </MapView>
      </div>

      {/* Sidebar: right column on desktop, bottom panel on mobile */}
      <aside className="w-full md:w-[340px] border-t md:border-t-0 md:border-l border-border bg-panel flex flex-col overflow-hidden max-h-[55vh] md:max-h-none">
        <div className="p-3 sm:p-4 border-b border-border">
          <div className="text-text font-semibold text-sm mb-2">Builder</div>
          <div className="flex gap-2">
            <button
              onClick={() => switchMode(TAB.DRAW)}
              className={`flex-1 h-9 rounded text-sm font-medium ${
                mode === TAB.DRAW
                  ? 'bg-accent text-bg'
                  : 'bg-panel2 border border-border text-muted'
              }`}
            >
              ✏️ Draw
            </button>
            <button
              onClick={() => switchMode(TAB.TRACK)}
              className={`flex-1 h-9 rounded text-sm font-medium ${
                mode === TAB.TRACK
                  ? 'bg-accent text-bg'
                  : 'bg-panel2 border border-border text-muted'
              }`}
            >
              📡 Track
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-4">
          <SavePanel feature={feature} onSaved={reset} />

          <div className="text-muted text-xs leading-relaxed border-t border-border pt-3">
            <div className="text-text font-semibold mb-1">Tips</div>
            <ul className="list-disc pl-4 space-y-1">
              <li>Draw: tap map to add vertices, drag to move, right-click / long-press to delete.</li>
              <li>Track: walk/drive the lane on a mobile browser for best GPS.</li>
              <li>After save, toggle "Use Phase B" on the zone row to activate.</li>
            </ul>
          </div>
        </div>
      </aside>
    </div>
  );
}

// Bridge renders its child as an absolute overlay on the top-left of the map.
// Narrower on small screens so it doesn't cover the whole map.
function Bridge({ children }) {
  return (
    <div
      className="absolute top-3 left-3 right-3 sm:right-auto z-[1000] bg-panel/95 border border-border rounded-lg p-3 sm:w-[280px] shadow-lg backdrop-blur"
      style={{ maxHeight: 'calc(100% - 24px)', overflow: 'auto' }}
    >
      {children}
    </div>
  );
}
