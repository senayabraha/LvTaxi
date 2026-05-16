import React from 'react';
import { View, Text, ActivityIndicator } from 'react-native';

export default function SplashScreen() {
  return (
    <View className="flex-1 bg-bg items-center justify-center">
      <Text className="text-accent text-4xl font-bold">🚕 LvTaxi</Text>
      <Text className="text-muted mt-2">Las Vegas staging, live.</Text>
      <ActivityIndicator color="#F5C518" className="mt-6" />
    </View>
  );
}
