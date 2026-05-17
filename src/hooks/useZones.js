import { useCallback, useEffect, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { supabase } from '../lib/supabase';
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

  const load = useCallback(
    async ({ showLoading = true } = {}) => {
      if (showLoading) dispatch(setLoading(true));
      try {
        const [zonesRes, statsRes] = await Promise.all([
          supabase
            .from('staging_zones')
            .select('*')
            .eq('active', true)
            .eq('visible_to_drivers', true),
          supabase.from('zone_stats').select('*'),
        ]);

        if (cancelledRef.current) return;

        if (zonesRes.error) throw zonesRes.error;
        if (statsRes.error) throw statsRes.error;

        const zones = zonesRes.data ?? [];
        const statsRows = statsRes.data ?? [];
        dispatch(setZones(zones));
        dispatch(setStats(statsRows));
        const statsMap = {};
        for (const r of statsRows) statsMap[r.zone_id] = r;
        saveZonesCache(zones);
        saveStatsCache(statsMap);
        setStatsUpdatedAt(Date.now());
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
    [dispatch]
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

    load();

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
          }
        }
      )
      .subscribe();

    return () => {
      cancelledRef.current = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      supabase.removeChannel(channel);
    };
  }, [dispatch, load]);

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
