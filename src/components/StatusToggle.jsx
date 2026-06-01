// StatusToggle — now a READ-ONLY automatic status indicator.
//
// The old version let the driver tap Active / Staged / Off Duty. The automatic
// tracking architecture removes manual shift control entirely: status is derived
// from GPS position vs the work-area / staging-zone polygons by the background
// tasks. There is no driver-facing "Off Duty" workflow anymore. To turn tracking
// off entirely (the only manual override) use the Tracking setting on the Profile
// screen, which sets TRACKING_DISABLED, clears presence, and stops all tasks.

import React from 'react';
import { View, Text } from 'react-native';
import { useSelector } from 'react-redux';
import { DRIVER_STATUS } from '../lib/constants';

const STATUS_META = {
  [DRIVER_STATUS.PASSIVE_FAR]:       { dot: '#6B7280', label: 'Passive · Far' },
  [DRIVER_STATUS.PASSIVE_NEAR]:      { dot: '#3B82F6', label: 'Passive · Near' },
  [DRIVER_STATUS.ACTIVE]:            { dot: '#22C55E', label: 'Active' },
  [DRIVER_STATUS.STAGED]:            { dot: '#F5C518', label: 'Staged' },
  [DRIVER_STATUS.EXIT_GRACE]:        { dot: '#F97316', label: 'Exit Grace' },
  [DRIVER_STATUS.TRACKING_DISABLED]: { dot: '#EF4444', label: 'Tracking Disabled' },
  [DRIVER_STATUS.OFF_DUTY]:          { dot: '#EF4444', label: 'Off Duty' },
};

export default function StatusToggle() {
  const status = useSelector((s) => s.drivers.status);
  const meta = STATUS_META[status] ?? STATUS_META[DRIVER_STATUS.TRACKING_DISABLED];

  return (
    <View className="flex-row items-center px-4 py-3">
      <View className="flex-row items-center px-3 py-2 rounded-full border bg-panel2 border-accent">
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: meta.dot,
            marginRight: 6,
          }}
        />
        <Text className="text-accent">{meta.label}</Text>
      </View>
      <Text className="text-muted text-xs ml-3">Automatic · no shift toggle</Text>
    </View>
  );
}
