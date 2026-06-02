import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '../supabase.js';
import StatusBadge, { HealthBadge } from '../components/StatusBadge.jsx';
import MetricStrip from '../components/MetricStrip.jsx';
import {
  computeZoneHealth,
  getWaitMinutes,
  phaseOf,
  isStale,
} from '../lib/zoneHealth.js';

const AUTO_REFRESH_MS = 15000;

function formatWait(mins) {
  if (mins == null) return '—';
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

function formatRange(stat) {
  const lo = stat?.estimated_wait_min;
  const hi = stat?.estimated_wait_max;
  if (lo == null || hi == null) return '—';
  return `${Math.round(lo)}–${Math.round(hi)} min`;
}

function formatTime(iso) {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const ms = Date.now() - t;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const CONFIDENCE_TONE = {
  HIGH: 'good',
  MEDIUM: 'accent',
  LOW: 'warn',
  INSUFFICIENT_DATA: 'muted',
};

const STATUS_TONE = {
  OK: 'good',
  NO_RECENT_MOVEMENT: 'warn',
  INSUFFICIENT_DATA: 'muted',
};

const STATUS_HINTS = {
  OK: 'Wait estimate is being produced normally',
  NO_RECENT_MOVEMENT: 'Cars are staged but no departures observed recently',
  INSUFFICIENT_DATA: 'Not enough data to estimate a wait',
};

const CONFIDENCE_HINTS = {
  HIGH: 'Dwell and queue estimates agree on a large sample',
  MEDIUM: 'Estimate based on a single signal or moderate sample',
  LOW: 'Small sample or slow service rate — treat as approximate',
  INSUFFICIENT_DATA: 'No wait estimate available',
};

export default function LiveOpsPage() {
  const [zones, setZones] = useState([]);
  const [stats, setStats] = useState({}); // keyed by zone_id
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fallback, setFallback] = useState(false); // true when RPC failed
  const [lastRefresh, setLastRefresh] = useState(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    // Zones are always read from staging_zones.
    const zonesReq = supabase.from('staging_zones').select('*').order('name');

    // Prefer the rich live-stats RPC; fall back to zone_stats on failure.
    const rpcReq = supabase.rpc('get_zone_live_stats');

    const [zRes, rpcRes] = await Promise.all([zonesReq, rpcReq]);

    if (!mountedRef.current) return;

    if (zRes.error) {
      setError(zRes.error.message);
      setLoading(false);
      return;
    }
    setZones(zRes.data ?? []);

    let statMap = {};
    if (rpcRes.error || !Array.isArray(rpcRes.data)) {
      // Graceful fallback to legacy zone_stats.
      setFallback(true);
      const { data: legacy } = await supabase.from('zone_stats').select('*');
      for (const s of legacy ?? []) statMap[s.zone_id] = s;
    } else {
      setFallback(false);
      for (const s of rpcRes.data) statMap[s.zone_id] = s;
    }

    if (!mountedRef.current) return;
    setStats(statMap);
    setLastRefresh(new Date());
    setLoading(false);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    // Polling auto-refresh — intentionally NOT a realtime channel to avoid
    // piling up subscriptions alongside the Zones page.
    const id = setInterval(load, AUTO_REFRESH_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [load]);

  // Rows = active-aware merge of zones + stats with computed health.
  const rows = useMemo(() => {
    return zones
      .map((z) => {
        const stat = stats[z.id] ?? null;
        const { health, reasons } = computeZoneHealth(z, stat);
        return { zone: z, stat, health, reasons };
      })
      .sort((a, b) => {
        // Surface problems first: CRITICAL > WARNING > others, then by cars.
        const rank = { CRITICAL: 0, WARNING: 1, GOOD: 2, UNKNOWN: 3 };
        const r = (rank[a.health] ?? 3) - (rank[b.health] ?? 3);
        if (r !== 0) return r;
        return (b.stat?.cars_staged ?? 0) - (a.stat?.cars_staged ?? 0);
      });
  }, [zones, stats]);

  const summary = useMemo(() => {
    let activeZones = 0;
    let totalCars = 0;
    let zonesWithCars = 0;
    let lowConfidence = 0;
    let stale = 0;
    for (const z of zones) {
      const active = !!z.active && !z.is_coming_soon;
      if (active) activeZones += 1;
      const stat = stats[z.id];
      const cars = stat?.cars_staged ?? 0;
      totalCars += cars;
      if (cars > 0) zonesWithCars += 1;
      const conf = stat?.wait_confidence;
      if (conf === 'LOW' || conf === 'INSUFFICIENT_DATA') lowConfidence += 1;
      if (isStale(stat) || stat?.wait_status === 'NO_RECENT_MOVEMENT') stale += 1;
    }
    return { activeZones, totalCars, zonesWithCars, lowConfidence, stale };
  }, [zones, stats]);

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-3 sm:px-6 py-3 border-b border-border bg-panel/40">
        <div className="text-text font-semibold">Zone Health</div>
        <div className="text-muted text-xs">
          {lastRefresh ? `Updated ${formatTime(lastRefresh.toISOString())}` : '—'}
          {' · auto-refresh 15s'}
        </div>
        <button
          onClick={load}
          className="ml-auto bg-accent text-bg font-semibold px-3 py-1.5 rounded text-xs whitespace-nowrap"
        >
          ↻ Refresh
        </button>
      </div>

      {fallback ? (
        <div className="bg-warn/20 text-warn px-3 sm:px-6 py-2 text-sm">
          Live stats RPC unavailable — showing legacy zone_stats. Wait
          confidence and ranges may be missing.
        </div>
      ) : null}
      {error ? (
        <div className="bg-bad/20 text-bad px-3 sm:px-6 py-2 text-sm">
          Error loading live ops: {error}
        </div>
      ) : null}

      {/* Summary metrics — pills on mobile, cards on desktop */}
      <MetricStrip
        items={[
          { label: 'Active', value: summary.activeZones, tone: 'accent' },
          { label: 'Cars', value: summary.totalCars, tone: 'good' },
          { label: 'With Cars', value: summary.zonesWithCars },
          {
            label: 'Low Conf',
            value: summary.lowConfidence,
            tone: summary.lowConfidence > 0 ? 'warn' : 'text',
            hint: 'Low / insufficient',
          },
          {
            label: 'Stale',
            value: summary.stale,
            tone: summary.stale > 0 ? 'bad' : 'text',
          },
        ]}
      />

      {/* Table */}
      <main className="flex-1 overflow-auto">
        {loading && zones.length === 0 ? (
          <div className="text-muted text-center py-12">Loading live ops…</div>
        ) : rows.length === 0 ? (
          <div className="text-muted text-center py-12">No zones found.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 980 }}>
              <thead className="sticky top-0 bg-bg border-b border-border">
                <tr className="text-muted text-xs uppercase tracking-wide">
                  <th className="text-left px-3 sm:px-6 py-3">Zone</th>
                  <th className="text-right px-2 sm:px-3 py-3">Cars</th>
                  <th className="text-right px-2 sm:px-3 py-3">Est. Wait</th>
                  <th className="text-right px-2 sm:px-3 py-3">Wait Range</th>
                  <th className="text-center px-2 sm:px-3 py-3">Confidence</th>
                  <th className="text-center px-2 sm:px-3 py-3">Status</th>
                  <th className="text-right px-2 sm:px-3 py-3">Last Updated</th>
                  <th className="text-center px-2 sm:px-3 py-3">Active</th>
                  <th className="text-center px-2 sm:px-3 py-3">Visible</th>
                  <th className="text-center px-2 sm:px-3 py-3">Phase</th>
                  <th className="text-center px-3 sm:px-6 py-3">Health</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ zone, stat, health, reasons }) => {
                  const conf = stat?.wait_confidence;
                  const status = stat?.wait_status;
                  return (
                    <tr
                      key={zone.id}
                      className="border-b border-border hover:bg-panel/50"
                    >
                      <td className="px-3 sm:px-6 py-3 text-text font-medium">
                        {zone.name}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-right tabular-nums">
                        {stat?.cars_staged ?? 0}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-right tabular-nums">
                        {formatWait(getWaitMinutes(stat))}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-right tabular-nums text-muted text-xs">
                        {formatRange(stat)}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-center">
                        {conf ? (
                          <StatusBadge
                            tone={CONFIDENCE_TONE[conf] ?? 'muted'}
                            title={CONFIDENCE_HINTS[conf]}
                          >
                            {conf.replace('_', ' ')}
                          </StatusBadge>
                        ) : (
                          <span className="text-muted text-xs">—</span>
                        )}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-center">
                        {status ? (
                          <StatusBadge
                            tone={STATUS_TONE[status] ?? 'muted'}
                            title={STATUS_HINTS[status]}
                          >
                            {status.replace(/_/g, ' ')}
                          </StatusBadge>
                        ) : (
                          <span className="text-muted text-xs">—</span>
                        )}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-right text-muted text-xs whitespace-nowrap">
                        {formatTime(stat?.last_updated)}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-center">
                        {zone.active && !zone.is_coming_soon ? (
                          <span className="text-good">●</span>
                        ) : (
                          <span className="text-muted">○</span>
                        )}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-center">
                        {zone.visible_to_drivers ? (
                          <span className="text-good">●</span>
                        ) : (
                          <span className="text-muted">○</span>
                        )}
                      </td>
                      <td className="px-2 sm:px-3 py-3 text-center text-xs text-muted">
                        {phaseOf(zone)}
                      </td>
                      <td className="px-3 sm:px-6 py-3 text-center">
                        <HealthBadge health={health} title={reasons.join(' · ')} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
