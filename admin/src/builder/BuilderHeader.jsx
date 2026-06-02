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
    <div className="bg-panel border-b border-border flex items-center gap-2 px-2 sm:px-4 py-1.5">
      {/* Mode segmented control */}
      <div className="flex bg-panel2 border border-border rounded-lg p-0.5 shrink-0">
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

      {/* Live chips */}
      <div className="flex items-center gap-1.5 ml-auto overflow-x-auto no-scrollbar">
        <Chip
          label="GPS"
          value={gpsAccuracy != null ? `±${Math.round(gpsAccuracy)}m` : '—'}
          color="#60A5FA"
        />
        <Chip label="Pts" value={pointsCount} color="#22C55E" />
        {mode === TAB.TRACK ? (
          <Chip label="Time" value={timer} color="#A78BFA" />
        ) : null}
      </div>
    </div>
  );
}

function ModeTab({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-md text-sm font-semibold whitespace-nowrap transition ${
        active ? 'bg-accent text-bg' : 'text-muted hover:text-text'
      }`}
    >
      {label}
    </button>
  );
}
