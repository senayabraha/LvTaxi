import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.js';
import FilterBar from '../components/FilterBar.jsx';

const RESULT_LIMIT = 200;

const RANGES = [
  { k: '24h', label: 'Last 24h', ms: 24 * 60 * 60 * 1000 },
  { k: '7d', label: 'Last 7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { k: '30d', label: 'Last 30d', ms: 30 * 24 * 60 * 60 * 1000 },
  { k: 'all', label: 'All', ms: null },
];

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

// Audit values are stored JSON-stringified; render them compactly.
function renderValue(v) {
  if (v == null) return <span className="text-muted">—</span>;
  let display = v;
  try {
    const parsed = JSON.parse(v);
    display = typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed);
  } catch {
    display = String(v);
  }
  if (display.length > 60) display = display.slice(0, 57) + '…';
  return <span className="text-text">{display}</span>;
}

export default function AuditPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [range, setRange] = useState('7d');
  const [search, setSearch] = useState('');
  const [fieldFilter, setFieldFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    let query = supabase
      .from('zone_audit_log')
      .select('id, zone_id, zone_name, field, old_value, new_value, admin_id, changed_at')
      .order('changed_at', { ascending: false })
      .limit(RESULT_LIMIT);

    const r = RANGES.find((x) => x.k === range);
    if (r?.ms) {
      query = query.gte('changed_at', new Date(Date.now() - r.ms).toISOString());
    }

    const { data, error: err } = await query;
    if (err) {
      // Table missing or RLS blocked — surface a helpful message, don't crash.
      setError(err.message);
      setRows([]);
    } else {
      setRows(data ?? []);
    }
    setLoading(false);
  }, [range]);

  useEffect(() => {
    load();
  }, [load]);

  // Field options derived from the loaded rows.
  const fieldOptions = useMemo(() => {
    const set = new Set();
    for (const r of rows) if (r.field) set.add(r.field);
    return ['all', ...Array.from(set).sort()];
  }, [rows]);

  const filtered = useMemo(() => {
    let list = rows;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter((r) => (r.zone_name ?? '').toLowerCase().includes(q));
    }
    if (fieldFilter !== 'all') {
      list = list.filter((r) => r.field === fieldFilter);
    }
    return list;
  }, [rows, search, fieldFilter]);

  const rangeLabel = RANGES.find((r) => r.k === range)?.label ?? 'All';
  const auditSummary = `${rangeLabel}${fieldFilter !== 'all' ? ` · ${fieldFilter}` : ''}${
    search.trim() ? ` · "${search.trim()}"` : ''
  }`;

  return (
    <div className="flex flex-col h-full">
      {/* Collapsible filters */}
      <FilterBar summary={auditSummary}>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search zone…"
          className="bg-panel2 border border-border rounded h-7 px-2 text-text text-xs w-36 sm:w-48"
        />

        <div className="flex items-center gap-1.5 text-xs flex-wrap">
          <span className="text-muted">Field:</span>
          <select
            value={fieldFilter}
            onChange={(e) => setFieldFilter(e.target.value)}
            className="bg-panel border border-border rounded px-2 py-1 text-text"
          >
            {fieldOptions.map((f) => (
              <option key={f} value={f}>
                {f === 'all' ? 'All fields' : f}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5 text-xs flex-wrap">
          <span className="text-muted">Range:</span>
          {RANGES.map((r) => (
            <button
              key={r.k}
              onClick={() => setRange(r.k)}
              className={`px-2 py-1 rounded ${
                range === r.k
                  ? 'bg-accent text-bg'
                  : 'bg-panel border border-border text-muted hover:text-text'
              }`}
            >
              {r.label}
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

      <main className="flex-1 overflow-auto">
        {error ? (
          <div className="bg-bad/20 text-bad px-3 sm:px-6 py-3 text-sm">
            Could not load the audit log: {error}
            <div className="text-muted text-xs mt-1">
              The <code>zone_audit_log</code> table may not exist yet, or RLS
              may be blocking access. Ensure migration 004 is applied and your
              account has <code>drivers.role = 'admin'</code>.
            </div>
          </div>
        ) : loading && rows.length === 0 ? (
          <div className="text-muted text-center py-12">Loading audit log…</div>
        ) : filtered.length === 0 ? (
          <div className="text-muted text-center py-12">
            No audit entries match the current filters.
          </div>
        ) : (
          <>
            {/* Mobile: card rows */}
            <div className="sm:hidden divide-y divide-border">
              {filtered.map((r) => (
                <div key={r.id} className="px-3 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-text font-medium truncate">{r.zone_name}</span>
                    <span className="text-accent text-xs font-mono shrink-0">{r.field}</span>
                  </div>
                  <div className="text-xs mt-1 flex items-center gap-2">
                    {renderValue(r.old_value)}
                    <span className="text-muted">→</span>
                    {renderValue(r.new_value)}
                  </div>
                  <div className="text-muted text-[11px] mt-1">
                    {formatTime(r.changed_at)}
                    {r.admin_id ? ` · ${r.admin_id.slice(0, 8)}…` : ''}
                  </div>
                </div>
              ))}
              <div className="text-muted text-xs text-center py-3">
                Showing {filtered.length} of up to {RESULT_LIMIT} most recent entries
              </div>
            </div>

            {/* Desktop: table */}
            <div className="hidden sm:block overflow-x-auto">
            <table className="w-full text-sm" style={{ minWidth: 900 }}>
              <thead className="sticky top-0 bg-bg border-b border-border">
                <tr className="text-muted text-xs uppercase tracking-wide">
                  <th className="text-left px-3 sm:px-6 py-3">Time</th>
                  <th className="text-left px-2 sm:px-3 py-3">Zone</th>
                  <th className="text-left px-2 sm:px-3 py-3">Field</th>
                  <th className="text-left px-2 sm:px-3 py-3">Old Value</th>
                  <th className="text-left px-2 sm:px-3 py-3">New Value</th>
                  <th className="text-left px-3 sm:px-6 py-3">Admin ID</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="border-b border-border hover:bg-panel/50">
                    <td className="px-3 sm:px-6 py-3 text-muted text-xs whitespace-nowrap">
                      {formatTime(r.changed_at)}
                    </td>
                    <td className="px-2 sm:px-3 py-3 text-text">{r.zone_name}</td>
                    <td className="px-2 sm:px-3 py-3">
                      <span className="text-accent text-xs font-mono">{r.field}</span>
                    </td>
                    <td className="px-2 sm:px-3 py-3 text-xs">{renderValue(r.old_value)}</td>
                    <td className="px-2 sm:px-3 py-3 text-xs">{renderValue(r.new_value)}</td>
                    <td className="px-3 sm:px-6 py-3 text-muted text-[11px] font-mono whitespace-nowrap">
                      {r.admin_id ? `${r.admin_id.slice(0, 8)}…` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="text-muted text-xs text-center py-3">
              Showing {filtered.length} of up to {RESULT_LIMIT} most recent entries
            </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
