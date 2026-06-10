import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { supabase } from '../lib/supabase';
import { fetchLiveZoneStats } from '../lib/zoneStatsEngine';
import {
  setZones,
  setStats,
  updateZoneStat,
  setLoading,
  setError,
} from '../store/zonesSlice';
import {
  loadStatsCache,
  loadZonesCache,
  saveStatsCache,
  saveZonesCache,
} from '../lib/offlineCache';

const flashListeners = new Set();

export function onZoneStatFlash(listener) {
  flashListeners.add(listener);
  return () => flashListeners.delete(listener);
}

function emitFlash(zoneId) {
  for (const listener of flashListeners) {
    try {
      listener(zoneId);
    } catch (err) {
      console.warn('[useZones] flash listener error', err);
    }
  }
}

const MAX_BACKOFF_MS = 60_000;

// How often to re-poll live stats from the RPC as a backstop fallback.
// With the snapshot table + realtime subscription this fires rarely; it exists
// only to recover from missed realtime events or snapshot staleness.
const LIVE_POLL_INTERVAL_MS = 30_000;

export function useZones() {
  const dispatch = useDispatch();
  const allZones = useSelector((s) => s.zones.allZones);
  const stats = useSelector((s) => s.zones.stats);
  const loading = useSelector((s) => s.zones.loading);
  const error = useSelector((s) => s.zones.error);
  const [refreshing, setRefreshing] = useState(false);
  const [statsUpdatedAt, setStatsUpdatedAt] = useState(null);
  const cancelledRef = useRef(false);
  const retryDelayRef = useRef(1000);
  const retryTimerRef = useRef(null);
  const pollTimerRef = useRef(null);
  const presenceDebounceRef = useRef(null);

  // Merge an array of live-stats rows into Redux (same shape as updateZoneStat).
  const mergeLiveStats = useCallback(
    (rows) => {
      if (!rows?.length) return;
      const merged = {};
      for (const row of rows) merged[row.zone_id] = row;
      // Dispatch each row so zonesSlice.updateZoneStat handles it normally.
      for (const row of rows) dispatch(updateZoneStat(row));
      setStatsUpdatedAt(Date.now());
      saveStatsCache(merged);
    },
    [dispatch]
  );

  // Load stats from the snapshot table (cheap primary path).
  // Falls back to the heavy RPC when the snapshot table is empty or unavailable.
  const loadStatsFromSnapshot = useCallback(async () => {
    if (cancelledRef.current) return;
    const { data, error } = await supabase
      .from('zone_live_stats_snapshot')
      .select('*');
    if (cancelledRef.current) return;
    if (!error && data && data.length > 0) {
      // Remap zone_id column to match the RPC shape (zone_id is the PK here too).
      mergeLiveStats(data);
      return;
    }
    // Snapshot empty or unavailable — fall back to the RPC.
    const rows = await fetchLiveZoneStats();
    if (!cancelledRef.current && rows) {
      mergeLiveStats(rows);
    }
  }, [mergeLiveStats]);

  const loadLiveStats = useCallback(async () => {
    if (cancelledRef.current) return;
    const rows = await fetchLiveZoneStats();
    if (!cancelledRef.current && rows) {
      mergeLiveStats(rows);
    }
  }, [mergeLiveStats]);

  const load = useCallback(
    async ({ showLoading = true } = {}) => {
      if (showLoading) dispatch(setLoading(true));
      try {
        // Zones and snapshot stats load in parallel.
        const [zonesRes, snapshotRes] = await Promise.all([
          supabase
            .from('staging_zones')
            .select('*')
            .eq('active', true)
            .eq('visible_to_drivers', true),
          supabase
            .from('zone_live_stats_snapshot')
            .select('*'),
        ]);

        if (cancelledRef.current) return;
        if (zonesRes.error) throw zonesRes.error;

        const zones = zonesRes.data ?? [];
        dispatch(setZones(zones));
        saveZonesCache(zones);

        const snapshotRows = !snapshotRes.error ? (snapshotRes.data ?? []) : [];

        if (snapshotRows.length > 0) {
          // Primary path: use the cheap snapshot table (refreshed every ~10 s by pg_cron).
          mergeLiveStats(snapshotRows);
        } else {
          // Snapshot empty or migration not applied yet — fall back to the heavy RPC.
          const liveStats = await fetchLiveZoneStats();
          if (!cancelledRef.current) {
            if (liveStats) {
              mergeLiveStats(liveStats);
            } else {
              // Last resort: legacy zone_stats table.
              const { data: statsRows, error: statsErr } = await supabase
                .from('zone_stats')
                .select('*');
              if (!statsErr && statsRows) {
                dispatch(setStats(statsRows));
                const statsMap = {};
                for (const r of statsRows) statsMap[r.zone_id] = r;
                saveStatsCache(statsMap);
                setStatsUpdatedAt(Date.now());
              }
            }
          }
        }

        dispatch(setError(null));
        retryDelayRef.current = 1000;
      } catch (err) {
        if (cancelledRef.current) return;
        dispatch(setError(err.message ?? 'Connection error'));
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
        retryTimerRef.current = setTimeout(() => {
          load({ showLoading: false });
        }, delay);
      } finally {
        if (showLoading) dispatch(setLoading(false));
      }
    },
    [dispatch, mergeLiveStats]
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load({ showLoading: false });
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  useEffect(() => {
    cancelledRef.current = false;

    // Warm from cache immediately.
    (async () => {
      const cachedZones = await loadZonesCache();
      const cached = await loadStatsCache();
      if (cancelledRef.current) return;
      if (cachedZones?.length) dispatch(setZones(cachedZones));
      if (cached.stats) {
        const rows = Object.values(cached.stats);
        if (rows.length) dispatch(setStats(rows));
      }
      if (cached.updatedAt) setStatsUpdatedAt(cached.updatedAt);
    })();

    // Initial load (zones + live stats from RPC).
    load();

    // Backstop poll every 30 s to recover from missed realtime events or
    // a stale snapshot (e.g. pg_cron not yet enabled on this instance).
    pollTimerRef.current = setInterval(() => {
      loadStatsFromSnapshot();
    }, LIVE_POLL_INTERVAL_MS);

    // Primary realtime channel: subscribe to zone_live_stats_snapshot changes
    // (refreshed by pg_cron every ~10 s). Each INSERT/UPDATE carries fresh counts
    // for one zone and costs the client nothing to compute (SCALE-1).
    const snapshotChannel = supabase
      .channel('zone_snapshot_live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'zone_live_stats_snapshot' },
        (payload) => {
          const row = payload.new;
          if (!row?.zone_id) return;
          emitFlash(row.zone_id);
          dispatch(updateZoneStat(row));
          setStatsUpdatedAt(Date.now());
        }
      )
      .subscribe();

    // Secondary realtime channel: driver_presence changes flash the zone in the
    // UI immediately (sub-second feedback) so the staged-car indicator responds
    // before the next snapshot refresh arrives.
    const presenceChannel = supabase
      .channel('driver_presence_live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'driver_presence' },
        (payload) => {
          const zoneId =
            payload.new?.current_zone_id ??
            payload.old?.current_zone_id ??
            null;
          if (zoneId) emitFlash(zoneId);

          // Debounce a snapshot reload so rapid bursts (driver moving between
          // zones fires DELETE + INSERT quickly) become a single read.
          if (presenceDebounceRef.current) {
            clearTimeout(presenceDebounceRef.current);
          }
          presenceDebounceRef.current = setTimeout(() => {
            presenceDebounceRef.current = null;
            loadStatsFromSnapshot();
          }, 500);
        }
      )
      .subscribe();

    return () => {
      cancelledRef.current = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (presenceDebounceRef.current) clearTimeout(presenceDebounceRef.current);
      supabase.removeChannel(snapshotChannel);
      supabase.removeChannel(presenceChannel);
    };
  }, [dispatch, load, loadLiveStats, loadStatsFromSnapshot]);

  return {
    allZones,
    stats,
    loading,
    error,
    refresh,
    refreshing,
    statsUpdatedAt,
  };
}
