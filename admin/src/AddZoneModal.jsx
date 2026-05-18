import React, { useState } from 'react';
import { saveDrawn } from './lib/zoneStore.js';

function buildCirclePolygon(lat, lng, radiusM) {
  const EARTH_R = 6371000;
  const coords = [];
  for (let i = 0; i <= 32; i++) {
    const angle = (i / 32) * 2 * Math.PI;
    const dLat = (radiusM * Math.cos(angle)) / EARTH_R;
    const dLng =
      (radiusM * Math.sin(angle)) /
      (EARTH_R * Math.cos((lat * Math.PI) / 180));
    coords.push([
      lng + (dLng * 180) / Math.PI,
      lat + (dLat * 180) / Math.PI,
    ]);
  }
  return {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [coords] },
    properties: {},
  };
}

export default function AddZoneModal({ onClose, onDone }) {
  const [name, setName] = useState('');
  const [lat, setLat] = useState('36.1147');
  const [lng, setLng] = useState('-115.1728');
  const [radius, setRadius] = useState('200');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null);
    const latN = parseFloat(lat);
    const lngN = parseFloat(lng);
    const radN = parseFloat(radius);
    if (!name.trim()) return setError('Zone name is required');
    if (isNaN(latN) || isNaN(lngN)) return setError('Invalid coordinates');
    if (isNaN(radN) || radN < 10) return setError('Radius must be at least 10 m');
    setBusy(true);
    try {
      const feature = buildCirclePolygon(latN, lngN, radN);
      await saveDrawn({ name: name.trim(), feature });
      onDone?.();
    } catch (err) {
      setError(err.message ?? String(err));
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="bg-panel border border-border rounded-lg w-full max-w-md">
        <header className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="text-text font-semibold">Add New Zone</div>
          <button onClick={onClose} className="text-muted hover:text-text">
            ✕
          </button>
        </header>
        <form onSubmit={submit} className="p-5 space-y-4">
          <div>
            <label className="text-muted text-xs block mb-1">Zone Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. MGM Grand"
              className="w-full bg-panel2 border border-border rounded h-10 px-3 text-text text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-muted text-xs block mb-1">Latitude</label>
              <input
                type="number"
                step="any"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
                className="w-full bg-panel2 border border-border rounded h-10 px-3 text-text text-sm"
              />
            </div>
            <div>
              <label className="text-muted text-xs block mb-1">Longitude</label>
              <input
                type="number"
                step="any"
                value={lng}
                onChange={(e) => setLng(e.target.value)}
                className="w-full bg-panel2 border border-border rounded h-10 px-3 text-text text-sm"
              />
            </div>
          </div>
          <div>
            <label className="text-muted text-xs block mb-1">Radius (meters)</label>
            <input
              type="number"
              min="10"
              max="5000"
              value={radius}
              onChange={(e) => setRadius(e.target.value)}
              className="w-full bg-panel2 border border-border rounded h-10 px-3 text-text text-sm"
            />
            <div className="text-muted text-xs mt-1">
              Used for circle-only detection before a polygon is drawn in the
              Builder.
            </div>
          </div>
          {error ? <div className="text-bad text-sm">{error}</div> : null}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 h-10 rounded text-sm bg-panel2 border border-border text-muted hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="flex-1 h-10 rounded text-sm font-semibold bg-accent text-bg disabled:opacity-50"
            >
              {busy ? 'Saving…' : 'Create Zone'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
