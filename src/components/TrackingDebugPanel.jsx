// Dev/admin-only debug panel for the automatic background tracking system.
//
// Rendered from ProfileScreen only for admins, and this component also returns
// null outside __DEV__. Supabase reads are scoped to the currently authenticated
// driver id so the mobile debug view never displays another driver's location.

import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { useSelector } from 'react-redux';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
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

function fmtTime(value) {
  if (!value) return '-';
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(ms)) return '-';
  return new Date(ms).toLocaleTimeString();
}

function fmtAge(value) {
  if (!value) return '-';
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return '-';
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

function fmtCoord(value) {
  return value == null ? '-' : Number(value).toFixed(6);
}

function fmtBool(value) {
  if (value == null) return 'unknown';
  return value ? 'yes' : 'no';
}

function valueText(value) {
  if (value == null || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function Section({ title, children }) {
  return (
    <View className="mt-3 border-t border-border pt-2">
      <Text className="text-accent text-xs font-semibold mb-1">{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value, tone }) {
  const color = tone === 'bad' ? 'text-bad' : tone === 'good' ? 'text-accent' : 'text-text';
  return (
    <View className="flex-row justify-between py-0.5 gap-3">
      <Text className="text-muted text-xs flex-1">{label}</Text>
      <Text className={`${color} text-xs flex-1 text-right`} numberOfLines={2}>
        {valueText(value)}
      </Text>
    </View>
  );
}

export default function TrackingDebugPanel() {
  if (!isDev) return null;
  return <TrackingDebugPanelInner />;
}

function TrackingDebugPanelInner() {
  const [dbg, setDbg] = useState(getTrackingDebug());
  const [tasks, setTasks] = useState({ passive: false, active: false });
  const [db, setDb] = useState({
    loading: false,
    error: null,
    refreshedAt: null,
    driver: null,
    presence: null,
    activePresence: null,
    zoneStats: null,
  });

  const session = useSelector((s) => s.auth.session);
  const driverId = session?.user?.id ?? null;
  const redux = useSelector((s) => s.drivers);

  useEffect(() => subscribeTrackingDebug(setDbg), []);

  const pollTasks = useCallback(async () => {
    try {
      const [passive, active] = await Promise.all([
        Location.hasStartedLocationUpdatesAsync(LVTAXI_PASSIVE_LOCATION_TASK),
        Location.hasStartedLocationUpdatesAsync(LVTAXI_ACTIVE_LOCATION_TASK),
      ]);
      setTasks({ passive, active });
    } catch {}
  }, []);

  const refreshDb = useCallback(async () => {
    if (!driverId) {
      setDb((prev) => ({
        ...prev,
        loading: false,
        error: 'No signed-in driver id',
        refreshedAt: Date.now(),
      }));
      return;
    }

    setDb((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const [driverRes, presenceRes, activeRes] = await Promise.all([
        supabase
          .from('drivers')
          .select(
            'status,current_zone_id,tracking_enabled,last_seen,work_area_entry_time,work_area_exit_started_at'
          )
          .eq('id', driverId)
          .maybeSingle(),
        supabase
          .from('driver_presence')
          .select(
            'current_zone_id,classification,last_ping_at,lat,lng,accuracy,speed,active_visit_id'
          )
          .eq('driver_id', driverId)
          .maybeSingle(),
        supabase
          .from('active_driver_presence')
          .select('current_zone_id,classification,last_ping_at,active_visit_id')
          .eq('driver_id', driverId)
          .maybeSingle(),
      ]);

      const baseError = driverRes.error || presenceRes.error || activeRes.error;
      let zoneStats = null;
      let countError = null;
      const zoneId =
        presenceRes.data?.current_zone_id ??
        driverRes.data?.current_zone_id ??
        redux.currentZoneId ??
        null;

      if (zoneId) {
        const countRes = await supabase
          .from('active_driver_presence')
          .select('driver_id', { count: 'exact', head: true })
          .eq('current_zone_id', zoneId);
        countError = countRes.error;
        zoneStats = {
          zone_id: zoneId,
          cars_staged: countRes.count ?? null,
          last_updated: activeRes.data?.last_ping_at ?? presenceRes.data?.last_ping_at ?? null,
        };
      }

      setDb({
        loading: false,
        error: baseError?.message || countError?.message || null,
        refreshedAt: Date.now(),
        driver: driverRes.data ?? null,
        presence: presenceRes.data ?? null,
        activePresence: activeRes.data ?? null,
        zoneStats,
      });
    } catch (err) {
      setDb((prev) => ({
        ...prev,
        loading: false,
        error: err?.message || 'Refresh failed',
        refreshedAt: Date.now(),
      }));
    }
  }, [driverId, redux.currentZoneId]);

  useEffect(() => {
    pollTasks();
    refreshDb();
    const id = setInterval(pollTasks, 5000);
    return () => clearInterval(id);
  }, [pollTasks, refreshDb]);

  const refreshAll = useCallback(() => {
    pollTasks();
    refreshDb();
  }, [pollTasks, refreshDb]);

  const exitStartedAt = redux.workAreaExitStartedAt ?? dbg.workAreaExitStartedAt;
  const exitStartedMs = exitStartedAt ? new Date(exitStartedAt).getTime() : null;
  const minutesRemaining = exitStartedMs
    ? Math.max(0, Math.ceil((WORK_AREA_EXIT_GRACE_MS - (Date.now() - exitStartedMs)) / 60000))
    : null;
  const presenceFreshSeconds = db.presence?.last_ping_at
    ? Math.round((Date.now() - new Date(db.presence.last_ping_at).getTime()) / 1000)
    : null;
  const presenceFresh = presenceFreshSeconds != null && presenceFreshSeconds <= 90;
  const stagedWithoutActiveTracking = redux.status === 'staged' && !tasks.active;

  // Warn when the app believes heartbeat succeeded recently but the DB row is stale.
  const recentSuccessMs = dbg.lastHeartbeatSuccessAt
    ? Date.now() - dbg.lastHeartbeatSuccessAt
    : null;
  const heartbeatSuccessButDbStale =
    recentSuccessMs != null &&
    recentSuccessMs < 90_000 &&
    db.presence?.last_ping_at != null &&
    presenceFreshSeconds != null &&
    presenceFreshSeconds > 90;

  return (
    <View className="mx-4 mt-4 bg-panel rounded-lg border border-border p-4">
      <View className="flex-row items-center justify-between mb-1">
        <Text className="text-accent text-xs font-bold">Tracking Debug (dev admin)</Text>
        <Pressable
          onPress={refreshAll}
          disabled={db.loading}
          className="bg-bg border border-border rounded-lg px-3 py-1"
        >
          {db.loading ? (
            <ActivityIndicator size="small" color="#F5C518" />
          ) : (
            <Text className="text-accent text-xs font-semibold">Refresh</Text>
          )}
        </Pressable>
      </View>
      <Row label="DB refreshed" value={fmtTime(db.refreshedAt)} />
      <Row label="DB refresh error" value={db.error} tone={db.error ? 'bad' : undefined} />
      {stagedWithoutActiveTracking ? (
        <View className="mt-2 rounded-lg border border-bad bg-bg px-3 py-2">
          <Text className="text-bad text-xs font-semibold">
            Staged but active tracking is not running - heartbeat may go stale.
          </Text>
        </View>
      ) : null}

      <Section title="Redux">
        <Row label="status" value={redux.status} />
        <Row label="currentZoneId" value={redux.currentZoneId} />
        <Row label="isInsideZone" value={redux.isInsideZone} />
        <Row label="zoneEntryTime" value={fmtTime(redux.zoneEntryTime)} />
        <Row label="trackingEnabled" value={redux.trackingEnabled} />
        <Row label="currentLat" value={fmtCoord(redux.currentLat)} />
        <Row label="currentLng" value={fmtCoord(redux.currentLng)} />
        <Row label="accuracy" value={redux.rawAccuracy == null ? '-' : `${Math.round(redux.rawAccuracy)}m`} />
      </Section>

      <Section title="Tasks and Geometry">
        <Row label="passive task running" value={tasks.passive} />
        <Row label="active task running" value={tasks.active} />
        <Row label="last task" value={dbg.lastTask} />
        <Row label="last passive run" value={fmtTime(dbg.lastPassiveTaskRunAt)} />
        <Row label="last active run" value={fmtTime(dbg.lastActiveTaskRunAt)} />
        <Row label="last bg location" value={fmtTime(dbg.lastBackgroundLocationAt)} />
        <Row label="bg lat/lng" value={`${fmtCoord(dbg.lastBackgroundLat)}, ${fmtCoord(dbg.lastBackgroundLng)}`} />
        <Row label="insideWorkArea" value={fmtBool(dbg.insideWorkArea)} />
        <Row label="workAreaPolygonCount" value={dbg.workAreaPolygonCount} />
        <Row label="detectedZoneId" value={dbg.detectedZoneId} />
        <Row label="detectedZoneName" value={dbg.detectedZoneName} />
        <Row label="desiredStatus" value={dbg.lastTaskDesiredStatus} />
        <Row label="decision reason" value={dbg.lastTaskDecisionReason} />
        <Row label="status before" value={dbg.lastTaskStatusBefore} />
        <Row label="status after" value={dbg.lastTaskStatusAfter} />
        <Row label="transition source" value={dbg.lastTransitionSource} />
        <Row label="transition payload" value={dbg.lastTransitionPayload} />
        <Row label="requested tracking" value={dbg.requestedTrackingMode} />
        <Row label="tracking after transition" value={dbg.trackingModeAfterTransition} />
        <Row label="active start requested" value={fmtTime(dbg.activeTaskStartRequestedAt)} />
        <Row label="passive stop requested" value={fmtTime(dbg.passiveTaskStopRequestedAt)} />
        <Row label="active start error" value={dbg.activeTaskStartError} tone={dbg.activeTaskStartError ? 'bad' : undefined} />
        <Row label="passive stop error" value={dbg.passiveTaskStopError} tone={dbg.passiveTaskStopError ? 'bad' : undefined} />
        <Row label="workAreaExitStartedAt" value={fmtTime(exitStartedMs)} />
        <Row
          label="exit grace remaining"
          value={minutesRemaining == null ? '-' : `${minutesRemaining} min`}
        />
      </Section>

      <Section title="Heartbeat">
        <Row label="last attempt" value={fmtTime(dbg.lastHeartbeatAttemptAt)} />
        <Row label="last success" value={fmtTime(dbg.lastHeartbeatSuccessAt)} />
        <Row label="blocked reason" value={dbg.lastHeartbeatBlockedReason} />
        <Row label="zoneId" value={dbg.lastHeartbeatZoneId} />
        <Row label="classification" value={dbg.lastHeartbeatClassification} />
        <Row label="error" value={dbg.lastHeartbeatErrorMessage} tone={dbg.lastHeartbeatErrorMessage ? 'bad' : undefined} />
        <Row label="rpc started" value={fmtTime(dbg.heartbeatRpcStartedAt)} />
        <Row label="rpc finished" value={fmtTime(dbg.heartbeatRpcFinishedAt)} />
        <Row label="rpc error" value={dbg.heartbeatRpcError} tone={dbg.heartbeatRpcError ? 'bad' : undefined} />
        <Row label="rpc returned ping" value={fmtTime(dbg.heartbeatRpcReturned)} />
        <Row label="db last_ping_at" value={`${fmtTime(dbg.heartbeatDbLastPingAt)} (${fmtAge(dbg.heartbeatDbLastPingAt)})`} />
        <Row
          label="db ping confirmed fresh"
          value={dbg.heartbeatDbConfirmedFresh == null ? 'unknown' : dbg.heartbeatDbConfirmedFresh ? 'yes' : 'no'}
          tone={dbg.heartbeatDbConfirmedFresh === false ? 'bad' : dbg.heartbeatDbConfirmedFresh === true ? 'good' : undefined}
        />
        <Row
          label="db mismatch reason"
          value={dbg.heartbeatDbMismatchReason}
          tone={dbg.heartbeatDbMismatchReason ? 'bad' : undefined}
        />
        {heartbeatSuccessButDbStale ? (
          <View className="mt-1 rounded-lg border border-bad bg-bg px-3 py-2">
            <Text className="text-bad text-xs font-semibold">
              Heartbeat reports success but DB presence is stale.
            </Text>
          </View>
        ) : null}
      </Section>

      <Section title="Supabase drivers">
        <Row label="status" value={db.driver?.status} />
        <Row label="current_zone_id" value={db.driver?.current_zone_id} />
        <Row label="tracking_enabled" value={db.driver?.tracking_enabled} />
        <Row label="last_seen" value={`${fmtTime(db.driver?.last_seen)} (${fmtAge(db.driver?.last_seen)})`} />
        <Row label="work_area_entry_time" value={fmtTime(db.driver?.work_area_entry_time)} />
        <Row label="work_area_exit_started_at" value={fmtTime(db.driver?.work_area_exit_started_at)} />
      </Section>

      <Section title="Supabase presence">
        <Row label="exists" value={!!db.presence} tone={db.presence ? 'good' : 'bad'} />
        <Row label="current_zone_id" value={db.presence?.current_zone_id} />
        <Row label="classification" value={db.presence?.classification} />
        <Row
          label="last_ping_at"
          value={`${fmtTime(db.presence?.last_ping_at)} (${fmtAge(db.presence?.last_ping_at)})`}
          tone={presenceFresh ? 'good' : db.presence ? 'bad' : undefined}
        />
        <Row label="lat/lng" value={`${fmtCoord(db.presence?.lat)}, ${fmtCoord(db.presence?.lng)}`} />
        <Row label="accuracy" value={db.presence?.accuracy == null ? '-' : `${Math.round(db.presence.accuracy)}m`} />
        <Row label="speed" value={db.presence?.speed} />
        <Row label="active_visit_id" value={db.presence?.active_visit_id} />
      </Section>

      <Section title="Count Eligibility">
        <Row label="active_presence row" value={!!db.activePresence} tone={db.activePresence ? 'good' : 'bad'} />
        <Row label="active zone" value={db.activePresence?.current_zone_id} />
        <Row label="active classification" value={db.activePresence?.classification} />
        <Row label="zone cars_staged" value={db.zoneStats?.cars_staged} />
        <Row label="zone stats updated" value={fmtTime(db.zoneStats?.last_updated)} />
      </Section>
    </View>
  );
}
