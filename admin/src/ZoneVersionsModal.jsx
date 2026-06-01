import React, { useCallback, useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import { saveZoneVersion, restoreZoneVersion } from './lib/zoneStore.js';
import { computeRestoreDiff, POLYGON_FIELDS } from './lib/zoneVersionDiff.js';
import StatusBadge from './components/StatusBadge.jsx';
import { useToast } from './useToast.jsx';

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

// Compact, non-JSON rendering of a scalar value for the diff.
function fmtScalar(v) {
  if (v == null) return '∅';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (typeof v === 'object') return 'set';
  return String(v);
}

const POLY_TONE = { set: 'good', changed: 'warn', missing: 'bad' };

function FieldChange({ field, change }) {
  if (POLYGON_FIELDS.includes(field)) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <span className="text-muted">{field}:</span>
        <StatusBadge tone={POLY_TONE[change.kind] ?? 'muted'}>
          {change.kind}
        </StatusBadge>
      </span>
    );
  }
  return (
    <span className="text-xs">
      <span className="text-muted">{field}:</span>{' '}
      <span className="text-bad/80">{fmtScalar(change.from)}</span>
      <span className="text-muted"> → </span>
      <span className="text-good">{fmtScalar(change.to)}</span>
    </span>
  );
}

// ── Restore preview sub-view ────────────────────────────────────────────────
function RestorePreview({ version, diff, onCancel, onApplied }) {
  const toast = useToast();
  const [confirmText, setConfirmText] = useState('');
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState(null);

  const canConfirm = confirmText === 'RESTORE' && !applying;

  async function handleApply() {
    if (!canConfirm) return;
    setApplying(true);
    setFailure(null);
    try {
      const res = await restoreZoneVersion({ version, diff });
      if (res.failed) {
        setFailure(res);
        toast(`Restore failed on "${res.failed.zone}"`, 'error');
        // Partial application is possible — refresh data but stay on the page.
        onApplied?.({ partial: true });
        return;
      }
      toast(
        `Restored version #${version.version_number} — ${res.updated} updated, ${res.created} created`,
        'success'
      );
      onApplied?.({ partial: false });
    } catch (err) {
      setFailure({ failed: { zone: '—', message: err.message ?? String(err) } });
      toast(err.message ?? 'Restore failed', 'error');
    } finally {
      setApplying(false);
    }
  }

  return (
    <>
      <div className="px-5 py-3 border-b border-border bg-panel2/40">
        <button
          onClick={onCancel}
          disabled={applying}
          className="text-muted hover:text-text text-xs mb-2"
        >
          ← Back to versions
        </button>
        <div className="text-text font-semibold">
          Restore version #{version.version_number}
        </div>
        <div className="text-muted text-xs mt-0.5">
          Published {formatTime(version.published_at)}
          {version.notes ? ` · ${version.notes}` : ''}
        </div>
      </div>

      {/* Counts */}
      <div className="px-5 py-3 border-b border-border flex flex-wrap gap-2 text-xs">
        <span className="bg-warn/20 text-warn px-2 py-1 rounded">
          {diff.toUpdate.length} to update
        </span>
        <span className="bg-good/20 text-good px-2 py-1 rounded">
          {diff.toCreate.length} to create
        </span>
        <span className="bg-panel2 text-muted px-2 py-1 rounded">
          {diff.unchanged.length} unchanged
        </span>
        <span className="bg-panel2 text-muted px-2 py-1 rounded">
          {diff.notInSnapshot.length} not restored
        </span>
      </div>

      {/* Warning */}
      <div className="px-5 py-3 border-b border-border bg-bad/10">
        <div className="text-bad text-sm font-semibold">
          ⚠️ This will affect driver-facing zone configuration after
          publish/snapshot regeneration.
        </div>
        <div className="text-muted text-xs mt-1">
          Zones present now but missing from this version are listed below and
          will NOT be changed or deleted.
        </div>
      </div>

      {/* Diff body */}
      <div className="p-5 overflow-auto flex-1 space-y-4">
        {diff.toUpdate.length > 0 ? (
          <section>
            <div className="text-text text-sm font-semibold mb-2">
              Zones to update ({diff.toUpdate.length})
            </div>
            <div className="space-y-2">
              {diff.toUpdate.map((item) => (
                <div
                  key={item.current.id}
                  className="border border-border rounded px-3 py-2 bg-panel2/30"
                >
                  <div className="text-text text-sm font-medium mb-1">
                    {item.current.name}
                  </div>
                  <div className="flex flex-col gap-1">
                    {Object.entries(item.changes).map(([field, change]) => (
                      <FieldChange key={field} field={field} change={change} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {diff.toCreate.length > 0 ? (
          <section>
            <div className="text-text text-sm font-semibold mb-2">
              Zones to create ({diff.toCreate.length})
            </div>
            <div className="flex flex-wrap gap-1.5">
              {diff.toCreate.map((s) => (
                <span
                  key={s.id ?? s.name}
                  className="bg-good/15 text-good text-xs px-2 py-1 rounded"
                >
                  {s.name}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {diff.notInSnapshot.length > 0 ? (
          <section>
            <div className="text-text text-sm font-semibold mb-2">
              Not in selected version ({diff.notInSnapshot.length}) — left
              unchanged
            </div>
            <div className="flex flex-wrap gap-1.5">
              {diff.notInSnapshot.map((z) => (
                <span
                  key={z.id}
                  className="bg-panel2 text-muted text-xs px-2 py-1 rounded"
                >
                  {z.name}
                </span>
              ))}
            </div>
          </section>
        ) : null}

        {diff.toUpdate.length === 0 && diff.toCreate.length === 0 ? (
          <div className="text-muted text-center py-6">
            This version matches the current configuration — nothing to restore.
          </div>
        ) : null}

        {failure ? (
          <div className="bg-bad/20 text-bad px-3 py-2 rounded text-sm">
            Restore stopped on zone “{failure.failed.zone}”: {failure.failed.message}
            {failure.failed.appliedUpdates != null ? (
              <div className="text-muted text-xs mt-1">
                {failure.failed.appliedUpdates} update(s) and{' '}
                {failure.failed.appliedCreates} create(s) were already applied
                before the failure — the configuration may be partially restored.
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* Confirm */}
      <footer className="px-5 py-3 border-t border-border">
        <div className="text-muted text-xs mb-2">
          Type <span className="text-text font-mono font-semibold">RESTORE</span>{' '}
          to enable the confirm button.
        </div>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="RESTORE"
            disabled={applying}
            className="flex-1 bg-panel border border-border rounded h-9 px-2 text-text text-sm font-mono"
          />
          <button
            onClick={onCancel}
            disabled={applying}
            className="bg-panel border border-border text-muted px-4 py-2 rounded text-sm"
          >
            Cancel
          </button>
          <button
            onClick={handleApply}
            disabled={!canConfirm}
            className={`px-4 py-2 rounded text-sm font-semibold whitespace-nowrap ${
              canConfirm ? 'bg-bad text-white' : 'bg-panel border border-border text-muted'
            }`}
          >
            {applying ? 'Restoring…' : 'Confirm Restore'}
          </button>
        </div>
      </footer>
    </>
  );
}

// ── Versions modal ──────────────────────────────────────────────────────────
// Lists recent zone config versions, lets an admin append a new one, and
// preview + confirm a restore of an earlier version. All reads/writes rely on
// RLS (admins only) — no service role.
export default function ZoneVersionsModal({ onClose, onRestored }) {
  const toast = useToast();
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  // Restore preview state.
  const [restoreTarget, setRestoreTarget] = useState(null); // version row
  const [diff, setDiff] = useState(null);
  const [diffLoading, setDiffLoading] = useState(false);

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

  async function startRestore(version) {
    setRestoreTarget(version);
    setDiff(null);
    setDiffLoading(true);
    // Pull current full zone rows to diff against the snapshot.
    const { data, error: err } = await supabase.from('staging_zones').select('*');
    if (err) {
      toast(err.message ?? 'Could not load current zones', 'error');
      setRestoreTarget(null);
      setDiffLoading(false);
      return;
    }
    setDiff(computeRestoreDiff(version.snapshot, data ?? []));
    setDiffLoading(false);
  }

  function cancelRestore() {
    setRestoreTarget(null);
    setDiff(null);
  }

  async function handleApplied({ partial }) {
    // Refresh the Zones page and reload the (now longer) version list.
    onRestored?.();
    await load();
    if (!partial) cancelRestore();
  }

  const inRestore = !!restoreTarget;

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      onClick={(e) => e.target === e.currentTarget && !inRestore && onClose()}
    >
      <div className="bg-panel border border-border rounded-t-lg sm:rounded-lg w-full sm:max-w-2xl max-h-[90vh] sm:max-h-[85vh] flex flex-col">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="text-text font-semibold">Zone Config Versions</div>
          <button onClick={onClose} className="text-muted hover:text-text" aria-label="Close">
            ✕
          </button>
        </header>

        {inRestore ? (
          diffLoading || !diff ? (
            <div className="text-muted text-center py-12">Computing diff…</div>
          ) : (
            <RestorePreview
              version={restoreTarget}
              diff={diff}
              onCancel={cancelRestore}
              onApplied={handleApplied}
            />
          )
        ) : (
          <>
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
                <div className="border border-border rounded overflow-x-auto">
                  <table className="w-full text-sm" style={{ minWidth: 560 }}>
                    <thead className="bg-panel2 text-muted text-xs uppercase">
                      <tr>
                        <th className="text-left px-3 py-2">Version</th>
                        <th className="text-left px-3 py-2">Published</th>
                        <th className="text-right px-3 py-2">Features</th>
                        <th className="text-left px-3 py-2">Notes</th>
                        <th className="text-right px-3 py-2">Action</th>
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
                          <td className="px-3 py-2 text-right">
                            <button
                              onClick={() => startRestore(v)}
                              className="bg-panel2 border border-border text-muted px-2.5 py-1 rounded text-xs hover:text-text whitespace-nowrap"
                              title="Preview and restore this version"
                            >
                              ↩ Restore
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
