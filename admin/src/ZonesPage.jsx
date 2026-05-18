import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from './supabase.js';
import ZoneTable from './ZoneTable.jsx';
import UploadModal from './UploadModal.jsx';
import { regenerateSnapshot } from './lib/zoneStore.js';

export default function ZonesPage({ onCounts }) {
  const [zones, setZones] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('name');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [zRes, sRes] = await Promise.all([
      supabase.from('staging_zones').select('*').order('name'),
      supabase.from('zone_stats').select('*'),
    ]);
    if (zRes.error) setError(zRes.error.message);
    if (sRes.error) setError(sRes.error.message);
    setZones(zRes.data ?? []);
    const map = {};
    for (const s of sRes.data ?? []) map[s.zone_id] = s;
    setStats(map);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
    const ch = supabase
      .channel('admin_zone_stats')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'zone_stats' },
        (payload) => {
          const row = payload.new ?? payload.old;
          if (!row?.zone_id) return;
          setStats((m) => ({ ...m, [row.zone_id]: payload.new ?? null }));
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'staging_zones' },
        () => load()
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [load]);

  // Bubble counts up so the global header can show them.
  useEffect(() => {
    if (!onCounts) return;
    onCounts({
      total: zones.length,
      active: zones.filter((z) => z.active && !z.is_coming_soon).length,
      coming: zones.filter((z) => z.is_coming_soon).length,
    });
  }, [zones, onCounts]);

  const filtered = useMemo(() => {
    let list = zones.slice();
    if (filter === 'active')
      list = list.filter((z) => z.active && !z.is_coming_soon);
    else if (filter === 'coming') list = list.filter((z) => z.is_coming_soon);
    else if (filter === 'phaseA')
      list = list.filter((z) => z.drawn_polygon && !z.use_driven_polygon);
    else if (filter === 'phaseB') list = list.filter((z) => z.use_driven_polygon);

    if (sortBy === 'cars') {
      list.sort(
        (a, b) =>
          (stats[b.id]?.cars_staged ?? 0) - (stats[a.id]?.cars_staged ?? 0)
      );
    } else if (sortBy === 'wait') {
      list.sort((a, b) => {
        const aw = stats[a.id]?.wait_time_minutes ?? Number.POSITIVE_INFINITY;
        const bw = stats[b.id]?.wait_time_minutes ?? Number.POSITIVE_INFINITY;
        return aw - bw;
      });
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return list;
  }, [zones, stats, filter, sortBy]);

  async function updateZone(zoneId, patch) {
    setZones((zs) => zs.map((z) => (z.id === zoneId ? { ...z, ...patch } : z)));
    const { error: err } = await supabase
      .from('staging_zones')
      .update(patch)
      .eq('id', zoneId);
    if (err) {
      setError(err.message);
      load();
      return;
    }
    regenerateSnapshot().catch((e) =>
      console.warn('[ZonesPage] snapshot regen after toggle failed', e)
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 sm:px-6 py-3 border-b border-border bg-panel/40">
        <div className="flex items-center gap-1.5 text-xs flex-wrap">
          <span className="text-muted">Filter:</span>
          {[
            { k: 'all', label: 'All' },
            { k: 'active', label: 'Active' },
            { k: 'coming', label: 'Coming Soon' },
            { k: 'phaseA', label: 'Phase A' },
            { k: 'phaseB', label: 'Phase B' },
          ].map((f) => (
            <button
              key={f.k}
              onClick={() => setFilter(f.k)}
              className={`px-2 py-1 rounded ${
                filter === f.k
                  ? 'bg-accent text-bg'
                  : 'bg-panel border border-border text-muted hover:text-text'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5 text-xs flex-wrap">
          <span className="text-muted">Sort:</span>
          {[
            { k: 'name', label: 'Name' },
            { k: 'cars', label: 'Cars' },
            { k: 'wait', label: 'Wait' },
          ].map((s) => (
            <button
              key={s.k}
              onClick={() => setSortBy(s.k)}
              className={`px-2 py-1 rounded ${
                sortBy === s.k
                  ? 'bg-accent text-bg'
                  : 'bg-panel border border-border text-muted hover:text-text'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowUpload(true)}
          className="ml-auto bg-accent text-bg font-semibold px-3 py-1.5 rounded text-xs whitespace-nowrap"
        >
          📂 Upload GeoJSON
        </button>
      </div>

      <main className="flex-1 overflow-auto">
        {error ? (
          <div className="bg-bad/20 text-bad px-6 py-2 text-sm">{error}</div>
        ) : null}
        {loading && zones.length === 0 ? (
          <div className="text-muted text-center py-12">Loading zones…</div>
        ) : (
          <ZoneTable zones={filtered} stats={stats} onUpdate={updateZone} />
        )}
      </main>

      {showUpload ? (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onDone={() => {
            setShowUpload(false);
            load();
          }}
        />
      ) : null}
    </div>
  );
}
