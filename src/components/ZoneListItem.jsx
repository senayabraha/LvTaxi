import React, { memo, useEffect, useRef } from 'react';
import { Animated, Easing, View, Text } from 'react-native';
import { onZoneStatFlash } from '../hooks/useZones';

export const ZONE_ITEM_HEIGHT = 80;

function waitColor(wait) {
  if (wait == null) return '#8A93A6';
  if (wait < 10) return '#22C55E';
  if (wait <= 20) return '#EAB308';
  return '#EF4444';
}

function waitTint(wait) {
  if (wait == null) return 'transparent';
  if (wait < 10) return 'rgba(34,197,94,0.08)';
  if (wait <= 20) return 'rgba(234,179,8,0.08)';
  return 'rgba(239,68,68,0.10)';
}

function formatWait(mins) {
  if (mins == null) return '—';
  if (mins < 60) return `${Math.round(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  return `${h}h ${m}m`;
}

function ZoneListItem({
  zone,
  stat,
  isCurrentZone,
  driverPosition,
  driverWaitMinutes,
}) {
  if (zone.is_coming_soon) {
    return (
      <View
        className="mx-4 my-1 rounded-lg bg-panel"
        style={{ opacity: 0.45 }}
      >
        <View className="flex-row items-center px-4 py-3">
          <Text className="text-muted italic flex-1" numberOfLines={1}>
            {zone.name} — Coming Soon
          </Text>
        </View>
      </View>
    );
  }

  const cars = stat?.cars_staged ?? 0;
  const flow = stat?.flow_rate_per_hour ?? 0;
  const wait = stat?.wait_time_minutes ?? null;
  const color = waitColor(wait);
  const tint = waitTint(wait);

  const flashAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const off = onZoneStatFlash((zoneId) => {
      if (zoneId !== zone.id) return;
      flashAnim.setValue(1);
      Animated.timing(flashAnim, {
        toValue: 0,
        duration: 900,
        easing: Easing.out(Easing.quad),
        useNativeDriver: false,
      }).start();
    });
    return off;
  }, [zone.id, flashAnim]);

  useEffect(() => {
    if (!isCurrentZone) {
      pulseAnim.stopAnimation();
      pulseAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
        Animated.timing(pulseAnim, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: false,
        }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isCurrentZone, pulseAnim]);

  const flashBg = flashAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [tint, 'rgba(245,197,24,0.20)'],
  });

  const pulseBorder = pulseAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['rgba(245,197,24,0.35)', 'rgba(245,197,24,1)'],
  });

  return (
    <Animated.View
      style={{
        borderLeftColor: color,
        borderLeftWidth: 4,
        backgroundColor: flashBg,
        borderColor: isCurrentZone ? pulseBorder : 'transparent',
        borderWidth: isCurrentZone ? 1.5 : 0,
      }}
      className="mx-4 my-1 rounded-lg bg-panel"
    >
      <View className="flex-row items-center px-4 py-3">
        <View className="w-14 items-start">
          <Text className="text-text text-2xl font-bold">{cars}</Text>
          <Text className="text-muted text-xs">cars</Text>
        </View>

        <View className="w-20 items-start">
          <Text className="text-text text-base">{Math.round(flow)}/hr</Text>
          <Text className="text-muted text-xs">flow</Text>
        </View>

        <View className="w-24 items-start">
          <Text style={{ color }} className="text-base font-semibold">
            {formatWait(wait)}
          </Text>
          <Text className="text-muted text-xs">wait</Text>
        </View>

        <View className="flex-1 items-end">
          <Text className="text-text text-right" numberOfLines={1}>
            {zone.name}
          </Text>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: color,
              marginTop: 4,
            }}
          />
        </View>
      </View>

      {isCurrentZone ? (
        <View className="px-4 pb-3">
          <Text className="text-accent text-xs">
            📍 You are here
            {driverPosition != null ? ` — Position #${driverPosition}` : ''}
            {driverWaitMinutes != null
              ? ` — Your wait: ~${Math.round(driverWaitMinutes)} mins`
              : ''}
          </Text>
        </View>
      ) : null}
    </Animated.View>
  );
}

function areEqual(prev, next) {
  if (prev.isCurrentZone !== next.isCurrentZone) return false;
  if (prev.driverPosition !== next.driverPosition) return false;
  if (prev.driverWaitMinutes !== next.driverWaitMinutes) return false;
  if (prev.zone.id !== next.zone.id) return false;
  const a = prev.stat ?? {};
  const b = next.stat ?? {};
  return (
    a.cars_staged === b.cars_staged &&
    a.flow_rate_per_hour === b.flow_rate_per_hour &&
    a.wait_time_minutes === b.wait_time_minutes
  );
}

export default memo(ZoneListItem, areEqual);
