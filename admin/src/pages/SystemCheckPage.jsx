import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.js';
import StatusBadge from '../components/StatusBadge.jsx';

// A check returns { status: 'PASS'|'WARNING'|'FAIL', detail: string }.
// `required` checks FAIL on error; optional ones downgrade to WARNING so a
// missing optional table never makes the whole dashboard look broken.

const STATUS_TONE = { PASS: 'good', WARNING: 'warn', FAIL: 'bad' };

// Truncate Supabase error text so we never echo anything sensitive at length.
function safeError(err) {
  const msg = err?.message ?? String(err ?? 'unknown error');
  return msg.length > 160 ? msg.slice(0, 157) + '…' : msg;
}

// Generic "can I select 1 row from this table?" probe.
async function probeTable(table, { optional = false } = {}) {
  const { error } = await supabase.from(table).select('*', { head: true, count: 'exact' }).limit(1);
  if (error) {
    return {
      status: optional ? 'WARNING' : 'FAIL',
      detail: safeError(error),
    };
  }
  return { status: 'PASS', detail: 'readable' };
}

export default function SystemCheckPage() {
  const [checks, setChecks] = useState([]);
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState(null);

  const run = useCallback(async () => {
    setRunning(true);
    const results = [];

    // 1. Auth session
    try {
      const { data, error } = await supabase.auth.getSession();
      if (error) results.push({ name: 'Auth session', required: true, status: 'FAIL', detail: safeError(error) });
      else if (!data.session)
        results.push({ name: 'Auth session', required: true, status: 'FAIL', detail: 'no active session' });
      else
        results.push({
          name: 'Auth session',
          required: true,
          status: 'PASS',
          detail: data.session.user.email ?? data.session.user.phone ?? 'signed in',
        });
    } catch (err) {
      results.push({ name: 'Auth session', required: true, status: 'FAIL', detail: safeError(err) });
    }

    // 2. Own driver role
    try {
      const { data: sess } = await supabase.auth.getSession();
      const uid = sess.session?.user?.id;
      if (!uid) {
        results.push({ name: 'Own driver role', required: true, status: 'FAIL', detail: 'no user id' });
      } else {
        const { data, error } = await supabase
          .from('drivers')
          .select('role')
          .eq('id', uid)
          .maybeSingle();
        if (error)
          results.push({ name: 'Own driver role', required: true, status: 'FAIL', detail: safeError(error) });
        else
          results.push({
            name: 'Own driver role',
            required: true,
            status: data?.role === 'admin' ? 'PASS' : 'WARNING',
            detail: `role = ${data?.role ?? 'unknown'}`,
          });
      }
    } catch (err) {
      results.push({ name: 'Own driver role', required: true, status: 'FAIL', detail: safeError(err) });
    }

    // 3. staging_zones
    results.push({ name: 'Read staging_zones', required: true, ...(await probeTable('staging_zones')) });

    // 4. Live stats: RPC preferred, zone_stats fallback.
    try {
      const rpc = await supabase.rpc('get_zone_live_stats');
      if (!rpc.error && Array.isArray(rpc.data)) {
        results.push({ name: 'Live stats (get_zone_live_stats)', required: true, status: 'PASS', detail: `${rpc.data.length} rows` });
      } else {
        const fb = await probeTable('zone_stats');
        results.push({
          name: 'Live stats (RPC → zone_stats fallback)',
          required: true,
          status: fb.status === 'PASS' ? 'WARNING' : 'FAIL',
          detail: fb.status === 'PASS' ? `RPC unavailable; zone_stats OK (${safeError(rpc.error)})` : fb.detail,
        });
      }
    } catch (err) {
      results.push({ name: 'Live stats', required: true, status: 'FAIL', detail: safeError(err) });
    }

    // 5–7. Optional feature tables.
    results.push({ name: 'Read zone_audit_log', optional: true, ...(await probeTable('zone_audit_log', { optional: true })) });
    results.push({ name: 'Read reference_routes', optional: true, ...(await probeTable('reference_routes', { optional: true })) });
    results.push({ name: 'Read zone_config_versions', optional: true, ...(await probeTable('zone_config_versions', { optional: true })) });

    // 8. Storage bucket used by regenerateSnapshot().
    try {
      const { error } = await supabase.storage.from('zones-snapshot').list('', { limit: 1 });
      results.push({
        name: 'Storage bucket zones-snapshot',
        optional: true,
        status: error ? 'WARNING' : 'PASS',
        detail: error ? safeError(error) : 'accessible',
      });
    } catch (err) {
      results.push({ name: 'Storage bucket zones-snapshot', optional: true, status: 'WARNING', detail: safeError(err) });
    }

    setChecks(results);
    setRanAt(new Date());
    setRunning(false);
  }, []);

  useEffect(() => {
    run();
  }, [run]);

  const fails = checks.filter((c) => c.status === 'FAIL').length;
  const warns = checks.filter((c) => c.status === 'WARNING').length;

  return (
    <div className="flex flex-col h-full">
      <div className="flex flex-wrap items-center gap-3 px-3 sm:px-6 py-3 border-b border-border bg-panel/40">
        <div className="text-text font-semibold">System Check</div>
        <div className="text-muted text-xs">
          {ranAt ? `Last run ${ranAt.toLocaleTimeString()}` : '—'}
          {checks.length
            ? ` · ${fails} fail · ${warns} warning`
            : ''}
        </div>
        <button
          onClick={run}
          disabled={running}
          className="ml-auto bg-accent text-bg font-semibold px-3 py-1.5 rounded text-xs whitespace-nowrap disabled:opacity-60"
        >
          {running ? 'Running…' : '↻ Re-run'}
        </button>
      </div>

      <main className="flex-1 overflow-auto p-3 sm:p-6">
        <div className="text-muted text-xs mb-3">
          Verifies connectivity and RLS access for each admin feature. Optional
          features that are missing are reported as warnings, not failures.
        </div>
        <div className="border border-border rounded overflow-x-auto">
          <table className="w-full text-sm" style={{ minWidth: 560 }}>
            <thead className="bg-panel2 text-muted text-xs uppercase">
              <tr>
                <th className="text-left px-3 py-2">Check</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {checks.length === 0 ? (
                <tr>
                  <td colSpan={3} className="text-muted text-center py-8">
                    {running ? 'Running checks…' : 'No results.'}
                  </td>
                </tr>
              ) : (
                checks.map((c) => (
                  <tr key={c.name} className="border-t border-border">
                    <td className="px-3 py-2 text-text">
                      {c.name}
                      {c.optional ? (
                        <span className="text-muted text-[10px] ml-1">(optional)</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge tone={STATUS_TONE[c.status]}>{c.status}</StatusBadge>
                    </td>
                    <td className="px-3 py-2 text-muted text-xs break-words">{c.detail}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  );
}
