import React, { memo, useEffect, useRef } from 'react';
import { Animated, Easing, View, Text } from 'react-native';
import { onZoneStatFlash } from '../hooks/useZones';
import { secondsSincePing } from '../lib/presenceFreshness';
import { PRESENCE_TTL_SECONDS } from '../lib/constants';

export const ZONE_ITEM_HEIGHT = 96;

// ── Color helpers ─────────────────────────────────────────────────────────────

function waitColor(stat) {
  const confidence = stat?.wait_confidence;
  const status = stat?.wait_status;
  const wait = stat?.estimated_wait_minutes ?? stat?.wait_time_minutes;

  if (!stat || status === 'INSUFFICIENT_DATA' || status === 'NO_RECENT_MOVEMENT') {
    return '#8A93A6'; // muted gray
  }
  if (confidence === 'LOW') return '#CA8A04'; // amber caution
  if (wait == null) return '#8A93A6';
  if (wait < 10) return '#22C55E';  // green
  if (wait <= 20) return '#EAB308'; // yellow
  return '#EF4444';                 // red
}

function waitTint(stat) {
  const color = waitColor(stat);
  if (color === '#8A93A6') return 'transparent';
  if (color === '#22C55E') return 'rgba(34,197,94,0.08)';
  if (color === '#EAB308') return 'rgba(234,179,8,0.08)';
  if (color === '#CA8A04') return 'rgba(202,138,4,0.06)';
  return 'rgba(239,68,68,0.10)';
}

// ── Wait-range formatter ──────────────────────────────────────────────────────

function formatWaitRange(stat) {
  if (!stat) return '—';
  const status = stat.wait_status;
  if (status === 'INSUFFICIENT_DATA') return 'Not enough data';
  if (status === 'NO_RECENT_MOVEMENT') return 'No recent movement';

  if (stat.estimated_wait_min != null && stat.estimated_wait_max != null) {
    return `${Math.round(stat.estimated_wait_min)}–${Math.round(stat.estimated_wait_max)} min`;
  }
  if (stat.estimated_wait_minutes != null) {
    return `~${Math.round(stat.estimated_wait_minutes)} min`;
  }
  // Fallback to legacy field so old data still renders.
  if (stat.wait_time_minutes != null) {
    return `~${Math.round(stat.wait_time_minutes)} min`;
  }
  return '—';
}

// ── Driver "you are here" line ────────────────────────────────────────────────

function formatDriverLine(stat, driverPosition, driverWaitMinutes) {
  const parts = ['📍 You are here'];
  if (driverPosition != null) parts.push(`Position #${driverPosition}`);

  // Prefer new wait range fields from the live stat.
  const wRange = formatWaitRange(stat);
  if (wRange && wRange !== '—') {
    parts.push(`Your wait: ${wRange}`);
  } else if (driverWaitMinutes != null) {
    parts.push(`Your wait: ~${Math.round(driverWaitMinutes)} min`);
  }
  return parts.join(' — ');
}

// ── Confidence badge ──────────────────────────────────────────────────────────

function confidenceLabel(confidence) {
  switch (confidence) {
    case 'HIGH':             return 'High confidence';
    case 'MEDIUM':           return 'Medium confidence';
    case 'LOW':              return 'Low confidence';
    case 'INSUFFICIENT_DATA':
    default:                 return 'Low data';
  }
}

function confidenceLabelColor(confidence) {
  switch (confidence) {
    case 'HIGH':   return '#22C55E';
    case 'MEDIUM': return '#EAB308';
    case 'LOW':    return '#CA8A04';
    default:       return '#8A93A6';
  }
}

// ── Freshness label ───────────────────────────────────────────────────────────

function freshnessLabel(lastUpdated) {
  const elapsed = secondsSincePing(lastUpdated);
  if (elapsed == null) return null;
  if (elapsed > PRESENCE_TTL_SECONDS) return 'Data stale';
  if (elapsed < 10) return 'Live';
  if (elapsed < 60) return `Updated ${elapsed}s ago`;
  return `Updated ${Math.round(elapsed / 60)} min ago`;
}

function freshnessColor(lastUpdated) {
  const elapsed = secondsSincePing(lastUpdated);
  if (elapsed == null || elapsed > PRESENCE_TTL_SECONDS) return '#EF4444'; // stale → red
  if (elapsed < 10) return '#22C55E'; // live → green
  return '#8A93A6';                   // aging → muted
}

// ── Component ─────────────────────────────────────────────────────────────────

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
  const color = waitColor(stat);
  const tint = waitTint(stat);

  const confidence = stat?.wait_confidence ?? null;
  const waitLabel = formatWaitRange(stat);
  const freshLabel = freshnessLabel(stat?.last_updated ?? stat?.updated_at);
  const freshColor = freshnessColor(stat?.last_updated ?? stat?.updated_at);

  const showConfidence =
    confidence != null && confidence !== 'INSUFFICIENT_DATA';

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
      {/* ── Main stats row ── */}
      <View className="flex-row items-center px-4 pt-3 pb-1">
        <View className="w-14 items-start">
          <Text className="text-text text-2xl font-bold">{cars}</Text>
          <Text className="text-muted text-xs">cars</Text>
        </View>

        <View className="w-20 items-start">
          <Text className="text-text text-base">{Math.round(flow)}/hr</Text>
          <Text className="text-muted text-xs">flow</Text>
        </View>

        <View className="w-28 items-start">
          <Text style={{ color }} className="text-base font-semibold" numberOfLines={1}>
            {waitLabel}
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

      {/* ── Confidence + freshness meta row ── */}
      <View className="flex-row items-center px-4 pb-2 gap-3">
        {showConfidence ? (
          <Text
            style={{ color: confidenceLabelColor(confidence), fontSize: 10 }}
          >
            {confidenceLabel(confidence)}
          </Text>
        ) : null}
        {freshLabel ? (
          <Text style={{ color: freshColor, fontSize: 10 }}>
            {freshLabel}
          </Text>
        ) : null}
      </View>

      {/* ── "You are here" row ── */}
      {isCurrentZone ? (
        <View className="px-4 pb-3">
          <Text className="text-accent text-xs">
            {formatDriverLine(stat, driverPosition, driverWaitMinutes)}
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
    a.estimated_wait_minutes === b.estimated_wait_minutes &&
    a.estimated_wait_min === b.estimated_wait_min &&
    a.estimated_wait_max === b.estimated_wait_max &&
    a.wait_confidence === b.wait_confidence &&
    a.wait_status === b.wait_status &&
    a.last_updated === b.last_updated &&
    // Legacy fallback field.
    a.wait_time_minutes === b.wait_time_minutes
  );
}

export default memo(ZoneListItem, areEqual);
