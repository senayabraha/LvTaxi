import React from 'react';

const TAB = { TRACK: 'track', DRAW: 'draw' };

function Chip({ label, value, color }) {
  return (
    <span
      className="inline-flex items-center gap-1 bg-panel2 border border-border rounded-full px-2.5 py-0.5 text-[11px] font-semibold whitespace-nowrap"
      style={{ color }}
    >
      <span className="opacity-70 font-normal">{label}:</span>
      <span className="tabular-nums">{value}</span>
    </span>
  );
}

export default function BuilderHeader({
  mode,
  onModeChange,
  gpsAccuracy,
  pointsCount,
  elapsedMs,
}) {
  const mm = Math.floor(elapsedMs / 60_000);
  const ss = Math.floor((elapsedMs % 60_000) / 1000);
  const hh = Math.floor(mm / 60);
  const timer = `${String(hh).padStart(2, '0')}:${String(mm % 60).padStart(
    2,
    '0'
  )}:${String(ss).padStart(2, '0')}`;

  return (
    <div className="bg-panel border-b border-border">
      <div className="flex items-center justify-between gap-2 px-3 sm:px-4 py-2">
        <div className="text-text font-semibold text-sm sm:text-base whitespace-nowrap">
          📍 Geofence Builder
        </div>
        <div className="flex items-center gap-1.5 flex-wrap justify-end">
          <Chip
            label="GPS"
            value={gpsAccuracy != null ? `±${Math.round(gpsAccuracy)}m` : '—'}
            color="#60A5FA"
          />
          <Chip
            label={mode === TAB.TRACK ? 'Pts' : 'Pts'}
            value={pointsCount}
            color="#22C55E"
          />
          {mode === TAB.TRACK ? (
            <Chip label="Time" value={timer} color="#A78BFA" />
          ) : null}
        </div>
      </div>
      <div className="flex border-t border-border">
        <ModeTab
          label="📡 Track"
          active={mode === TAB.TRACK}
          onClick={() => onModeChange(TAB.TRACK)}
        />
        <ModeTab
          label="✏️ Draw"
          active={mode === TAB.DRAW}
          onClick={() => onModeChange(TAB.DRAW)}
        />
      </div>
    </div>
  );
}

function ModeTab({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-2.5 text-sm font-semibold transition ${
        active
          ? 'text-accent border-b-2 border-accent bg-bg/40'
          : 'text-muted border-b-2 border-transparent hover:text-text'
      }`}
    >
      {label}
    </button>
  );
}
