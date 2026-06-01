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

// How often to re-poll live stats from the RPC (supplements realtime).
// Live counts depend on 90-second TTL pings so polling keeps things honest.
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
        const [zonesRes, liveStats] = await Promise.all([
          supabase
            .from('staging_zones')
            .select('*')
            .eq('active', true)
            .eq('visible_to_drivers', true),
          fetchLiveZoneStats(),
        ]);

        if (cancelledRef.current) return;
        if (zonesRes.error) throw zonesRes.error;

        const zones = zonesRes.data ?? [];
        dispatch(setZones(zones));
        saveZonesCache(zones);

        if (liveStats) {
          mergeLiveStats(liveStats);
        } else {
          // Fallback: load from zone_stats table directly.
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

    // Poll live stats every 30 s so stale drivers fall out of count even
    // without a realtime event.
    pollTimerRef.current = setInterval(() => {
      loadLiveStats();
    }, LIVE_POLL_INTERVAL_MS);

    // Realtime subscription on zone_stats for instant display flashes.
    // Note: realtime shows legacy cache rows — enriched fields come from polling.
    const channel = supabase
      .channel('zone_stats_changes')
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'zone_stats' },
        (payload) => {
          if (payload.new) {
            dispatch(updateZoneStat(payload.new));
            setStatsUpdatedAt(Date.now());
            emitFlash(payload.new.zone_id);
            // Refresh enriched fields from live RPC after every realtime ping.
            loadLiveStats();
          }
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'zone_stats' },
        (payload) => {
          if (payload.new) {
            dispatch(updateZoneStat(payload.new));
            setStatsUpdatedAt(Date.now());
            emitFlash(payload.new.zone_id);
            loadLiveStats();
          }
        }
      )
      .subscribe();

    return () => {
      cancelledRef.current = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      supabase.removeChannel(channel);
    };
  }, [dispatch, load, loadLiveStats]);

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
