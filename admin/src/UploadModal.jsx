import React, { useRef, useState } from 'react';
import { supabase } from './supabase.js';
import { centroidOf, radiusMeters, normalizeName } from './geo.js';
import { bulkUpsertDrawn, bulkUpdateDriven } from './lib/zoneStore.js';

const STATE = {
  IDLE: 'idle',
  PARSED: 'parsed',
  IMPORTING: 'importing',
  DONE: 'done',
};

const MODE = {
  DRAWN: 'drawn',
  DRIVEN: 'driven',
};

export default function UploadModal({ onClose, onDone }) {
  const inputRef = useRef(null);
  const [state, setState] = useState(STATE.IDLE);
  const [mode, setMode] = useState(MODE.DRAWN);
  const [error, setError] = useState(null);
  const [rows, setRows] = useState([]);
  const [progress, setProgress] = useState({ ok: 0, total: 0 });

  function reset() {
    setState(STATE.IDLE);
    setError(null);
    setRows([]);
    setProgress({ ok: 0, total: 0 });
  }

  async function handleFile(file) {
    setError(null);
    if (!file) return;
    if (!/\.(geo)?json$/i.test(file.name)) {
      setError('Pick a .geojson or .json file.');
      return;
    }
    let parsed;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch (e) {
      setError('File is not valid JSON.');
      return;
    }
    if (parsed?.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) {
      setError('Must be a GeoJSON FeatureCollection.');
      return;
    }

    const candidates = [];
    for (const feature of parsed.features) {
      if (feature?.geometry?.type !== 'Polygon') continue;
      const name = normalizeName(
        feature.properties?.Name || feature.properties?.name
      );
      if (!name) continue;
      const center = centroidOf(feature);
      if (!center) continue;
      const radius = radiusMeters(feature);
      candidates.push({ name, feature, center, radius });
    }

    if (candidates.length === 0) {
      setError('No usable Polygon features found.');
      return;
    }

    const names = candidates.map((c) => c.name);
    const { data: existing, error: lookupErr } = await supabase
      .from('staging_zones')
      .select('name')
      .in('name', names);
    if (lookupErr) {
      setError(lookupErr.message);
      return;
    }
    const existingSet = new Set((existing ?? []).map((e) => e.name));

    setRows(
      candidates.map((c) => ({
        ...c,
        existing: existingSet.has(c.name),
      }))
    );
    setState(STATE.PARSED);
  }

  function onChange(e) {
    const f = e.target.files?.[0];
    handleFile(f);
  }

  function onDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const f = e.dataTransfer?.files?.[0];
    handleFile(f);
  }

  async function confirmImport() {
    setState(STATE.IMPORTING);
    setProgress({ ok: 0, total: rows.length });

    try {
      if (mode === MODE.DRAWN) {
        await bulkUpsertDrawn(rows);
      } else {
        await bulkUpdateDriven(rows);
      }
    } catch (e) {
      setError(e.message ?? String(e));
      setState(STATE.PARSED);
      return;
    }

    setProgress({ ok: rows.length, total: rows.length });
    setState(STATE.DONE);
    setTimeout(() => onDone?.(), 700);
  }

  const newCount = rows.filter((r) => !r.existing).length;
  const updateCount = rows.filter((r) => r.existing).length;
  const skipCount = mode === MODE.DRIVEN ? newCount : 0;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4">
      <div className="bg-panel border border-border rounded-t-lg sm:rounded-lg w-full sm:max-w-2xl max-h-[90vh] sm:max-h-[80vh] flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="text-text font-semibold">Upload GeoJSON</div>
          <button
            onClick={onClose}
            className="text-muted hover:text-text"
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="px-5 pt-4 pb-2 border-b border-border bg-panel2/40">
          <div className="text-muted text-xs mb-2">Polygon type</div>
          <div className="flex gap-2">
            <button
              onClick={() => {
                setMode(MODE.DRAWN);
                reset();
              }}
              className={`flex-1 px-3 py-2 rounded text-sm font-medium border transition ${
                mode === MODE.DRAWN
                  ? 'bg-warn/20 border-warn text-warn'
                  : 'bg-panel border-border text-muted hover:text-text'
              }`}
            >
              🟡 Drawn (Phase A)
            </button>
            <button
              onClick={() => {
                setMode(MODE.DRIVEN);
                reset();
              }}
              className={`flex-1 px-3 py-2 rounded text-sm font-medium border transition ${
                mode === MODE.DRIVEN
                  ? 'bg-good/20 border-good text-good'
                  : 'bg-panel border-border text-muted hover:text-text'
              }`}
            >
              🟢 Driven (Phase B)
            </button>
          </div>
          <div className="text-muted text-xs mt-2">
            {mode === MODE.DRAWN ? (
              <>
                Sketched polygons from a map tool. Creates new zones or
                updates existing ones&apos; drawn_polygon. Use this for the
                initial import.
              </>
            ) : (
              <>
                Recorded GPS tracks from the Geofence Builder. Updates only
                existing zones&apos; driven_polygon — skips unknown names.
                Toggle &quot;Use Phase B&quot; on the zone row to switch
                detection.
              </>
            )}
          </div>
        </div>

        <div className="p-5 overflow-auto flex-1">
          {state === STATE.IDLE ? (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              className="border-2 border-dashed border-border rounded-lg py-10 text-center cursor-pointer hover:border-accent/60"
            >
              <div className="text-text font-medium mb-1">
                Drag & drop a .geojson file
              </div>
              <div className="text-muted text-sm">or click to browse</div>
              <input
                ref={inputRef}
                type="file"
                accept=".geojson,.json,application/geo+json,application/json"
                onChange={onChange}
                className="hidden"
              />
            </div>
          ) : null}

          {error ? (
            <div className="text-bad text-sm mt-3">{error}</div>
          ) : null}

          {(state === STATE.PARSED ||
            state === STATE.IMPORTING ||
            state === STATE.DONE) && rows.length ? (
            <>
              <div className="text-muted text-xs mb-3">
                {mode === MODE.DRAWN ? (
                  <>
                    {newCount} new · {updateCount} update · 0 skipped
                  </>
                ) : (
                  <>
                    {updateCount} update · {skipCount} skip (name not in DB)
                  </>
                )}
              </div>
              <div className="border border-border rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-panel2 text-muted text-xs uppercase">
                    <tr>
                      <th className="text-left px-3 py-2">Name</th>
                      <th className="text-right px-3 py-2">Radius</th>
                      <th className="text-right px-3 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const willSkip = mode === MODE.DRIVEN && !r.existing;
                      return (
                        <tr key={r.name} className="border-t border-border">
                          <td className="px-3 py-2 text-text">{r.name}</td>
                          <td className="px-3 py-2 text-right text-muted tabular-nums">
                            {r.radius}m
                          </td>
                          <td className="px-3 py-2 text-right text-xs">
                            {willSkip ? (
                              <span className="text-bad">
                                ⚠️ skip (no zone)
                              </span>
                            ) : r.existing ? (
                              <span className="text-warn">🔄 update</span>
                            ) : (
                              <span className="text-good">✅ new</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>

        <footer className="flex items-center justify-end gap-2 px-5 py-3 border-t border-border">
          {state === STATE.DONE ? (
            <div className="text-good text-sm mr-auto">
              ✓ {mode === MODE.DRAWN ? 'Imported' : 'Updated'}{' '}
              {mode === MODE.DRAWN ? rows.length : updateCount} zones
            </div>
          ) : null}
          <button
            onClick={onClose}
            className="bg-panel border border-border text-muted px-4 py-2 rounded text-sm"
          >
            {state === STATE.DONE ? 'Close' : 'Cancel'}
          </button>
          {state === STATE.PARSED ? (
            <button
              onClick={confirmImport}
              disabled={mode === MODE.DRIVEN && updateCount === 0}
              className={`px-4 py-2 rounded text-sm font-semibold ${
                mode === MODE.DRIVEN && updateCount === 0
                  ? 'bg-panel border border-border text-muted'
                  : 'bg-accent text-bg'
              }`}
            >
              {mode === MODE.DRAWN
                ? `Import ${rows.length} zones`
                : `Update ${updateCount} zones`}
            </button>
          ) : null}
          {state === STATE.IMPORTING ? (
            <button
              disabled
              className="bg-accent/60 text-bg font-semibold px-4 py-2 rounded text-sm"
            >
              {mode === MODE.DRAWN ? 'Importing…' : 'Updating…'}
            </button>
          ) : null}
        </footer>
      </div>
    </div>
  );
}
