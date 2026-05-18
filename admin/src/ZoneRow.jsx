import React, { useState } from 'react';

function Toggle({ value, onChange, color = '#22C55E', disabled = false }) {
  return (
    <button
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      className="inline-flex items-center"
      style={{
        width: 38,
        height: 22,
        borderRadius: 11,
        backgroundColor: value ? color : '#374151',
        padding: 2,
        transition: 'background-color 200ms',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 9,
          backgroundColor: 'white',
          transform: value ? 'translateX(16px)' : 'translateX(0px)',
          transition: 'transform 200ms',
          display: 'block',
        }}
      />
    </button>
  );
}

function PhaseBadge({ zone }) {
  if (zone.use_driven_polygon && zone.driven_polygon) {
    return (
      <span className="inline-flex items-center gap-1 text-good text-xs">
        🟢 Phase B
      </span>
    );
  }
  if (zone.drawn_polygon) {
    return (
      <span className="inline-flex items-center gap-1 text-warn text-xs">
        🟡 Phase A
      </span>
    );
  }
  return <span className="text-muted text-xs">⚪ Circle only</span>;
}

function PolygonStatus({ zone }) {
  const bits = [];
  if (zone.drawn_polygon) bits.push('Drawn');
  if (zone.driven_polygon) bits.push('Driven');
  if (bits.length === 0) return <span className="text-muted text-xs">none</span>;
  return <span className="text-muted text-xs">{bits.join(' + ')}</span>;
}

function formatWait(mins) {
  if (mins == null) return '—';
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function ZoneRow({ zone, stat, onUpdate }) {
  const [saving, setSaving] = useState(null);

  async function toggle(field, next) {
    setSaving(field);
    await onUpdate(zone.id, { [field]: next });
    setSaving(null);
  }

  const wait = stat?.wait_time_minutes;
  const cars = stat?.cars_staged ?? 0;
  const canUsePhaseB = !!zone.driven_polygon;

  return (
    <tr className="border-b border-border hover:bg-panel/50">
      <td className="px-3 sm:px-6 py-3 text-text font-medium">
        {zone.name}
        {saving ? (
          <span className="ml-2 text-muted text-xs">saving…</span>
        ) : null}
      </td>
      <td className="px-2 sm:px-3 py-3">
        <PhaseBadge zone={zone} />
      </td>
      <td className="px-2 sm:px-3 py-3">
        <PolygonStatus zone={zone} />
      </td>
      <td className="px-2 sm:px-3 py-3 text-center">
        <Toggle
          value={!!zone.active}
          onChange={(v) => toggle('active', v)}
          color="#22C55E"
        />
      </td>
      <td className="px-2 sm:px-3 py-3 text-center">
        <Toggle
          value={!!zone.is_coming_soon}
          onChange={(v) => toggle('is_coming_soon', v)}
          color="#EAB308"
        />
      </td>
      <td className="px-2 sm:px-3 py-3 text-center">
        <div
          className="inline-flex flex-col items-center"
          title={
            canUsePhaseB
              ? 'Use the recorded (driven) polygon for detection'
              : 'Upload a driven polygon first'
          }
        >
          <Toggle
            value={!!zone.use_driven_polygon}
            onChange={(v) => toggle('use_driven_polygon', v)}
            color="#16A34A"
            disabled={!canUsePhaseB}
          />
          {!canUsePhaseB ? (
            <span className="text-muted text-[10px] mt-1">no driven</span>
          ) : null}
        </div>
      </td>
      <td className="px-2 sm:px-3 py-3 text-right tabular-nums">{cars}</td>
      <td className="px-2 sm:px-3 py-3 text-right tabular-nums">{formatWait(wait)}</td>
      <td className="px-3 sm:px-6 py-3 text-right text-muted text-xs whitespace-nowrap">
        {timeAgo(stat?.last_updated)}
      </td>
    </tr>
  );
}
