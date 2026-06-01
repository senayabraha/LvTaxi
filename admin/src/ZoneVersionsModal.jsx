import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import { saveZoneVersion } from './lib/zoneStore.js';
import { useToast } from './useToast.jsx';

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// Lists recent zone config versions and lets an admin append a new one.
// Save/list both rely on RLS (admins only) — no service role.
export default function ZoneVersionsModal({ onClose }) {
  const toast = useToast();
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase
      .from('zone_config_versions')
      .select('id, version_number, published_by, published_at, notes, snapshot')
      .order('published_at', { ascending: false })
      .limit(50);
    if (err) {
      setError(err.message);
      setVersions([]);
    } else {
      setVersions(data ?? []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave() {
    setSaving(true);
    try {
      const v = await saveZoneVersion(notes);
      toast(`Saved version #${v.version_number}`, 'success');
      setNotes('');
      await load();
    } catch (err) {
      toast(err.message ?? 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-panel border border-border rounded-t-lg sm:rounded-lg w-full sm:max-w-2xl max-h-[90vh] sm:max-h-[80vh] flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="text-text font-semibold">Zone Config Versions</div>
          <button onClick={onClose} className="text-muted hover:text-text" aria-label="Close">
            ✕
          </button>
        </header>

        {/* Save new version */}
        <div className="px-5 py-4 border-b border-border bg-panel2/40">
          <div className="text-muted text-xs mb-2">
            Snapshot the current zone configuration for auditability / rollback.
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Notes (optional) — e.g. 'enabled Bellagio Phase B'"
              className="flex-1 bg-panel border border-border rounded h-9 px-2 text-text text-sm"
            />
            <button
              onClick={handleSave}
              disabled={saving}
              className={`px-4 py-2 rounded text-sm font-semibold whitespace-nowrap ${
                saving ? 'bg-accent/60 text-bg' : 'bg-accent text-bg hover:opacity-90'
              }`}
            >
              {saving ? 'Saving…' : '💾 Save Version'}
            </button>
          </div>
        </div>

        {/* Version list */}
        <div className="p-5 overflow-auto flex-1">
          {error ? (
            <div className="bg-bad/20 text-bad px-3 py-2 rounded text-sm">
              Could not load versions: {error}
              <div className="text-muted text-xs mt-1">
                Ensure migration <code>015_zone_config_versions.sql</code> is
                applied and your account is an admin.
              </div>
            </div>
          ) : loading ? (
            <div className="text-muted text-center py-8">Loading versions…</div>
          ) : versions.length === 0 ? (
            <div className="text-muted text-center py-8">
              No versions saved yet. Save one above to start the history.
            </div>
          ) : (
            <div className="border border-border rounded overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-panel2 text-muted text-xs uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Version</th>
                    <th className="text-left px-3 py-2">Published</th>
                    <th className="text-right px-3 py-2">Features</th>
                    <th className="text-left px-3 py-2">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id} className="border-t border-border">
                      <td className="px-3 py-2 text-text font-mono">#{v.version_number}</td>
                      <td className="px-3 py-2 text-muted text-xs whitespace-nowrap">
                        {formatTime(v.published_at)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">
                        {v.snapshot?.feature_count ?? v.snapshot?.features?.length ?? '—'}
                      </td>
                      <td className="px-3 py-2 text-text text-xs">
                        {v.notes || <span className="text-muted">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
