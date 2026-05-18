import React, { useState } from 'react';
import { saveDrawn, saveDriven } from '../lib/zoneStore.js';

const SAVE_AS = { DRAWN: 'drawn', DRIVEN: 'driven' };

export default function SavePanel({ feature, onSaved }) {
  const [name, setName] = useState('');
  const [saveAs, setSaveAs] = useState(SAVE_AS.DRAWN);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const disabled = !feature || !name.trim() || busy;

  async function save() {
    setError(null);
    setSuccess(null);
    setBusy(true);
    try {
      if (saveAs === SAVE_AS.DRAWN) {
        await saveDrawn({ name, feature });
        setSuccess(`Saved "${name.trim()}" as Drawn`);
      } else {
        await saveDriven({ name, feature });
        setSuccess(`Updated "${name.trim()}" driven polygon`);
      }
      setName('');
      onSaved?.();
    } catch (e) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 border-t border-border pt-3">
      <div className="text-text font-semibold text-sm">Save Zone</div>
      {!feature ? (
        <div className="text-muted text-xs">
          Build a polygon first (Track or Draw above).
        </div>
      ) : null}

      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Zone name (e.g. MGM Grand)"
        className="w-full bg-panel2 border border-border rounded h-10 px-3 text-text text-sm"
      />

      <div className="flex gap-2">
        <button
          onClick={() => setSaveAs(SAVE_AS.DRAWN)}
          className={`flex-1 h-9 rounded text-sm font-medium border ${
            saveAs === SAVE_AS.DRAWN
              ? 'bg-warn/20 border-warn text-warn'
              : 'bg-panel border-border text-muted'
          }`}
        >
          🟡 Drawn (new)
        </button>
        <button
          onClick={() => setSaveAs(SAVE_AS.DRIVEN)}
          className={`flex-1 h-9 rounded text-sm font-medium border ${
            saveAs === SAVE_AS.DRIVEN
              ? 'bg-good/20 border-good text-good'
              : 'bg-panel border-border text-muted'
          }`}
        >
          🟢 Driven (update)
        </button>
      </div>

      <div className="text-muted text-xs">
        {saveAs === SAVE_AS.DRAWN
          ? 'Creates new zone or updates drawn_polygon of an existing one.'
          : 'Updates driven_polygon of an existing zone. Name must match.'}
      </div>

      <button
        onClick={save}
        disabled={disabled}
        className={`w-full h-10 rounded font-semibold ${
          disabled
            ? 'bg-panel border border-border text-muted'
            : 'bg-accent text-bg'
        }`}
      >
        {busy ? 'Saving…' : 'Save to Supabase'}
      </button>

      {error ? <div className="text-bad text-xs">{error}</div> : null}
      {success ? <div className="text-good text-xs">✓ {success}</div> : null}
    </div>
  );
}
