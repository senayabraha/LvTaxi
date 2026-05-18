import React, { useEffect, useState } from 'react';

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

export default function ZoneRow({ zone, stat, onUpdate, onDelete, onPreview, onEditCircle }) {
  const [saving, setSaving] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Auto-cancel the delete confirmation after 3 s if not confirmed
  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), 3000);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  async function toggle(field, next) {
    setSaving(field);
    await onUpdate(zone, { [field]: next });
    setSaving(null);
  }

  async function handleDelete() {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    setDeleting(true);
    try {
      await onDelete(zone.id, zone.name);
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  const wait = stat?.wait_time_minutes;
  const cars = stat?.cars_staged ?? 0;
  const canUsePhaseB = !!zone.driven_polygon;
  const isBusy = !!saving || deleting;

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
          disabled={isBusy}
        />
      </td>
      <td className="px-2 sm:px-3 py-3 text-center">
        <Toggle
          value={!!zone.is_coming_soon}
          onChange={(v) => toggle('is_coming_soon', v)}
          color="#EAB308"
          disabled={isBusy}
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
            disabled={!canUsePhaseB || isBusy}
          />
          {!canUsePhaseB ? (
            <span className="text-muted text-[10px] mt-1">no driven</span>
          ) : null}
        </div>
      </td>
      <td className="px-2 sm:px-3 py-3 text-center">
        <Toggle
          value={!!zone.visible_to_drivers}
          onChange={(v) => toggle('visible_to_drivers', v)}
          color="#6366F1"
          disabled={isBusy}
        />
      </td>
      <td className="px-2 sm:px-3 py-3 text-center">
        <Toggle
          value={zone.circle_enabled !== false}
          onChange={(v) => toggle('circle_enabled', v)}
          color="#3B82F6"
          disabled={isBusy}
        />
      </td>
      <td className="px-2 sm:px-3 py-3 text-right tabular-nums">{cars}</td>
      <td className="px-2 sm:px-3 py-3 text-right tabular-nums">
        {formatWait(wait)}
      </td>
      <td className="px-3 sm:px-6 py-3 text-right text-muted text-xs whitespace-nowrap">
        {timeAgo(stat?.last_updated)}
      </td>
      <td className="px-2 sm:px-3 py-3">
        <div className="flex items-center gap-1 justify-end">
          <button
            onClick={() => onPreview?.(zone)}
            title="Preview on map"
            className="text-muted hover:text-text px-1.5 py-1 rounded hover:bg-panel2 text-xs"
          >
            🗺
          </button>
          <button
            onClick={() => onEditCircle?.(zone)}
            title="Edit circle"
            className="text-muted hover:text-text px-1.5 py-1 rounded hover:bg-panel2 text-xs"
          >
            ✏
          </button>
          {confirmDelete ? (
            <>
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="text-bad hover:text-bad/80 px-2 py-1 rounded bg-bad/10 text-xs font-semibold"
              >
                {deleting ? '…' : 'Sure?'}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-muted hover:text-text px-1.5 py-1 rounded hover:bg-panel2 text-xs"
              >
                ✕
              </button>
            </>
          ) : (
            <button
              onClick={handleDelete}
              disabled={deleting}
              title="Delete zone"
              className="text-muted hover:text-bad px-1.5 py-1 rounded hover:bg-panel2 text-xs"
            >
              🗑
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}
