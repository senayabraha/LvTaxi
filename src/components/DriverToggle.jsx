import React, { useEffect, useRef } from 'react';
import { Pressable, Text, Animated, Easing } from 'react-native';
import { useSelector } from 'react-redux';
import { DRIVER_STATUS } from '../lib/constants';
import {
  enableTrackingFromUI,
  disableTrackingFromUI,
} from '../lib/backgroundTracking/backgroundTrackingService';

const GREEN = '#22C55E';
const GREY = '#4B5563';
const WIDTH = 168;
const HEIGHT = 40;
const DOT_SIZE = 32;
const DOT_INSET = 4;

export default function DriverToggle() {
  const status = useSelector((s) => s.drivers.status);
  const trackingEnabled = useSelector((s) => s.drivers.trackingEnabled);

  const isOn = trackingEnabled && status !== DRIVER_STATUS.TRACKING_DISABLED;

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
    try {
      if (isOn) {
        await disableTrackingFromUI();
      } else {
        await enableTrackingFromUI();
      }
    } catch (err) {
      console.warn('[DriverToggle] tracking transition failed', err);
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
          {isOn ? '🟢 Tracking On' : '⚫ Tracking Off'}
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
