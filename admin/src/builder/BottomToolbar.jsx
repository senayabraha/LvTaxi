import React, { useEffect, useState } from 'react';
import { TRACK_PHASE } from './useTrackController.js';
import { DRAW_MODE } from './useDrawController.js';
import { saveDrawn, saveDriven } from '../lib/zoneStore.js';
import { supabase } from '../supabase.js';

const SAVE_AS = { DRAWN: 'drawn', DRIVEN: 'driven' };

function NumInput({ value, onChange, min, max, step = 1, suffix }) {
  return (
    <span className="inline-flex items-center gap-1 bg-panel2 border border-border rounded px-2 h-8">
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
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
      <datalist id="builder-zone-names">
        {zoneNames.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        list="builder-zone-names"
        placeholder={
          saveAs === SAVE_AS.DRIVEN
            ? 'Select existing zone name…'
            : 'Zone name (e.g. MGM Grand)'
        }
        className="w-full bg-panel2 border border-border rounded h-10 px-3 text-text text-sm"
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
