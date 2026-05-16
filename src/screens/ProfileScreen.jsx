import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useSelector } from 'react-redux';
import { useAuth } from '../hooks/useAuth';
import StatusToggle from '../components/StatusToggle';

export default function ProfileScreen() {
  const { signOut } = useAuth();
  const session = useSelector((s) => s.drivers.session);
  const profile = useSelector((s) => s.drivers.profile);
  const status = useSelector((s) => s.drivers.status);
  const isGuest = useSelector((s) => s.drivers.isGuest);

  if (isGuest) {
    return (
      <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
        <ScrollView>
          <View className="px-4 pt-4">
            <Text className="text-accent text-2xl font-bold">Profile</Text>
          </View>

          <View className="mx-4 mt-4 bg-panel rounded-lg border border-border p-4">
            <Text className="text-text text-base font-semibold">Driver mode</Text>
            <Text className="text-muted text-sm mt-2">
              You can browse live staging zones and change your driver status
              without signing in.
            </Text>
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
      <ScrollView>
        <View className="px-4 pt-4">
          <Text className="text-accent text-2xl font-bold">Profile</Text>
        </View>

        <View className="mx-4 mt-4 bg-panel rounded-lg border border-border p-4">
          <Text className="text-muted text-xs mb-1">Signed in as</Text>
          <Text className="text-text text-base">
            {session?.user?.phone || session?.user?.email || 'Unknown'}
          </Text>
          {profile?.full_name ? (
            <>
              <Text className="text-muted text-xs mt-3 mb-1">Name</Text>
              <Text className="text-text text-base">{profile.full_name}</Text>
            </>
          ) : null}
          <Text className="text-muted text-xs mt-3 mb-1">Driver ID</Text>
          <Text className="text-text text-xs" numberOfLines={1}>
            {profile?.id ?? session?.user?.id ?? '—'}
          </Text>
          <Text className="text-muted text-xs mt-3 mb-1">Status</Text>
          <Text className="text-text capitalize">{String(status).replace('_', ' ')}</Text>
        </View>

        <View className="mt-2">
          <StatusToggle />
        </View>

        <View className="px-4 mt-6">
          <Pressable
            onPress={signOut}
            className="bg-panel border border-bad rounded-lg py-3 items-center"
          >
            <Text className="text-bad font-semibold">Sign out</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
