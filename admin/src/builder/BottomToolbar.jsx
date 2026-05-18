import React, { useEffect, useRef, useState } from 'react';
import { TRACK_PHASE } from './useTrackController.js';
import { DRAW_MODE } from './useDrawController.js';
import { saveDrawn, saveDriven } from '../lib/zoneStore.js';
import { supabase } from '../supabase.js';

const SAVE_AS = { DRAWN: 'drawn', DRIVEN: 'driven' };

function NumInput({ value, onChange, min, max, step = 1, suffix }) {
  const [raw, setRaw] = useState(String(value));

  // Sync display when parent changes the value externally
  useEffect(() => {
    setRaw(String(value));
  }, [value]);

  function handleChange(e) {
    setRaw(e.target.value);
    const n = parseFloat(e.target.value);
    if (!isNaN(n)) onChange(n);
  }

  function handleBlur() {
    if (raw === '' || isNaN(parseFloat(raw))) {
      setRaw(String(value)); // reset display to last valid parent value
    }
  }

  return (
    <span className="inline-flex items-center gap-1 bg-panel2 border border-border rounded px-2 h-8">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={raw}
        onChange={handleChange}
        onBlur={handleBlur}
        className="w-12 bg-transparent text-text text-sm text-center outline-none"
      />
      {suffix ? <span className="text-muted text-xs">{suffix}</span> : null}
    </span>
  );
}

function PrimaryBtn({ children, onClick, color = 'accent', disabled }) {
  const palette = {
    accent: 'bg-accent text-bg',
    good: 'bg-good text-white',
    bad: 'bg-bad text-white',
    warn: 'bg-warn text-bg',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-1 h-11 rounded font-semibold text-sm transition disabled:opacity-50 disabled:cursor-not-allowed ${palette[color]}`}
    >
      {children}
    </button>
  );
}

function GhostBtn({ children, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex-1 h-10 rounded text-sm font-medium bg-panel2 border border-border text-muted hover:text-text disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function SegmentedPair({ left, right, value, onChange, valueLeft, valueRight }) {
  return (
    <div className="flex gap-2 w-full">
      <button
        onClick={() => onChange(valueLeft)}
        className={`flex-1 h-10 rounded text-sm font-medium transition ${
          value === valueLeft
            ? 'bg-accent text-bg'
            : 'bg-panel2 border border-border text-muted'
        }`}
      >
        {left}
      </button>
      <button
        onClick={() => onChange(valueRight)}
        className={`flex-1 h-10 rounded text-sm font-medium transition ${
          value === valueRight
            ? 'bg-accent text-bg'
            : 'bg-panel2 border border-border text-muted'
        }`}
      >
        {right}
      </button>
    </div>
  );
}

// Styled combobox: full themed dropdown, filterable, closes on outside click.
// required=true  → Driven mode: admin must pick an existing zone name
// required=false → Drawn mode:  free-text new names are also valid
function ZoneNameCombobox({ value, onChange, zoneNames, required }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const containerRef = useRef(null);

  // Sync internal query when parent clears the value (e.g. after a save)
  useEffect(() => {
    setQuery(value);
  }, [value]);

  // Close when clicking outside
  useEffect(() => {
    function handler(e) {
      if (!containerRef.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const filtered = zoneNames.filter((n) =>
    n.toLowerCase().includes(query.toLowerCase())
  );

  function select(name) {
    setQuery(name);
    onChange(name);
    setOpen(false);
  }

  function handleChange(e) {
    setQuery(e.target.value);
    if (!required) onChange(e.target.value); // free text only in Drawn mode
    setOpen(true);
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') setOpen(false);
  }

  return (
    <div ref={containerRef} className="relative w-full">
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={
          required ? 'Select existing zone…' : 'Zone name or select existing…'
        }
        className="w-full bg-panel2 border border-border rounded h-10 px-3 pr-8 text-text text-sm"
      />
      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted text-xs pointer-events-none">
        ▾
      </span>
      {required && (
        <div className="text-muted text-[10px] mt-1">
          Must match an existing zone name
        </div>
      )}
      {open && (
        <div className="absolute left-0 right-0 top-11 z-50 bg-panel border border-border rounded shadow-lg max-h-48 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-3 py-2 text-muted text-xs">No zones match</div>
          ) : (
            filtered.map((n) => (
              <button
                key={n}
                type="button"
                onMouseDown={() => select(n)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-panel2 ${
                  n === query ? 'text-accent font-medium' : 'text-text'
                }`}
              >
                {n}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function InlineSave({ feature, onSaved }) {
  const [name, setName] = useState('');
  const [saveAs, setSaveAs] = useState(SAVE_AS.DRAWN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [zoneNames, setZoneNames] = useState([]);

  useEffect(() => {
    supabase
      .from('staging_zones')
      .select('name')
      .order('name')
      .then(({ data }) => {
        if (data) setZoneNames(data.map((r) => r.name));
      });
  }, []);

  const canSave = !!feature && !!name.trim() && !busy;

  async function go() {
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      if (saveAs === SAVE_AS.DRAWN) {
        await saveDrawn({ name, feature });
        setSuccess(`Saved "${name.trim()}" as Drawn`);
      } else {
        await saveDriven({ name, feature });
        setSuccess(`Updated "${name.trim()}" driven polygon`);
      }
      setName('');
      onSaved?.();
    } catch (e) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-border pt-2 mt-2">
      <ZoneNameCombobox
        value={name}
        onChange={setName}
        zoneNames={zoneNames}
        required={saveAs === SAVE_AS.DRIVEN}
      />
      <SegmentedPair
        left="🟡 Drawn (new)"
        right="🟢 Driven (update)"
        value={saveAs}
        valueLeft={SAVE_AS.DRAWN}
        valueRight={SAVE_AS.DRIVEN}
        onChange={setSaveAs}
      />
      <div className="flex gap-2">
        <PrimaryBtn onClick={go} disabled={!canSave} color="accent">
          {busy ? 'Saving…' : '💾 Save to Supabase'}
        </PrimaryBtn>
      </div>
      {error ? <div className="text-bad text-xs">{error}</div> : null}
      {success ? <div className="text-good text-xs">✓ {success}</div> : null}
    </div>
  );
}

// ──────────────────────────────────────────────
// Track mode rows
// ──────────────────────────────────────────────
function TrackRows({ ctrl, onShowPoints }) {
  if (ctrl.phase === TRACK_PHASE.IDLE) {
    return (
      <>
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted">Auto-capture every</label>
          <NumInput
            value={ctrl.autoSec}
            onChange={(v) => ctrl.setAutoSec(Math.max(10, Math.min(600, v)))}
            min={10}
            max={600}
            step={10}
            suffix="sec"
          />
        </div>
        <div className="flex gap-2">
          <PrimaryBtn color="good" onClick={ctrl.start}>
            ▶ Start Tracking
          </PrimaryBtn>
        </div>
      </>
    );
  }

  if (ctrl.phase === TRACK_PHASE.TRACKING) {
    return (
      <div className="flex gap-2">
        <PrimaryBtn color="accent" onClick={ctrl.captureManual}>
          ➕ Add Point
        </PrimaryBtn>
        <PrimaryBtn color="bad" onClick={ctrl.stop}>
          ■ End Tracking
        </PrimaryBtn>
      </div>
    );
  }

  // READY
  return (
    <>
      <div className="flex items-center gap-2 text-sm">
        <label className="text-muted">Buffer</label>
        <NumInput
          value={ctrl.bufferM}
          onChange={(v) => ctrl.setBufferM(Math.max(0.5, Math.min(50, v)))}
          min={0.5}
          max={50}
          step={0.5}
          suffix="m"
        />
        <span className="text-muted text-xs">per side</span>
      </div>
      <div className="flex gap-2">
        <GhostBtn onClick={onShowPoints}>≡ Points</GhostBtn>
        <GhostBtn onClick={ctrl.reset}>↺ New Recording</GhostBtn>
      </div>
    </>
  );
}

// ──────────────────────────────────────────────
// Draw mode rows
// ──────────────────────────────────────────────
function DrawRows({ ctrl, onShowPoints }) {
  return (
    <>
      <SegmentedPair
        left="Path (buffer)"
        right="Polygon (closed)"
        value={ctrl.mode}
        valueLeft={DRAW_MODE.OPEN}
        valueRight={DRAW_MODE.CLOSED}
        onChange={ctrl.setMode}
      />
      {ctrl.mode === DRAW_MODE.OPEN ? (
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted">Buffer</label>
          <NumInput
            value={ctrl.bufferM}
            onChange={(v) => ctrl.setBufferM(Math.max(0.5, Math.min(50, v)))}
            min={0.5}
            max={50}
            step={0.5}
            suffix="m"
          />
        </div>
      ) : null}
      <div className="flex gap-2">
        <GhostBtn onClick={onShowPoints} disabled={ctrl.points.length === 0}>
          ≡ Points ({ctrl.points.length})
        </GhostBtn>
        <GhostBtn onClick={ctrl.clearAll} disabled={ctrl.points.length === 0}>
          🗑 Clear
        </GhostBtn>
      </div>
    </>
  );
}

// ──────────────────────────────────────────────
// Wrapper
// ──────────────────────────────────────────────
export default function BottomToolbar({
  mode,
  trackCtrl,
  drawCtrl,
  feature,
  onSaved,
  onShowPoints,
}) {
  const inTrackReady =
    mode === 'track' && trackCtrl.phase === TRACK_PHASE.READY;
  const inDrawWithFeature = mode === 'draw' && !!feature;

  const showSave = inTrackReady || inDrawWithFeature;

  return (
    <div
      className="bg-panel border-t border-border px-3 sm:px-4 pt-3 pb-3 sm:pb-4 space-y-2 sm:space-y-3"
      style={{ maxHeight: '55vh', overflowY: 'auto' }}
    >
      {mode === 'track' ? (
        <TrackRows ctrl={trackCtrl} onShowPoints={onShowPoints} />
      ) : (
        <DrawRows ctrl={drawCtrl} onShowPoints={onShowPoints} />
      )}

      {(trackCtrl?.error || drawCtrl?.error) ? (
        <div className="text-bad text-xs">
          {trackCtrl?.error || drawCtrl?.error}
        </div>
      ) : null}

      {showSave ? <InlineSave feature={feature} onSaved={onSaved} /> : null}
    </div>
  );
}
