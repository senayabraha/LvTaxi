import React from 'react';
import { View, Text, Pressable, Alert } from 'react-native';
import { useDispatch, useSelector } from 'react-redux';
import { setStatus } from '../store/driversSlice';
import { DRIVER_STATUS } from '../lib/constants';
import { supabase } from '../lib/supabase';
import {
  startLocationTracking,
  setGPSMode,
  GPS_MODE,
} from '../lib/locationEngine';
import { startGeofenceManager } from '../lib/geofenceEngine';
import { clearDriverPresence } from '../lib/zoneStatsEngine';
import { resetPresenceHeartbeat } from '../lib/presenceHeartbeat';

const OPTIONS = [
  { value: DRIVER_STATUS.ACTIVE, label: 'Active', dot: '#22C55E' },
  { value: DRIVER_STATUS.STAGED, label: 'Staged', dot: '#F5C518' },
  { value: DRIVER_STATUS.OFF_DUTY, label: 'Off Duty', dot: '#EF4444' },
];

export default function StatusToggle() {
  const dispatch = useDispatch();
  const status = useSelector((s) => s.drivers.status);
  const session = useSelector((s) => s.auth.session);

  async function onSelect(value) {
    if (value === status) return;
    const prev = status;
    dispatch(setStatus(value));

    if (session?.user?.id) {
      const { error } = await supabase
        .from('drivers')
        .update({ status: value, last_seen: new Date().toISOString() })
        .eq('id', session.user.id);
      if (error) {
        console.warn('[StatusToggle] update failed', error);
      }
    }

    try {
      if (value === DRIVER_STATUS.OFF_DUTY) {
        // Drop out of live counts immediately rather than waiting for the TTL.
        if (session?.user?.id) {
          await clearDriverPresence(session.user.id);
        }
        resetPresenceHeartbeat();
        await startLocationTracking(GPS_MODE.PASSIVE);
        await setGPSMode(GPS_MODE.PASSIVE);
        startGeofenceManager();
      } else {
        await startLocationTracking(GPS_MODE.HIGH);
        await setGPSMode(GPS_MODE.HIGH);
        startGeofenceManager();
      }
    } catch (err) {
      console.warn('[StatusToggle] tracking transition failed', err);
      Alert.alert(
        'Location required',
        'LvTaxi needs location permission to track your status and zones.'
      );
    }
  }

  return (
    <View className="flex-row flex-wrap gap-2 px-4 py-3">
      {OPTIONS.map((opt) => {
        const active = status === opt.value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onSelect(opt.value)}
            className={`flex-row items-center px-3 py-2 rounded-full border ${
              active ? 'bg-panel2 border-accent' : 'bg-panel border-border'
            }`}
          >
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: opt.dot,
                marginRight: 6,
              }}
            />
            <Text className={active ? 'text-accent' : 'text-text'}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
