// Dev-only debug panel for the automatic background tracking system.
//
// Renders nothing unless __DEV__ is true. It surfaces the live state machine so a
// developer can confirm transitions on-device without attaching a debugger:
//   • current driver status + tracking_enabled
//   • which background task is active (passive / active) and is it started
//   • last background location time + inside-work-area flag
//   • detected staging zone id/name
//   • last heartbeat time
//   • exit-grace start + minutes remaining

import React, { useEffect, useState } from 'react';
import { View, Text } from 'react-native';
import { useSelector } from 'react-redux';
import * as Location from 'expo-location';
import {
  subscribeTrackingDebug,
  getTrackingDebug,
} from '../lib/backgroundTracking/trackingDebug';
import {
  LVTAXI_PASSIVE_LOCATION_TASK,
  LVTAXI_ACTIVE_LOCATION_TASK,
} from '../lib/backgroundTracking/trackingTaskNames';
import { WORK_AREA_EXIT_GRACE_MS } from '../lib/constants';

const isDev = typeof __DEV__ !== 'undefined' && __DEV__;

function fmtTime(ms) {
  if (!ms) return '—';
  try {
    return new Date(ms).toLocaleTimeString();
  } catch {
    return '—';
  }
}

function Row({ label, value }) {
  return (
    <View className="flex-row justify-between py-0.5">
      <Text className="text-muted text-xs">{label}</Text>
      <Text className="text-text text-xs" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

// Gate the hooks behind the dev check so we never call hooks conditionally.
export default function TrackingDebugPanel() {
  if (!isDev) return null;
  return <TrackingDebugPanelInner />;
}

function TrackingDebugPanelInner() {
  const [dbg, setDbg] = useState(getTrackingDebug());
  const [tasks, setTasks] = useState({ passive: false, active: false });
  const status = useSelector((s) => s.drivers.status);
  const trackingEnabled = useSelector((s) => s.drivers.trackingEnabled);
  const exitStartedAt = useSelector((s) => s.drivers.workAreaExitStartedAt);

  useEffect(() => subscribeTrackingDebug(setDbg), []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const [passive, active] = await Promise.all([
          Location.hasStartedLocationUpdatesAsync(LVTAXI_PASSIVE_LOCATION_TASK),
          Location.hasStartedLocationUpdatesAsync(LVTAXI_ACTIVE_LOCATION_TASK),
        ]);
        if (!cancelled) setTasks({ passive, active });
      } catch {}
    }
    poll();
    const id = setInterval(poll, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const minutesRemaining = exitStartedAt
    ? Math.max(
        0,
        Math.ceil(
          (WORK_AREA_EXIT_GRACE_MS - (Date.now() - new Date(exitStartedAt).getTime())) /
            60000
        )
      )
    : null;

  return (
    <View className="mx-4 mt-4 bg-panel rounded-lg border border-border p-4">
      <Text className="text-accent text-xs font-bold mb-2">
        🛠 Tracking Debug (dev only)
      </Text>
      <Row label="Status" value={String(status)} />
      <Row label="Tracking enabled" value={trackingEnabled ? 'yes' : 'no'} />
      <Row
        label="Task started"
        value={`passive:${tasks.passive ? '✓' : '✗'}  active:${tasks.active ? '✓' : '✗'}`}
      />
      <Row label="Last task ran" value={dbg.lastTask ?? '—'} />
      <Row label="Last bg location" value={fmtTime(dbg.lastBackgroundLocationAt)} />
      <Row
        label="Inside work area"
        value={dbg.insideWorkArea == null ? '—' : dbg.insideWorkArea ? 'yes' : 'no'}
      />
      <Row label="Work-area polygons" value={String(dbg.workAreaPolygonCount ?? '—')} />
      <Row
        label="Detected zone"
        value={dbg.detectedZoneName ?? dbg.detectedZoneId ?? '—'}
      />
      <Row label="Last heartbeat" value={fmtTime(dbg.lastHeartbeatAt)} />
      <Row label="Exit grace started" value={fmtTime(exitStartedAt ? new Date(exitStartedAt).getTime() : null)} />
      <Row
        label="Exit grace remaining"
        value={minutesRemaining == null ? '—' : `${minutesRemaining} min`}
      />
    </View>
  );
}
