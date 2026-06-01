import React, { useEffect, useRef } from 'react';
import { Pressable, Text, Animated, Easing } from 'react-native';
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

const GREEN = '#22C55E';
const GREY = '#4B5563';
const WIDTH = 168;
const HEIGHT = 40;
const DOT_SIZE = 32;
const DOT_INSET = 4;

export default function DriverToggle() {
  const dispatch = useDispatch();
  const status = useSelector((s) => s.drivers.status);
  const userId = useSelector((s) => s.auth.session?.user?.id);

  const isOn = status === DRIVER_STATUS.ACTIVE || status === DRIVER_STATUS.STAGED;

  const anim = useRef(new Animated.Value(isOn ? 1 : 0)).current;

  useEffect(() => {
    Animated.timing(anim, {
      toValue: isOn ? 1 : 0,
      duration: 300,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [isOn, anim]);

  const bg = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [GREY, GREEN],
  });
  const dotX = anim.interpolate({
    inputRange: [0, 1],
    outputRange: [DOT_INSET, WIDTH - DOT_SIZE - DOT_INSET],
  });

  async function onPress() {
    const nextStatus = isOn ? DRIVER_STATUS.OFF_DUTY : DRIVER_STATUS.ACTIVE;
    dispatch(setStatus(nextStatus));

    try {
      // Off-duty keeps a low-power GPS watch for geofencing/work-area only —
      // the driver is cleared from live presence counts (see clearDriverPresence).
      // Notifications are suppressed elsewhere when off-duty.
      if (nextStatus === DRIVER_STATUS.OFF_DUTY) {
        // Drop out of live counts immediately rather than waiting for the TTL.
        if (userId) {
          await clearDriverPresence(userId);
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
      console.warn('[DriverToggle] tracking transition failed', err);
    }

    if (userId) {
      const { error } = await supabase
        .from('drivers')
        .update({ status: nextStatus, last_seen: new Date().toISOString() })
        .eq('id', userId);
      if (error) console.warn('[DriverToggle] update failed', error.message);
    }
  }

  return (
    <Pressable onPress={onPress}>
      <Animated.View
        style={{
          width: WIDTH,
          height: HEIGHT,
          borderRadius: HEIGHT / 2,
          backgroundColor: bg,
          justifyContent: 'center',
          paddingHorizontal: 12,
        }}
      >
        <Text
          style={{
            color: 'white',
            fontWeight: '600',
            fontSize: 12,
            textAlign: isOn ? 'left' : 'right',
          }}
        >
          {isOn ? '🟢 Driving' : '⚫ Off (still tracked)'}
        </Text>
        <Animated.View
          style={{
            position: 'absolute',
            top: DOT_INSET,
            left: dotX,
            width: DOT_SIZE,
            height: DOT_SIZE,
            borderRadius: DOT_SIZE / 2,
            backgroundColor: 'white',
          }}
        />
      </Animated.View>
    </Pressable>
  );
}
