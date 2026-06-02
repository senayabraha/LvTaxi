import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import StatusBadge from '../components/StatusBadge.jsx';
import MetricStrip from '../components/MetricStrip.jsx';
import FilterBar from '../components/FilterBar.jsx';

// Presence TTL mirrors PRESENCE_TTL_SECONDS (90s) used elsewhere.
const ONLINE_MS = 90 * 1000;
// A driver with presence older than this is "stale" rather than online.
const STALE_WINDOW_MS = 30 * 60 * 1000;

function presenceState(presence) {
  const iso = presence?.last_ping_at;
  if (!iso) return 'offline';
  const age = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(age)) return 'offline';
  if (age <= ONLINE_MS) return 'online';
  if (age <= STALE_WINDOW_MS) return 'stale';
  return 'offline';
}

function formatTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATE_TONE = { online: 'good', stale: 'warn', offline: 'muted' };

export default function DriversPage() {
  const [drivers, setDrivers] = useState([]);
  const [presence, setPresence] = useState({}); // driver_id -> presence row
  const [zoneMap, setZoneMap] = useState({}); // zone_id -> name
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [presenceWarning, setPresenceWarning] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setPresenceWarning(null);

    const [dRes, pRes, zRes] = await Promise.all([
      supabase.from('drivers').select('*'),
      supabase.from('driver_presence').select('*'),
      supabase.from('staging_zones').select('id, name'),
    ]);

    if (dRes.error) {
      // Most likely RLS: a non-admin can only read their own row.
      setError(dRes.error.message);
      setDrivers([]);
    } else {
      setDrivers(dRes.data ?? []);
    }

    const pMap = {};
    if (pRes.error) {
      // driver_presence is optional — degrade gracefully.
      setPresenceWarning(pRes.error.message);
    } else {
      for (const p of pRes.data ?? []) pMap[p.driver_id] = p;
    }
    setPresence(pMap);

    const zMap = {};
    for (const z of zRes.data ?? []) zMap[z.id] = z.name;
    setZoneMap(zMap);

    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Only render the App Version column if the drivers table actually has it.
  const hasAppVersion = useMemo(
    () => drivers.some((d) => Object.prototype.hasOwnProperty.call(d, 'app_version')),
    [drivers]
  );

  const rows = useMemo(() => {
    return drivers.map((d) => {
      const p = presence[d.id] ?? null;
      return { driver: d, presence: p, state: presenceState(p) };
    });
  }, [drivers, presence]);

  const filtered = useMemo(() => {
    let list = rows;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((r) => {
        const d = r.driver;
        return (
          (d.full_name ?? '').toLowerCase().includes(q) ||
          (d.email ?? '').toLowerCase().includes(q) ||
          (d.phone ?? '').toLowerCase().includes(q)
        );
      });
    }
    if (filter === 'online') list = list.filter((r) => r.state === 'online');
    else if (filter === 'stale') list = list.filter((r) => r.state === 'stale');
    else if (filter === 'off_duty')
      list = list.filter((r) => r.driver.status === 'off_duty');
    else if (filter === 'admin') list = list.filter((r) => r.driver.role === 'admin');
    else if (filter === 'driver') list = list.filter((r) => r.driver.role === 'driver');
    return list;
  }, [rows, filter, search]);

  const summary = useMemo(() => {
    let online = 0;
    let staged = 0;
    let stale = 0;
    let admins = 0;
    for (const r of rows) {
      if (r.state === 'online') online += 1;
      if (r.state === 'stale') stale += 1;
      if (
        r.driver.status === 'staged' ||
        r.presence?.classification === 'STAGING'
      )
        staged += 1;
      if (r.driver.role === 'admin') admins += 1;
    }
    return { online, staged, stale, admins };
  }, [rows]);

  const FILTERS = [
    { k: 'all', label: 'All' },
    { k: 'online', label: 'Online' },
    { k: 'stale', label: 'Stale' },
    { k: 'off_duty', label: 'Off Duty' },
    { k: 'admin', label: 'Admin' },
    { k: 'driver', label: 'Driver' },
  ];

  const filterLabel = FILTERS.find((f) => f.k === filter)?.label ?? 'All';
  const filterSummary = `${filterLabel}${search.trim() ? ` · "${search.trim()}"` : ''}`;

  return (
    <div className="flex flex-col h-full">
      {/* Collapsible filters */}
      <FilterBar summary={filterSummary}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name / email / phone…"
          className="bg-panel2 border border-border rounded h-7 px-2 text-text text-xs w-44 sm:w-56"
        />
        <div className="flex items-center gap-1.5 text-xs flex-wrap">
          <span className="text-muted">Filter:</span>
          {FILTERS.map((f) => (
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
        <button
          onClick={load}
          className="ml-auto bg-accent text-bg font-semibold px-3 py-1.5 rounded text-xs whitespace-nowrap"
        >
          ↻ Refresh
        </button>
      </FilterBar>

      {presenceWarning ? (
        <div className="bg-warn/20 text-warn px-3 sm:px-6 py-2 text-sm">
          Presence data unavailable — live/stale status may be incomplete.
        </div>
      ) : null}

      {/* Summary metrics */}
      <MetricStrip
        items={[
          { label: 'Online', value: summary.online, tone: 'good' },
          { label: 'Staged', value: summary.staged, tone: 'accent' },
          {
            label: 'Stale',
            value: summary.stale,
            tone: summary.stale > 0 ? 'warn' : 'text',
          },
          { label: 'Admins', value: summary.admins },
        ]}
      />

      <main className="flex-1 overflow-auto">
        {error ? (
          <div className="bg-bad/20 text-bad px-3 sm:px-6 py-3 text-sm">
            Could not load drivers: {error}
            <div className="text-muted text-xs mt-1">
              The <code>drivers</code> table is RLS-protected. Admin reads
              require the <code>admin_read_all</code> policy (migration 001) and
              your account must have <code>drivers.role = 'admin'</code>.
            </div>
          </div>
        ) : loading && drivers.length === 0 ? (
          <div className="text-muted text-center py-12">Loading drivers…</div>
        ) : filtered.length === 0 ? (
          <div className="text-muted text-center py-12">
            No drivers match the current filters.
          </div>
        ) : (
          <>
            {/* Mobile: card rows */}
            <div className="sm:hidden divide-y divide-border">
              {filtered.map(({ driver: d, presence: p, state }) => {
                const zoneId = p?.current_zone_id ?? d.current_zone_id;
                return (
                  <div key={d.id} className="px-3 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <StatusBadge tone={STATE_TONE[state]}>{state}</StatusBadge>
                        <span className="text-text font-medium truncate">
                          {d.full_name ?? '—'}
                        </span>
                      </div>
                      {d.role === 'admin' ? (
                        <StatusBadge tone="accent">admin</StatusBadge>
                      ) : (
                        <span className="text-muted text-xs">driver</span>
                      )}
                    </div>
                    <div className="text-muted text-xs mt-1 truncate">
                      {d.email || d.phone || '—'}
                    </div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-xs text-muted">
                      <div>Status: <span className="text-text">{d.status ?? '—'}</span></div>
                      <div>Zone: <span className="text-text">{zoneId ? zoneMap[zoneId] ?? '—' : '—'}</span></div>
                      <div>Class: <span className="text-text">{p?.classification ?? '—'}</span></div>
                      <div>Ping: <span className="text-text">{formatTime(p?.last_ping_at)}</span></div>
                      <div>Seen: <span className="text-text">{formatTime(d.last_seen)}</span></div>
                      <div>
                        Acc/Spd:{' '}
                        <span className="text-text">
                          {p?.accuracy != null ? `${Math.round(p.accuracy)}m` : '—'} /{' '}
                          {p?.speed != null ? `${Math.round(p.speed)}` : '—'}
                        </span>
                      </div>
                      {hasAppVersion ? (
                        <div>App: <span className="text-text">{d.app_version ?? '—'}</span></div>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop: table */}
            <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 1040 }}>
              <thead className="sticky top-0 bg-bg border-b border-border">
                <tr className="text-muted text-xs uppercase tracking-wide">
                  <th className="text-left px-3 sm:px-6 py-3">Driver</th>
                  <th className="text-left px-2 sm:px-3 py-3">Contact</th>
                  <th className="text-left px-2 sm:px-3 py-3">Role</th>
                  <th className="text-left px-2 sm:px-3 py-3">Status</th>
                  <th className="text-left px-2 sm:px-3 py-3">Zone</th>
                  <th className="text-left px-2 sm:px-3 py-3">Class</th>
                  <th className="text-right px-2 sm:px-3 py-3">Last Seen</th>
                  <th className="text-right px-2 sm:px-3 py-3">Last Ping</th>
                  <th className="text-right px-2 sm:px-3 py-3">Accuracy</th>
                  <th className="text-right px-2 sm:px-3 py-3">Speed</th>
                  {hasAppVersion ? (
                    <th className="text-left px-2 sm:px-3 py-3">App</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {filtered.map(({ driver: d, presence: p, state }) => {
                  const zoneId = p?.current_zone_id ?? d.current_zone_id;
                  return (
                    <tr key={d.id} className="border-b border-border hover:bg-panel/50">
                      <td className="px-3 sm:px-6 py-3 text-text font-medium">
                        <div className="flex items-center gap-2">
                          <StatusBadge tone={STATE_TONE[state]}>{state}</StatusBadge>
                          <span>{d.full_name ?? '—'}</span>
                        </div>
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-muted text-xs">
                        {d.email || d.phone || '—'}
                      </td>
                      <td className="px-2 sm:px-3 py-3">
                        {d.role === 'admin' ? (
                          <StatusBadge tone="accent">admin</StatusBadge>
                        ) : (
                          <span className="text-muted text-xs">driver</span>
                        )}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-muted text-xs">
                        {d.status ?? '—'}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-muted text-xs">
                        {zoneId ? zoneMap[zoneId] ?? '—' : '—'}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-muted text-xs">
                        {p?.classification ?? '—'}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-right text-muted text-xs whitespace-nowrap">
                        {formatTime(d.last_seen)}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-right text-muted text-xs whitespace-nowrap">
                        {formatTime(p?.last_ping_at)}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-right tabular-nums text-muted text-xs">
                        {p?.accuracy != null ? `${Math.round(p.accuracy)}m` : '—'}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-right tabular-nums text-muted text-xs">
                        {p?.speed != null ? `${Math.round(p.speed)}` : '—'}
                      </td>
                      {hasAppVersion ? (
                        <td className="px-2 sm:px-3 py-3 text-muted text-xs">
                          {d.app_version ?? '—'}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
