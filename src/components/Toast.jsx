import React, { useEffect, useRef, useState } from 'react';
import { Animated, Text, View } from 'react-native';
import { registerToast } from '../lib/toast';

const BG = {
  success: '#22c55e',
  error:   '#ef4444',
  info:    '#F5C518',
};

const TEXT = {
  success: '#fff',
  error:   '#fff',
  info:    '#0B0F1A',
};

export default function ToastHost() {
  const [toast, setToast] = useState(null);
  const anim = useRef(new Animated.Value(0)).current;
  const timer = useRef(null);

  useEffect(() => {
    registerToast((message, type = 'info') => {
      if (timer.current) clearTimeout(timer.current);
      setToast({ message, type });
      anim.setValue(0);
      Animated.spring(anim, { toValue: 1, useNativeDriver: true, bounciness: 4 }).start();
      timer.current = setTimeout(() => {
        Animated.timing(anim, { toValue: 0, duration: 250, useNativeDriver: true }).start(() =>
          setToast(null)
        );
      }, 3000);
    });
    return () => {
      if (timer.current) clearTimeout(timer.current);
      registerToast(null);
    };
  }, []);

  if (!toast) return null;

  const translateY = anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] });

  return (
    <Animated.View
      style={{
        position: 'absolute',
        bottom: 150,
        left: 20,
        right: 20,
        zIndex: 9999,
        elevation: 20,
        opacity: anim,
        transform: [{ translateY }],
      }}
      pointerEvents="none"
    >
      <View
        style={{
          backgroundColor: BG[toast.type] ?? BG.info,
          borderRadius: 12,
          paddingHorizontal: 16,
          paddingVertical: 12,
          shadowColor: '#000',
          shadowOpacity: 0.25,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        }}
      >
        <Text style={{ color: TEXT[toast.type] ?? TEXT.info, fontWeight: '600', fontSize: 14 }}>
          {toast.message}
        </Text>
      </View>
    </Animated.View>
  );
}
