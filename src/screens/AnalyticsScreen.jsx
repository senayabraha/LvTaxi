import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, RefreshControl } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSelector } from 'react-redux';
import { supabase } from '../lib/supabase';

function startOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = (day + 6) % 7;
  d.setDate(d.getDate() - diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

function formatHours(seconds) {
  if (!seconds) return '0h';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

const HOUR_LABELS = ['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p'];

function HeatBar({ value, max }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <View
      style={{
        width: 14,
        height: pct + 4,
        backgroundColor: pct > 0 ? '#F5C518' : '#222B45',
        borderRadius: 2,
      }}
    />
  );
}

export default function AnalyticsScreen() {
  const driverId = useSelector((s) => s.drivers.session?.user?.id);
  const allZones = useSelector((s) => s.zones.allZones);
  const [loading, setLoading] = useState(false);
  const [visits, setVisits] = useState([]);

  const load = async () => {
    if (!driverId) return;
    setLoading(true);
    const weekStart = startOfWeek().toISOString();
    const { data, error } = await supabase
      .from('zone_visits')
      .select('*')
      .eq('driver_id', driverId)
      .gte('entered_at', weekStart)
      .order('entered_at', { ascending: false })
      .limit(500);
    setLoading(false);
    if (error) {
      console.warn('[Analytics] load failed', error);
      return;
    }
    setVisits(data ?? []);
  };

  useEffect(() => {
    load();
  }, [driverId]);

  const zoneNameById = useMemo(() => {
    const m = {};
    for (const z of allZones) m[z.id] = z.name;
    return m;
  }, [allZones]);

  const stagingVisits = useMemo(
    () =>
      visits.filter(
        (v) =>
          v.classification === 'staging' ||
          v.confirmed_label === 'staging'
      ),
    [visits]
  );

  const totalStagedSeconds = useMemo(
    () => stagingVisits.reduce((a, v) => a + (v.dwell_seconds ?? 0), 0),
    [stagingVisits]
  );

  const ridesLoaded = stagingVisits.length;

  const perZone = useMemo(() => {
    const map = {};
    for (const v of stagingVisits) {
      const zId = v.zone_id;
      if (!zId) continue;
      if (!map[zId])
        map[zId] = {
          zoneId: zId,
          name: zoneNameById[zId] ?? 'Unknown',
          totalWait: 0,
          count: 0,
        };
      map[zId].totalWait += v.dwell_seconds ?? 0;
      map[zId].count += 1;
    }
    const rows = Object.values(map).map((r) => ({
      ...r,
      avgWait: r.count ? r.totalWait / r.count : 0,
    }));
    rows.sort((a, b) => a.avgWait - b.avgWait);
    return rows;
  }, [stagingVisits, zoneNameById]);

  const heatmap = useMemo(() => {
    const buckets = Array.from({ length: 8 }, () => 0);
    for (const v of stagingVisits) {
      if (!v.entered_at) continue;
      const h = new Date(v.entered_at).getHours();
      buckets[Math.floor(h / 3)] += 1;
    }
    return buckets;
  }, [stagingVisits]);

  const maxBucket = Math.max(...heatmap, 1);

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
      <ScrollView
        refreshControl={
          <RefreshControl
            refreshing={loading}
            onRefresh={load}
            tintColor="#F5C518"
          />
        }
      >
        <View className="px-4 pt-4 pb-2">
          <Text className="text-accent text-2xl font-bold">📊 Analytics</Text>
          <Text className="text-muted text-xs mt-1">This week</Text>
        </View>

        <View className="flex-row mx-4 mt-4 gap-3">
          <View className="flex-1 bg-panel border border-border rounded-lg p-4">
            <Text className="text-muted text-xs">Time staged</Text>
            <Text className="text-text text-2xl font-bold mt-1">
              {formatHours(totalStagedSeconds)}
            </Text>
          </View>
          <View className="flex-1 bg-panel border border-border rounded-lg p-4">
            <Text className="text-muted text-xs">Rides loaded</Text>
            <Text className="text-text text-2xl font-bold mt-1">
              {ridesLoaded}
            </Text>
          </View>
        </View>

        <View className="mx-4 mt-4 bg-panel border border-border rounded-lg p-4">
          <Text className="text-text font-semibold mb-2">Best zones for you</Text>
          {perZone.length === 0 ? (
            <Text className="text-muted text-sm">
              No staging visits yet this week.
            </Text>
          ) : (
            perZone.slice(0, 5).map((row) => (
              <View
                key={row.zoneId}
                className="flex-row justify-between py-2 border-b border-border"
              >
                <Text className="text-text flex-1" numberOfLines={1}>
                  {row.name}
                </Text>
                <Text className="text-muted">
                  avg {formatHours(row.avgWait)} · {row.count} visits
                </Text>
              </View>
            ))
          )}
        </View>

        <View className="mx-4 mt-4 mb-6 bg-panel border border-border rounded-lg p-4">
          <Text className="text-text font-semibold mb-3">
            When you stage (heatmap)
          </Text>
          <View className="flex-row justify-between items-end" style={{ height: 110 }}>
            {heatmap.map((val, i) => (
              <View key={i} className="items-center">
                <HeatBar value={val} max={maxBucket} />
                <Text className="text-muted text-xs mt-2">{HOUR_LABELS[i]}</Text>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
