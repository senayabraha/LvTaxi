import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { supabase } from './supabase.js';
import ZoneTable from './ZoneTable.jsx';
import UploadModal from './UploadModal.jsx';
import ZoneMapModal from './ZoneMapModal.jsx';
import ZoneCircleModal from './ZoneCircleModal.jsx';
import AddZoneModal from './AddZoneModal.jsx';
import ZoneVersionsModal from './ZoneVersionsModal.jsx';
import FilterBar from './components/FilterBar.jsx';
import WorkAreaMapModal from './WorkAreaMapModal.jsx';
import { updateZoneFields, deleteZone, regenerateSnapshot } from './lib/zoneStore.js';
import { getWaitMinutes } from './lib/zoneHealth.js';
import { useToast } from './useToast.jsx';

function WorkAreaSection() {
  const toast = useToast();
  const fileRef = useRef(null);
  const [workArea, setWorkArea] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [showMap, setShowMap] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('work_areas')
      .select('id, name, created_at, active, polygon')
      .eq('active', true)
      .order('updated_at', { ascending: false })
      .limit(1);
    if (error) {
      toast(error.message, 'error');
      setWorkArea(null);
    } else {
      setWorkArea(data?.[0] ?? null);
    }
    setLoading(false);
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleFile(file) {
    if (!file) return;
    if (!/\.(geo)?json$/i.test(file.name)) {
      toast('Pick a .geojson or .json file.', 'error');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast('File is not valid JSON.', 'error');
      return;
    }

    let polygon = null;
    let derivedName = workArea?.name ?? 'Las Vegas Work Area';
    if (parsed?.type === 'FeatureCollection' && Array.isArray(parsed.features)) {
      const feat = parsed.features.find(
        (f) => f?.geometry?.type === 'Polygon' || f?.geometry?.type === 'MultiPolygon'
      );
      if (feat) {
        polygon = feat;
        if (feat.properties?.name || feat.properties?.Name) {
          derivedName = feat.properties.name ?? feat.properties.Name;
        }
      }
    } else if (parsed?.type === 'Feature') {
      polygon = parsed;
      if (parsed.properties?.name) derivedName = parsed.properties.name;
    } else if (parsed?.type === 'Polygon' || parsed?.type === 'MultiPolygon') {
      polygon = { type: 'Feature', geometry: parsed, properties: {} };
    }

    if (!polygon) {
      toast('No Polygon or MultiPolygon found in the file.', 'error');
      return;
    }

    setUploading(true);
    try {
      const sess = await supabase.auth.getSession();
      const createdBy = sess.data.session?.user?.id ?? null;

      if (workArea?.id) {
        const { error } = await supabase
          .from('work_areas')
          .update({
            polygon,
            name: derivedName,
            updated_at: new Date().toISOString(),
          })
          .eq('id', workArea.id);
        if (error) throw error;
      } else {
        const { error } = await supabase
          .from('work_areas')
          .insert({
            name: derivedName,
            polygon,
            active: true,
            created_by: createdBy,
          });
        if (error) throw error;
      }
      toast('Work area updated', 'success');
      await load();
    } catch (err) {
      toast(err.message ?? 'Upload failed', 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const buttonLabel = workArea ? 'Replace GeoJSON' : 'Upload Work Area GeoJSON';

  function downloadGeoJSON() {
    if (!workArea?.polygon) return;
    const fc = { type: 'FeatureCollection', features: [workArea.polygon] };
    const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${workArea.name ?? 'work_area'}.geojson`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="px-3 sm:px-6 py-4 border-b border-border bg-panel/30">
        <div className="flex items-start sm:items-center justify-between flex-wrap gap-3">
          <div>
            <div className="text-text font-semibold">Work Area Geofence</div>
            {loading ? (
              <div className="text-muted text-xs mt-1">Loading…</div>
            ) : workArea ? (
              <div className="text-muted text-xs mt-1 flex items-center gap-2">
                <span className="text-text">{workArea.name}</span>
                <span>·</span>
                <span>
                  created {new Date(workArea.created_at).toLocaleDateString()}
                </span>
                <span className="bg-good/20 text-good px-2 py-0.5 rounded text-[10px] font-medium">
                  Active
                </span>
              </div>
            ) : (
              <div className="text-muted text-xs mt-1">No work area configured</div>
            )}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {workArea?.polygon && (
              <>
                <button
                  onClick={() => setShowMap(true)}
                  className="px-3 py-1.5 rounded text-xs font-semibold bg-panel2 border border-border text-text hover:opacity-80"
                >
                  View Map
                </button>
                <button
                  onClick={downloadGeoJSON}
                  className="px-3 py-1.5 rounded text-xs font-semibold bg-panel2 border border-border text-text hover:opacity-80"
                >
                  Download GeoJSON
                </button>
              </>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".geojson,.json,application/geo+json,application/json"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className={`px-3 py-1.5 rounded text-xs font-semibold ${
                uploading
                  ? 'bg-accent/60 text-bg'
                  : 'bg-accent text-bg hover:opacity-90'
              }`}
            >
              {uploading ? 'Uploading…' : buttonLabel}
            </button>
          </div>
        </div>
      </div>
      {showMap && workArea?.polygon && (
        <WorkAreaMapModal workArea={workArea} onClose={() => setShowMap(false)} />
      )}
    </>
  );
}

function exportCSV(zones, stats) {
  const headers = [
    'name', 'phase', 'active', 'is_coming_soon', 'visible_to_drivers',
    'cars_staged', 'wait_time_minutes', 'lat', 'lng', 'radius_meters',
  ];
  const rows = zones.map((z) => {
    const stat = stats[z.id];
    const phase =
      z.use_driven_polygon && z.driven_polygon
        ? 'B'
        : z.drawn_polygon
        ? 'A'
        : 'Circle';
    return [
      JSON.stringify(z.name),
      phase,
      z.active ? '1' : '0',
      z.is_coming_soon ? '1' : '0',
      z.visible_to_drivers ? '1' : '0',
      stat?.cars_staged ?? 0,
      stat?.wait_time_minutes ?? '',
      z.lat,
      z.lng,
      z.radius_meters,
    ].join(',');
  });
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lvtaxi-zones-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function exportGeoJSON(zones) {
  const features = zones
    .filter((z) => z.drawn_polygon || z.driven_polygon)
    .map((z) => {
      const f =
        z.use_driven_polygon && z.driven_polygon
          ? z.driven_polygon
          : z.drawn_polygon;
      return {
        type: 'Feature',
        geometry: f.geometry ?? f,
        properties: {
          ...(f.properties ?? {}),
          id: z.id,
          name: z.name,
          phase: z.use_driven_polygon && z.driven_polygon ? 'B' : 'A',
          is_coming_soon: z.is_coming_soon,
          active: z.active,
        },
      };
    });
  const fc = {
    type: 'FeatureCollection',
    generated_at: new Date().toISOString(),
    features,
  };
  const blob = new Blob([JSON.stringify(fc, null, 2)], {
    type: 'application/geo+json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `lvtaxi-zones-${new Date().toISOString().slice(0, 10)}.geojson`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function ZonesPage({ onCounts }) {
  const toast = useToast();
  const [zones, setZones] = useState([]);
  const [stats, setStats] = useState({});
  const [loading, setLoading] = useState(true);
  const [zoneError, setZoneError] = useState(null);
  const [statsError, setStatsError] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [showAddZone, setShowAddZone] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [previewZone, setPreviewZone] = useState(null);
  const [editCircleZone, setEditCircleZone] = useState(null);
  const [filter, setFilter] = useState('all');
  const [sortBy, setSortBy] = useState('name');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setZoneError(null);
    setStatsError(null);
    // Pull zones + legacy stats, plus the rich live-stats RPC (best-effort).
    // The RPC adds estimated_wait_*, wait_confidence and wait_status used for
    // the per-row health badge; if it fails we silently keep zone_stats only.
    const [zRes, sRes, liveRes] = await Promise.all([
      supabase.from('staging_zones').select('*').order('name'),
      supabase.from('zone_stats').select('*'),
      supabase.rpc('get_zone_live_stats'),
    ]);
    if (zRes.error) setZoneError(zRes.error.message);
    if (sRes.error) setStatsError(sRes.error.message);
    setZones(zRes.data ?? []);
    const map = {};
    for (const s of sRes.data ?? []) map[s.zone_id] = s;
    // Merge rich live fields on top of legacy stats when available.
    if (!liveRes.error && Array.isArray(liveRes.data)) {
      for (const l of liveRes.data) {
        map[l.zone_id] = { ...(map[l.zone_id] ?? {}), ...l };
      }
    }
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
          // Merge so rich live-stat fields from the RPC survive realtime
          // zone_stats pushes (cars/wait_time update; confidence persists).
          setStats((m) =>
            payload.new
              ? { ...m, [row.zone_id]: { ...m[row.zone_id], ...payload.new } }
              : { ...m, [row.zone_id]: null }
          );
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

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((z) => z.name.toLowerCase().includes(q));
    }

    if (filter === 'active')
      list = list.filter((z) => z.active && !z.is_coming_soon);
    else if (filter === 'coming') list = list.filter((z) => z.is_coming_soon);
    else if (filter === 'phaseA')
      list = list.filter((z) => z.drawn_polygon && !z.use_driven_polygon);
    else if (filter === 'phaseB')
      list = list.filter((z) => z.use_driven_polygon);

    if (sortBy === 'cars') {
      list.sort(
        (a, b) =>
          (stats[b.id]?.cars_staged ?? 0) - (stats[a.id]?.cars_staged ?? 0)
      );
    } else if (sortBy === 'wait') {
      list.sort((a, b) => {
        const aw = getWaitMinutes(stats[a.id]) ?? Number.POSITIVE_INFINITY;
        const bw = getWaitMinutes(stats[b.id]) ?? Number.POSITIVE_INFINITY;
        return aw - bw;
      });
    } else {
      list.sort((a, b) => a.name.localeCompare(b.name));
    }
    return list;
  }, [zones, stats, filter, sortBy, search]);

  async function handleUpdateZone(zone, patch) {
    // Optimistic update
    setZones((zs) => zs.map((z) => (z.id === zone.id ? { ...z, ...patch } : z)));
    try {
      await updateZoneFields(zone, patch);
    } catch (err) {
      toast(err.message ?? 'Update failed', 'error');
      load();
    }
  }

  async function handleDeleteZone(zoneId, zoneName) {
    try {
      await deleteZone(zoneId, zoneName);
      setZones((zs) => zs.filter((z) => z.id !== zoneId));
      toast(`"${zoneName}" deleted`, 'success');
    } catch (err) {
      toast(err.message ?? 'Delete failed', 'error');
    }
  }

  async function handleExportGeoJSON() {
    try {
      exportGeoJSON(zones);
      toast('GeoJSON downloaded', 'success');
    } catch (err) {
      toast('Export failed: ' + err.message, 'error');
    }
  }

  function handleExportCSV() {
    exportCSV(zones, stats);
    toast('CSV downloaded', 'success');
  }

  const filterLabels = {
    all: 'All',
    active: 'Active',
    coming: 'Coming Soon',
    phaseA: 'Phase A',
    phaseB: 'Phase B',
  };
  const sortLabels = { name: 'Name', cars: 'Cars', wait: 'Wait' };
  const zonesSummary = `${filterLabels[filter] ?? 'All'} · Sort: ${sortLabels[sortBy] ?? 'Name'}`;

  return (
    <div className="flex flex-col h-full">
      <WorkAreaSection />

      {/* Collapsible toolbar */}
      <FilterBar summary={zonesSummary}>
        {/* Search */}
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search zones…"
          className="bg-panel2 border border-border rounded h-7 px-2 text-text text-xs w-36 sm:w-48"
        />

        {/* Filters */}
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

        {/* Sort */}
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

        {/* Right-side actions */}
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={handleExportCSV}
            className="bg-panel border border-border text-muted px-2.5 py-1.5 rounded text-xs hover:text-text whitespace-nowrap"
            title="Download zones as CSV"
          >
            ⬇ CSV
          </button>
          <button
            onClick={handleExportGeoJSON}
            className="bg-panel border border-border text-muted px-2.5 py-1.5 rounded text-xs hover:text-text whitespace-nowrap"
            title="Download zones as GeoJSON"
          >
            ⬇ GeoJSON
          </button>
          <button
            onClick={() => setShowVersions(true)}
            className="bg-panel border border-border text-muted px-3 py-1.5 rounded text-xs hover:text-text whitespace-nowrap"
            title="Snapshot the current zone config / view history"
          >
            🗂 Versions
          </button>
          <button
            onClick={() => setShowAddZone(true)}
            className="bg-panel border border-border text-muted px-3 py-1.5 rounded text-xs hover:text-text whitespace-nowrap"
          >
            + Add Zone
          </button>
          <button
            onClick={() => setShowUpload(true)}
            className="bg-accent text-bg font-semibold px-3 py-1.5 rounded text-xs whitespace-nowrap"
          >
            📂 Upload GeoJSON
          </button>
        </div>
      </FilterBar>

      <main className="flex-1 overflow-auto">
        {zoneError ? (
          <div className="bg-bad/20 text-bad px-6 py-2 text-sm">
            Zones error: {zoneError}
          </div>
        ) : null}
        {statsError ? (
          <div className="bg-warn/20 text-warn px-6 py-2 text-sm">
            Stats error: {statsError}
          </div>
        ) : null}
        {loading && zones.length === 0 ? (
          <div className="text-muted text-center py-12">Loading zones…</div>
        ) : (
          <ZoneTable
            zones={filtered}
            stats={stats}
            onUpdate={handleUpdateZone}
            onDelete={handleDeleteZone}
            onPreview={setPreviewZone}
            onEditCircle={setEditCircleZone}
          />
        )}
      </main>

      {showUpload ? (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onDone={() => {
            setShowUpload(false);
            load();
            toast('Zones imported successfully', 'success');
          }}
        />
      ) : null}

      {showVersions ? (
        <ZoneVersionsModal
          onClose={() => setShowVersions(false)}
          onRestored={load}
        />
      ) : null}

      {showAddZone ? (
        <AddZoneModal
          onClose={() => setShowAddZone(false)}
          onDone={() => {
            setShowAddZone(false);
            load();
            toast('Zone created', 'success');
          }}
        />
      ) : null}

      {previewZone ? (
        <ZoneMapModal
          zone={previewZone}
          onClose={() => setPreviewZone(null)}
        />
      ) : null}

      {editCircleZone ? (
        <ZoneCircleModal
          zone={editCircleZone}
          onClose={() => setEditCircleZone(null)}
          onSaved={() => { setEditCircleZone(null); load(); }}
        />
      ) : null}
    </div>
  );
}
