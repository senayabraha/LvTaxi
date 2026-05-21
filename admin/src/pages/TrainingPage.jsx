import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLeafletMap } from '../builder/MapView.jsx';
import { useDrawController, DRAW_MODE } from '../builder/useDrawController.js';
import { featuresFromPath } from '../lib/featureExtractFromPath.js';
import { supabase } from '../supabase.js';

const ROUTE_TYPES = [
  {
    value: 'staging',
    label: 'Staging',
    description: 'Driver enters and joins the queue',
    color: '#22c55e',
  },
  {
    value: 'drop_off',
    label: 'Drop-off',
    description: 'Driver enters, unloads a passenger, and exits',
    color: '#ef4444',
  },
  {
    value: 'loop_then_stage',
    label: 'Loop then Stage',
    description: 'Driver drops off near entry, loops to reach the staging queue',
    color: '#f59e0b',
  },
];

export default function TrainingPage() {
  const [zones, setZones] = useState([]);
  const [selectedZoneId, setSelectedZoneId] = useState('');
  const [routeType, setRouteType] = useState('staging');
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null); // { ok: bool, message: string }

  const mapContainerRef = useRef(null);
  const { mapRef, ready, layer, toggleLayer, findMe } = useLeafletMap(
    mapContainerRef,
    // Start on satellite so admin can see hotel road layouts.
    {}
  );

  // Switch to satellite on first render.
  const layerBootedRef = useRef(false);
  useEffect(() => {
    if (ready && !layerBootedRef.current && layer === 'street') {
      layerBootedRef.current = true;
      toggleLayer();
    }
  }, [ready, layer, toggleLayer]);

  const onFeature = useCallback(() => {}, []); // we use points directly, not the polygon feature
  const drawCtrl = useDrawController({
    map: ready ? mapRef.current : null,
    onFeature,
  });

  // Force OPEN (path) mode — training routes are paths, not closed polygons.
  useEffect(() => {
    if (drawCtrl.mode !== DRAW_MODE.OPEN) drawCtrl.setMode(DRAW_MODE.OPEN);
  }, [drawCtrl]);

  // Load all active zones for the zone selector.
  useEffect(() => {
    supabase
      .from('staging_zones')
      .select('id, name, lat, lng')
      .eq('active', true)
      .order('name')
      .then(({ data, error }) => {
        if (error) console.warn('[TrainingPage] zones load failed', error);
        else setZones(data ?? []);
      });
  }, []);

  async function handleSubmit() {
    if (!selectedZoneId) {
      setResult({ ok: false, message: 'Select a zone first.' });
      return;
    }
    if (drawCtrl.points.length < 2) {
      setResult({ ok: false, message: 'Draw at least 2 points on the map.' });
      return;
    }

    const zone = zones.find((z) => z.id === selectedZoneId);
    const zoneCenter = zone ? { lat: zone.lat, lng: zone.lng } : null;
    const features = featuresFromPath(drawCtrl.points, zoneCenter, routeType);
    const pathCoords = drawCtrl.points.map((p) => [p.lng, p.lat]);

    setSaving(true);
    setResult(null);

    const { data: sessionData } = await supabase.auth.getSession();
    const adminId = sessionData?.session?.user?.id ?? null;

    const { error } = await supabase.from('reference_routes').insert({
      zone_id: selectedZoneId,
      route_type: routeType,
      features,
      path_coords: pathCoords,
      source: 'drawn',
      recorded_by: adminId,
    });

    setSaving(false);

    if (error) {
      setResult({ ok: false, message: `Save failed: ${error.message}` });
    } else {
      const zoneName = zone?.name ?? 'zone';
      const typeLabel = ROUTE_TYPES.find((r) => r.value === routeType)?.label ?? routeType;
      setResult({ ok: true, message: `Saved "${typeLabel}" route for ${zoneName}.` });
      drawCtrl.clearAll();
    }
  }

  const selectedType = ROUTE_TYPES.find((r) => r.value === routeType);
  const canSubmit = selectedZoneId && drawCtrl.points.length >= 2 && !saving;

  return (
    <div className="flex flex-col h-full bg-bg">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border bg-panel shrink-0">
        {/* Zone selector */}
        <div className="flex flex-col gap-1 min-w-[200px]">
          <label className="text-muted text-xs">Hotel / Zone</label>
          <select
            value={selectedZoneId}
            onChange={(e) => setSelectedZoneId(e.target.value)}
            className="bg-panel2 border border-border text-text text-sm px-3 py-1.5 rounded focus:outline-none focus:border-accent"
          >
            <option value="">Select a zone…</option>
            {zones.map((z) => (
              <option key={z.id} value={z.id}>
                {z.name}
              </option>
            ))}
          </select>
        </div>

        {/* Route type selector */}
        <div className="flex flex-col gap-1">
          <label className="text-muted text-xs">Route type</label>
          <div className="flex gap-2">
            {ROUTE_TYPES.map((rt) => (
              <button
                key={rt.value}
                onClick={() => setRouteType(rt.value)}
                className={`px-3 py-1.5 rounded text-sm font-medium border transition-colors ${
                  routeType === rt.value
                    ? 'text-bg border-transparent'
                    : 'bg-panel2 border-border text-muted hover:text-text'
                }`}
                style={routeType === rt.value ? { backgroundColor: rt.color, borderColor: rt.color } : {}}
                title={rt.description}
              >
                {rt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Point count */}
        <div className="text-muted text-xs self-end pb-1.5">
          {drawCtrl.points.length} point{drawCtrl.points.length !== 1 ? 's' : ''}
        </div>

        {/* Actions */}
        <div className="flex gap-2 ml-auto self-end">
          <button
            onClick={drawCtrl.clearAll}
            disabled={drawCtrl.points.length === 0}
            className="bg-panel2 border border-border text-muted px-3 py-1.5 rounded text-sm hover:text-text disabled:opacity-40"
          >
            Clear
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="bg-accent text-bg px-4 py-1.5 rounded text-sm font-semibold disabled:opacity-40 hover:opacity-90"
          >
            {saving ? 'Saving…' : 'Submit Training Route'}
          </button>
        </div>
      </div>

      {/* Result banner */}
      {result && (
        <div
          className={`px-4 py-2 text-sm shrink-0 ${
            result.ok
              ? 'bg-good/10 border-b border-good/30 text-good'
              : 'bg-bad/10 border-b border-bad/30 text-bad'
          }`}
        >
          {result.ok ? '✓ ' : '✗ '}
          {result.message}
        </div>
      )}

      {/* Instruction */}
      <div className="px-4 py-2 text-muted text-xs border-b border-border bg-panel shrink-0">
        {selectedType ? (
          <>
            <span style={{ color: selectedType.color }} className="font-medium">
              {selectedType.label}:
            </span>{' '}
            {selectedType.description}. Click the map to place route points. Drag to adjust. Right-click to delete a point.
          </>
        ) : (
          'Select a zone and route type, then click the map to draw the route path.'
        )}
      </div>

      {/* Map */}
      <div className="relative flex-1 min-h-0">
        <div ref={mapContainerRef} className="absolute inset-0" />
        <button
          onClick={toggleLayer}
          className="absolute right-3 top-3 z-[600] bg-white text-gray-800 text-xs font-semibold px-3 h-8 rounded-full shadow"
        >
          {layer === 'satellite' ? '🗺 Street' : '🛰 Satellite'}
        </button>
        <button
          onClick={findMe}
          className="absolute right-3 top-14 z-[600] bg-white text-gray-800 w-8 h-8 rounded-full shadow flex items-center justify-center"
          title="Center on me"
        >
          🎯
        </button>
      </div>
    </div>
  );
}
