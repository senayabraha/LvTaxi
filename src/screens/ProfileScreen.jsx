import React, { useState } from 'react';
import { View, Text, Pressable, ScrollView, Alert, ActivityIndicator, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDispatch, useSelector } from 'react-redux';
import { signOut } from '../lib/sessionManager';
import { supabase } from '../lib/supabase';
import {
  enableTrackingFromUI,
  disableTrackingFromUI,
} from '../lib/backgroundTracking/backgroundTrackingService';
import TrackingDebugPanel from '../components/TrackingDebugPanel';

export default function ProfileScreen() {
  const dispatch = useDispatch();
  const session = useSelector((s) => s.auth.session);
  const isAdmin = useSelector((s) => s.auth.isAdmin);
  const profile = useSelector((s) => s.drivers.profile);
  const status = useSelector((s) => s.drivers.status);
  const trackingEnabled = useSelector((s) => s.drivers.trackingEnabled);
  const [deleting, setDeleting] = useState(false);
  const [trackingBusy, setTrackingBusy] = useState(false);

  async function onToggleTracking(next) {
    if (trackingBusy) return;
    setTrackingBusy(true);
    try {
      if (next) {
        const ok = await enableTrackingFromUI();
        if (!ok) {
          Alert.alert(
            'Location permission needed',
            'LV Taxi needs location permission to track automatically. Enable it in system settings, then try again.'
          );
        }
      } else {
        await disableTrackingFromUI();
      }
    } catch (err) {
      console.warn('[ProfileScreen] toggle tracking failed', err);
    } finally {
      setTrackingBusy(false);
    }
  }

  async function performDelete() {
    setDeleting(true);
    try {
      const { error } = await supabase.functions.invoke('delete-account');
      if (error) {
        setDeleting(false);
        Alert.alert(
          'Could not delete account',
          error.message || 'Please try again or contact support@lvtaxi.online.'
        );
        return;
      }
      await signOut(dispatch);
    } catch (err) {
      setDeleting(false);
      Alert.alert(
        'Could not delete account',
        err?.message || 'Please try again or contact support@lvtaxi.online.'
      );
    }
  }

  function confirmDelete() {
    Alert.alert(
      'Delete account?',
      'This permanently removes your account and personal data. Aggregated zone statistics that no longer identify you are retained. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: performDelete },
      ]
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

        {/* ── Automatic tracking setting ─────────────────────────────────── */}
        <View className="mx-4 mt-4 bg-panel rounded-lg border border-border p-4">
          <View className="flex-row items-center justify-between">
            <View className="flex-1 mr-3">
              <Text className="text-text text-base font-semibold">
                Automatic tracking
              </Text>
              <Text className="text-muted text-xs mt-1">
                Keeps your staging-zone position accurate automatically. No Start
                or End Shift needed.
              </Text>
            </View>
            {trackingBusy ? (
              <ActivityIndicator color="#F5C518" />
            ) : (
              <Switch
                value={trackingEnabled !== false}
                onValueChange={onToggleTracking}
                trackColor={{ false: '#4B5563', true: '#F5C518' }}
                thumbColor="#FFFFFF"
              />
            )}
          </View>
          <Text className="text-muted text-xs mt-3">
            LV Taxi can track automatically while the app is in the background or
            the screen is locked. If you force-close the app, tracking may stop
            until you reopen it.
          </Text>
        </View>

        {/* Dev-only: renders null in production builds. */}
        <TrackingDebugPanel />

        <View className="px-4 mt-6">
          <Pressable
            onPress={() => signOut(dispatch)}
            disabled={deleting}
            className="bg-panel border border-bad rounded-lg py-3 items-center"
          >
            <Text className="text-bad font-semibold">Sign out</Text>
          </Pressable>
        </View>

        <View className="px-4 mt-3 mb-6">
          <Pressable
            onPress={confirmDelete}
            disabled={deleting}
            className="rounded-lg py-3 items-center"
          >
            {deleting ? (
              <ActivityIndicator color="#E5484D" />
            ) : (
              <Text className="text-muted">Delete account</Text>
            )}
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
