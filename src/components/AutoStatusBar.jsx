import React, { useMemo } from 'react';
import { View, Text } from 'react-native';
import { useSelector } from 'react-redux';
import { DRIVER_STATUS } from '../lib/constants';
import { TIER_CONFIG, TIER } from '../lib/tierManager';

const STATUS_LABEL = {
  [DRIVER_STATUS.PASSIVE_FAR]:       { icon: '⚪', text: 'Passive (far)',   tone: 'muted' },
  [DRIVER_STATUS.PASSIVE_NEAR]:      { icon: '🔵', text: 'Passive (near)',  tone: 'muted' },
  [DRIVER_STATUS.ACTIVE]:            { icon: '🟢', text: 'Active',          tone: 'text' },
  [DRIVER_STATUS.STAGED]:            { icon: '🟡', text: 'Staging',         tone: 'accent' },
  [DRIVER_STATUS.EXIT_GRACE]:        { icon: '🟠', text: 'Leaving area',    tone: 'text' },
  [DRIVER_STATUS.TRACKING_DISABLED]: { icon: '🔴', text: 'Tracking off',    tone: 'muted' },
  // Legacy fallback.
  [DRIVER_STATUS.OFF_DUTY]:          { icon: '🔴', text: 'Off Duty',        tone: 'muted' },
};

export default function AutoStatusBar() {
  const status = useSelector((s) => s.drivers.status);
  const currentZoneId = useSelector((s) => s.drivers.currentZoneId);
  const allZones = useSelector((s) => s.zones.allZones);
  const gpsTier = useSelector((s) => s.drivers.gpsTier ?? TIER.THREE);

  const zoneName = useMemo(() => {
    if (!currentZoneId) return null;
    const z = allZones.find((x) => x.id === currentZoneId);
    return z?.name ?? null;
  }, [currentZoneId, allZones]);

  const meta = STATUS_LABEL[status] ?? STATUS_LABEL[DRIVER_STATUS.TRACKING_DISABLED];
  const showZone = status === DRIVER_STATUS.STAGED && zoneName;
  const tierLabel = TIER_CONFIG[gpsTier]?.label ?? '—';

  const toneClass =
    meta.tone === 'accent' ? 'text-accent'
    : meta.tone === 'muted' ? 'text-muted'
    : 'text-text';

  return (
    <View className="flex-row items-center">
      <Text className={`${toneClass} text-base font-semibold`}>
        {meta.icon} {meta.text}
        {showZone ? <Text className="text-text"> at {zoneName}</Text> : null}
      </Text>
      <Text className="text-muted text-xs ml-2">📡 {tierLabel}</Text>
    </View>
  );
}
