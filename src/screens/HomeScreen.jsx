import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, FlatList, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDispatch, useSelector } from 'react-redux';
import SortBar from '../components/SortBar';
import AutoStatusBar from '../components/AutoStatusBar';
import ImStagingButton from '../components/ImStagingButton';
import ZoneListItem, { ZONE_ITEM_HEIGHT } from '../components/ZoneListItem';
import ConnectionBanner from '../components/ConnectionBanner';
import ToastHost from '../components/Toast';
import { useZones } from '../hooks/useZones';
import {
  DRIVER_STATUS,
  SORT_OPTIONS,
  isActiveParticipationStatus,
} from '../lib/constants';
import { getDistanceMeters } from '../lib/locationEngine';
import {
  startGeofenceManager,
  stopGeofenceManager,
  getWaitSortValue,
} from '../lib/geofenceEngine';
import {
  startTierManager,
  refreshZoneCache,
} from '../lib/tierManager';
import { setSort } from '../store/zonesSlice';
import { getDriverPositionInZone } from '../lib/zoneStatsEngine';
import { initNotifications } from '../lib/notificationService';
import {
  startNotificationEngine,
  stopNotificationEngine,
} from '../lib/notificationEngine';

const STATUS_DEFAULT_SORT = {
  [DRIVER_STATUS.ACTIVE]: SORT_OPTIONS.WAIT,
  [DRIVER_STATUS.STAGED]: SORT_OPTIONS.NEAREST,
};

export default function HomeScreen() {
  const dispatch = useDispatch();
  const { allZones, stats, loading, error, refresh, refreshing, statsUpdatedAt } =
    useZones();
  const activeSort = useSelector((s) => s.zones.activeSort);
  const status = useSelector((s) => s.drivers.status);
  const currentLat = useSelector((s) => s.drivers.currentLat);
  const currentLng = useSelector((s) => s.drivers.currentLng);
  const currentZoneId = useSelector((s) => s.drivers.currentZoneId);
  const zoneEntryTime = useSelector((s) => s.drivers.zoneEntryTime);

  const [now, setNow] = useState(() => new Date());
  const [driverPosition, setDriverPosition] = useState(null);
  const prevStatusRef = useRef(status);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    initNotifications().catch((err) =>
      console.warn('[HomeScreen] initNotifications failed', err)
    );
    startTierManager().catch((err) =>
      console.warn('[HomeScreen] startTierManager failed', err)
    );
    refreshZoneCache().catch((err) =>
      console.warn('[HomeScreen] refreshZoneCache failed', err)
    );
  }, []);

  useEffect(() => {
    // Geofencing always runs as a cheap OS wake-up layer; the polygon checks in
    // the background tasks remain the source of truth for participation.
    startGeofenceManager();
    // Zone notifications only matter while participating (inside / leaving the
    // work area). Passive and tracking-disabled drivers get no zone alerts.
    if (isActiveParticipationStatus(status)) {
      startNotificationEngine();
    } else {
      stopNotificationEngine();
    }
    return () => {
      stopGeofenceManager();
      stopNotificationEngine();
    };
  }, [status]);

  useEffect(() => {
    if (prevStatusRef.current === status) return;
    prevStatusRef.current = status;
    const nextSort = STATUS_DEFAULT_SORT[status];
    if (nextSort) dispatch(setSort(nextSort));
  }, [status, dispatch]);

  const enriched = useMemo(() => {
    return allZones.map((z) => {
      const stat = stats[z.id];
      const distance =
        !z.is_coming_soon && currentLat != null && currentLng != null
          ? getDistanceMeters(currentLat, currentLng, z.lat, z.lng)
          : null;
      return { zone: z, stat, distance };
    });
  }, [allZones, stats, currentLat, currentLng]);

  const sortedZones = useMemo(() => {
    const active = enriched.filter((e) => !e.zone.is_coming_soon);
    const comingSoon = enriched.filter((e) => e.zone.is_coming_soon);

    if (activeSort === SORT_OPTIONS.NEAREST) {
      active.sort((a, b) => {
        if (a.distance == null && b.distance == null) return 0;
        if (a.distance == null) return 1;
        if (b.distance == null) return -1;
        return a.distance - b.distance;
      });
    } else if (activeSort === SORT_OPTIONS.FLOW) {
      active.sort(
        (a, b) =>
          (b.stat?.flow_rate_per_hour ?? 0) -
          (a.stat?.flow_rate_per_hour ?? 0)
      );
    } else {
      // Sort by best estimated wait using the shared key: prefers the new
      // estimated_wait_minutes, falls back to legacy wait_time_minutes, and
      // pushes zones with no usable estimate (insufficient data / no recent
      // movement) to the bottom instead of the top.
      active.sort((a, b) => getWaitSortValue(a.stat) - getWaitSortValue(b.stat));
    }

    // Coming Soon always last, alphabetical.
    comingSoon.sort((a, b) => a.zone.name.localeCompare(b.zone.name));
    return [...active, ...comingSoon];
  }, [enriched, activeSort]);

  useEffect(() => {
    let cancelled = false;
    async function loadPosition() {
      if (!currentZoneId || !zoneEntryTime) {
        setDriverPosition(null);
        return;
      }
      const enteredAtIso = new Date(zoneEntryTime).toISOString();
      const pos = await getDriverPositionInZone(currentZoneId, enteredAtIso);
      if (!cancelled) setDriverPosition(pos);
    }
    loadPosition();
    return () => {
      cancelled = true;
    };
  }, [currentZoneId, zoneEntryTime, stats]);

  // Prefer new estimated_wait_minutes; fall back to legacy field.
  const currentZoneStat = currentZoneId ? stats[currentZoneId] : null;
  const currentZoneWait =
    currentZoneStat?.estimated_wait_minutes ??
    currentZoneStat?.wait_time_minutes ??
    null;

  const renderItem = useCallback(
    ({ item }) => (
      <ZoneListItem
        zone={item.zone}
        stat={item.stat}
        isCurrentZone={item.zone.id === currentZoneId}
        driverPosition={item.zone.id === currentZoneId ? driverPosition : null}
        driverWaitMinutes={item.zone.id === currentZoneId ? currentZoneWait : null}
      />
    ),
    [currentZoneId, driverPosition, currentZoneWait]
  );

  const getItemLayout = useCallback(
    (_, index) => ({
      length: ZONE_ITEM_HEIGHT,
      offset: ZONE_ITEM_HEIGHT * index,
      index,
    }),
    []
  );

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
      <View className="flex-row items-center justify-between px-4 pt-2 pb-2">
        <View className="flex-1 mr-3">
          <AutoStatusBar />
          <Text className="text-muted text-xs mt-1">
            {now.toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </Text>
        </View>
        <Text className="text-accent text-2xl font-bold">🚕 LvTaxi</Text>
      </View>

      <ConnectionBanner updatedAt={statsUpdatedAt} error={error} />

      <SortBar />

      <FlatList
        data={sortedZones}
        keyExtractor={(item) => item.zone.id}
        renderItem={renderItem}
        getItemLayout={getItemLayout}
        initialNumToRender={12}
        maxToRenderPerBatch={10}
        windowSize={7}
        removeClippedSubviews
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refresh}
            tintColor="#F5C518"
          />
        }
        ListEmptyComponent={
          <View className="px-4 py-12 items-center">
            <Text className="text-muted">
              {loading
                ? 'Loading zones…'
                : 'No zones found. Did you run the seed script?'}
            </Text>
          </View>
        }
        contentContainerStyle={{ paddingBottom: 24 }}
      />

      <ImStagingButton />
      <ToastHost />
    </SafeAreaView>
  );
}
