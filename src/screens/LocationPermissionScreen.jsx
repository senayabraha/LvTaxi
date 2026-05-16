import React from 'react';
import { View, Text, Pressable, Linking, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Location from 'expo-location';

export default function LocationPermissionScreen({ onGranted }) {
  async function handleEnable() {
    const fg = await Location.requestForegroundPermissionsAsync();
    if (fg.status !== 'granted') {
      Linking.openSettings();
      return;
    }
    const bg = await Location.requestBackgroundPermissionsAsync();
    if (bg.status !== 'granted' && Platform.OS === 'ios') {
      Linking.openSettings();
      return;
    }
    onGranted?.();
  }

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
      <View className="flex-1 px-6 justify-center">
        <Text className="text-accent text-3xl font-bold mb-3">
          📍 Location access needed
        </Text>
        <Text className="text-text mb-6">
          LvTaxi uses your location to tell you which staging zones are nearby
          and to detect when you join or leave a queue. Without location, the
          app can't help you.
        </Text>
        <View className="bg-panel border border-border rounded-lg p-4 mb-6">
          <Text className="text-muted text-xs mb-2">We need:</Text>
          <Text className="text-text mb-1">• "While Using" — for live zones</Text>
          <Text className="text-text">• "Always" — for background queue detection</Text>
        </View>
        <Pressable
          onPress={handleEnable}
          className="bg-accent rounded-lg py-3 items-center mb-3"
        >
          <Text className="text-bg font-bold">Enable location</Text>
        </Pressable>
        <Pressable
          onPress={() => Linking.openSettings()}
          className="items-center py-2"
        >
          <Text className="text-muted">Open system settings</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}
