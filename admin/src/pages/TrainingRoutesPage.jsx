import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import RoutePreviewModal from '../RoutePreviewModal.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { useToast } from '../useToast.jsx';

const ROUTE_TYPE_TONE = {
  staging: 'good',
  drop_off: 'bad',
  loop_then_stage: 'warn',
};

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// Compact summary of the features jsonb so admins can eyeball what was saved.
function featureSummary(features) {
  if (!features || typeof features !== 'object') return '—';
  const keys = Object.keys(features);
  if (keys.length === 0) return '—';
  return `${keys.length} field${keys.length === 1 ? '' : 's'}`;
}

// Manager for already-saved reference_routes (does not replace TrainingPage,
// which is the drawing tool). Read + filter + preview + delete.
export default function TrainingRoutesPage() {
  const toast = useToast();
  const [routes, setRoutes] = useState([]);
  const [zoneMap, setZoneMap] = useState({}); // id -> name
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [preview, setPreview] = useState(null); // route row

  const [zoneFilter, setZoneFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [deletingId, setDeletingId] = useState(null);
  const [confirmId, setConfirmId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [rRes, zRes] = await Promise.all([
      supabase
        .from('reference_routes')
        .select('id, zone_id, route_type, features, path_coords, source, recorded_by, recorded_at')
        .order('recorded_at', { ascending: false }),
      supabase.from('staging_zones').select('id, name'),
    ]);
    if (rRes.error) {
      setError(rRes.error.message);
      setRoutes([]);
    } else {
      setRoutes(rRes.data ?? []);
    }
    const m = {};
    for (const z of zRes.data ?? []) m[z.id] = z.name;
    setZoneMap(m);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const zoneOptions = useMemo(() => {
    const ids = new Set(routes.map((r) => r.zone_id));
    return Array.from(ids)
      .map((id) => ({ id, name: zoneMap[id] ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [routes, zoneMap]);

  const filtered = useMemo(() => {
    return routes.filter((r) => {
      if (zoneFilter !== 'all' && r.zone_id !== zoneFilter) return false;
      if (typeFilter !== 'all' && r.route_type !== typeFilter) return false;
      if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
      return true;
    });
  }, [routes, zoneFilter, typeFilter, sourceFilter]);

  async function handleDelete(route) {
    if (confirmId !== route.id) {
      setConfirmId(route.id);
      setTimeout(() => setConfirmId((c) => (c === route.id ? null : c)), 3000);
      return;
    }
    setDeletingId(route.id);
    try {
      const { error: err } = await supabase
        .from('reference_routes')
        .delete()
        .eq('id', route.id);
      if (err) throw err;
      setRoutes((rs) => rs.filter((r) => r.id !== route.id));
      toast('Route deleted', 'success');
    } catch (err) {
      toast(err.message ?? 'Delete failed', 'error');
    } finally {
      setDeletingId(null);
      setConfirmId(null);
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 sm:px-6 py-3 border-b border-border bg-panel/40">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted">Zone:</span>
          <select
            value={zoneFilter}
            onChange={(e) => setZoneFilter(e.target.value)}
            className="bg-panel border border-border rounded px-2 py-1 text-text max-w-[160px]"
          >
            <option value="all">All zones</option>
            {zoneOptions.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted">Type:</span>
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="bg-panel border border-border rounded px-2 py-1 text-text"
          >
            <option value="all">All types</option>
            <option value="staging">staging</option>
            <option value="drop_off">drop_off</option>
            <option value="loop_then_stage">loop_then_stage</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-muted">Source:</span>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            className="bg-panel border border-border rounded px-2 py-1 text-text"
          >
            <option value="all">All sources</option>
            <option value="drawn">drawn</option>
            <option value="driven">driven</option>
          </select>
        </div>

        <button
          onClick={load}
          className="ml-auto bg-accent text-bg font-semibold px-3 py-1.5 rounded text-xs whitespace-nowrap"
        >
          ↻ Refresh
        </button>
      </div>

      <main className="flex-1 overflow-auto">
        {error ? (
          <div className="bg-bad/20 text-bad px-3 sm:px-6 py-3 text-sm">
            Could not load training routes: {error}
            <div className="text-muted text-xs mt-1">
              Ensure migration <code>009_reference_routes.sql</code> is applied
              and your account has <code>drivers.role = 'admin'</code>.
            </div>
          </div>
        ) : loading && routes.length === 0 ? (
          <div className="text-muted text-center py-12">Loading routes…</div>
        ) : filtered.length === 0 ? (
          <div className="text-muted text-center py-12">
            No training routes match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 920 }}>
              <thead className="sticky top-0 bg-bg border-b border-border">
                <tr className="text-muted text-xs uppercase tracking-wide">
                  <th className="text-left px-3 sm:px-6 py-3">Zone</th>
                  <th className="text-left px-2 sm:px-3 py-3">Route Type</th>
                  <th className="text-left px-2 sm:px-3 py-3">Source</th>
                  <th className="text-right px-2 sm:px-3 py-3">Points</th>
                  <th className="text-left px-2 sm:px-3 py-3">Features</th>
                  <th className="text-left px-2 sm:px-3 py-3">Recorded By</th>
                  <th className="text-right px-2 sm:px-3 py-3">Recorded At</th>
                  <th className="text-right px-3 sm:px-6 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-b border-border hover:bg-panel/50">
                    <td className="px-3 sm:px-6 py-3 text-text font-medium">
                      {zoneMap[r.zone_id] ?? (
                        <span className="text-muted">unknown zone</span>
                      )}
                    </td>
                    <td className="px-2 sm:px-3 py-3">
                      <StatusBadge tone={ROUTE_TYPE_TONE[r.route_type] ?? 'muted'}>
                        {r.route_type}
                      </StatusBadge>
                    </td>
                    <td className="px-2 sm:px-3 py-3 text-muted text-xs">{r.source}</td>
                    <td className="px-2 sm:px-3 py-3 text-right tabular-nums">
                      {Array.isArray(r.path_coords) ? r.path_coords.length : 0}
                    </td>
                    <td className="px-2 sm:px-3 py-3 text-muted text-xs">
                      {featureSummary(r.features)}
                    </td>
                    <td className="px-2 sm:px-3 py-3 text-muted text-[11px] font-mono whitespace-nowrap">
                      {r.recorded_by ? `${r.recorded_by.slice(0, 8)}…` : '—'}
                    </td>
                    <td className="px-2 sm:px-3 py-3 text-right text-muted text-xs whitespace-nowrap">
                      {formatTime(r.recorded_at)}
                    </td>
                    <td className="px-3 sm:px-6 py-3">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => setPreview(r)}
                          title="Preview route on map"
                          className="text-muted hover:text-text px-1.5 py-1 rounded hover:bg-panel2 text-xs"
                        >
                          🗺
                        </button>
                        {confirmId === r.id ? (
                          <button
                            onClick={() => handleDelete(r)}
                            disabled={deletingId === r.id}
                            className="text-bad hover:text-bad/80 px-2 py-1 rounded bg-bad/10 text-xs font-semibold"
                          >
                            {deletingId === r.id ? '…' : 'Sure?'}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleDelete(r)}
                            title="Delete route"
                            className="text-muted hover:text-bad px-1.5 py-1 rounded hover:bg-panel2 text-xs"
                          >
                            🗑
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>

      {preview ? (
        <RoutePreviewModal
          route={preview}
          zoneName={zoneMap[preview.zone_id]}
          onClose={() => setPreview(null)}
        />
      ) : null}
    </div>
  );
}
