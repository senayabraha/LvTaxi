import React, { useEffect, useState } from 'react';
import { HealthBadge } from './components/StatusBadge.jsx';
import { computeZoneHealth, getWaitMinutes, phaseOf } from './lib/zoneHealth.js';

// Compact toggle (mirrors the one in ZoneRow) for the mobile card view.
function Toggle({ value, onChange, color = '#22C55E', disabled = false }) {
  return (
    <button
      onClick={() => !disabled && onChange(!value)}
      disabled={disabled}
      className="inline-flex items-center shrink-0"
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

function ToggleRow({ label, children }) {
  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="text-muted text-xs">{label}</span>
      {children}
    </div>
  );
}

function formatWait(mins) {
  if (mins == null) return '—';
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

// Mobile card representation of a zone — same data + controls as ZoneRow.
export default function ZoneCard({ zone, stat, onUpdate, onDelete, onPreview, onEditCircle }) {
  const [saving, setSaving] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

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

  const wait = getWaitMinutes(stat);
  const cars = stat?.cars_staged ?? 0;
  const canUsePhaseB = !!zone.driven_polygon;
  const isBusy = !!saving || deleting;
  const { health, reasons } = computeZoneHealth(zone, stat);

  return (
    <div className="px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-text font-medium truncate">{zone.name}</span>
          <HealthBadge health={health} title={reasons.join(' · ')} />
        </div>
        <span className="text-muted text-[11px] whitespace-nowrap">
          Phase {phaseOf(zone)}
        </span>
      </div>

      <div className="flex items-center gap-3 mt-1 text-xs text-muted">
        <span>
          Cars <span className="text-text tabular-nums">{cars}</span>
        </span>
        <span>
          Wait <span className="text-text tabular-nums">{formatWait(wait)}</span>
        </span>
        {saving ? <span className="text-muted">saving…</span> : null}
      </div>

      <div className="grid grid-cols-2 gap-x-4 mt-2">
        <ToggleRow label="Active">
          <Toggle value={!!zone.active} onChange={(v) => toggle('active', v)} color="#22C55E" disabled={isBusy} />
        </ToggleRow>
        <ToggleRow label="Visible">
          <Toggle value={!!zone.visible_to_drivers} onChange={(v) => toggle('visible_to_drivers', v)} color="#6366F1" disabled={isBusy} />
        </ToggleRow>
        <ToggleRow label="Coming soon">
          <Toggle value={!!zone.is_coming_soon} onChange={(v) => toggle('is_coming_soon', v)} color="#EAB308" disabled={isBusy} />
        </ToggleRow>
        <ToggleRow label="Circle">
          <Toggle value={zone.circle_enabled !== false} onChange={(v) => toggle('circle_enabled', v)} color="#3B82F6" disabled={isBusy} />
        </ToggleRow>
        <ToggleRow label={canUsePhaseB ? 'Use Phase B' : 'Use Phase B (no driven)'}>
          <Toggle value={!!zone.use_driven_polygon} onChange={(v) => toggle('use_driven_polygon', v)} color="#16A34A" disabled={!canUsePhaseB || isBusy} />
        </ToggleRow>
      </div>

      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={() => onPreview?.(zone)}
          className="bg-panel2 border border-border text-muted px-2.5 py-1 rounded text-xs"
        >
          🗺 Map
        </button>
        <button
          onClick={() => onEditCircle?.(zone)}
          className="bg-panel2 border border-border text-muted px-2.5 py-1 rounded text-xs"
        >
          ✏ Circle
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className={`ml-auto px-2.5 py-1 rounded text-xs font-semibold ${
            confirmDelete ? 'bg-bad/20 text-bad' : 'bg-panel2 border border-border text-muted'
          }`}
        >
          {deleting ? '…' : confirmDelete ? 'Sure?' : '🗑'}
        </button>
      </div>
    </div>
  );
}
