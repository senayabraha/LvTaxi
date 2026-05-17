import React from 'react';
import { View, Text, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDispatch, useSelector } from 'react-redux';
import { signOut } from '../lib/sessionManager';
import StatusToggle from '../components/StatusToggle';

export default function ProfileScreen() {
  const dispatch = useDispatch();
  const session = useSelector((s) => s.auth.session);
  const isAdmin = useSelector((s) => s.auth.isAdmin);
  const profile = useSelector((s) => s.drivers.profile);
  const status = useSelector((s) => s.drivers.status);

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
          <Text className="text-text capitalize">
            {String(status).replace('_', ' ')}
          </Text>
          {isAdmin ? (
            <>
              <Text className="text-muted text-xs mt-3 mb-1">Role</Text>
              <Text className="text-accent text-base">Admin</Text>
            </>
          ) : null}
          <Text className="text-muted text-xs mt-3 mb-1">Subscription</Text>
          <Text className="text-text capitalize">
            {profile?.subscription_tier ?? 'free'}
          </Text>
        </View>

        <View className="mt-2">
          <StatusToggle />
        </View>

        <View className="px-4 mt-6">
          <Pressable
            onPress={() => signOut(dispatch)}
            className="bg-panel border border-bad rounded-lg py-3 items-center"
          >
            <Text className="text-bad font-semibold">Sign out</Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
