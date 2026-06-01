import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDispatch, useSelector } from 'react-redux';
import { supabase } from '../lib/supabase';
import { setProfile } from '../store/driversSlice';
import { setIsAdmin } from '../store/authSlice';
import { DRIVER_STATUS } from '../lib/constants';

export default function NameScreen({ navigation }) {
  const dispatch = useDispatch();
  const userId = useSelector((s) => s.auth.session?.user?.id);
  const userPhone = useSelector((s) => s.auth.session?.user?.phone) ?? null;
  const userEmail = useSelector((s) => s.auth.session?.user?.email) ?? null;

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(skip = false) {
    if (!userId) {
      setError('Not signed in.');
      return;
    }
    setBusy(true);
    setError(null);
    const row = {
      id: userId,
      full_name: skip || !name.trim() ? 'Driver' : name.trim(),
      phone: userPhone,
      email: userEmail,
      role: 'driver',
      // New drivers start with tracking disabled; app-launch reconciliation moves
      // them into passive/active automatically once permission + position resolve.
      status: DRIVER_STATUS.TRACKING_DISABLED,
      tracking_enabled: true,
      subscription_tier: 'free',
    };
    const { data, error: err } = await supabase
      .from('drivers')
      .upsert(row, { onConflict: 'id' })
      .select()
      .maybeSingle();
    setBusy(false);
    if (err) {
      setError(err.message || 'Could not save profile.');
      return;
    }
    dispatch(setProfile(data ?? row));
    dispatch(setIsAdmin(false));
    navigation.navigate('LocationPermission');
  }

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <View className="flex-row justify-end px-4 pt-2">
          <Pressable disabled={busy} onPress={() => submit(true)}>
            <Text className="text-muted">Skip</Text>
          </Pressable>
        </View>

        <View className="flex-1 px-6 justify-center">
          <Text className="text-accent text-3xl font-bold">
            What should we call you?
          </Text>
          <Text className="text-muted mt-2 mb-6">
            Your name is only visible to you.
          </Text>

          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Your first name"
            placeholderTextColor="#5A6478"
            autoCapitalize="words"
            className="bg-panel border border-border rounded-lg px-4 h-14 text-text text-lg"
          />

          {error ? (
            <Text className="text-bad mt-3 text-sm">{error}</Text>
          ) : null}

          <Pressable
            disabled={busy}
            onPress={() => submit(false)}
            className={`mt-6 rounded-lg items-center justify-center ${
              busy ? 'bg-panel border border-border' : 'bg-accent'
            }`}
            style={{ height: 56 }}
          >
            {busy ? (
              <ActivityIndicator color="#0B0F1A" />
            ) : (
              <Text className="text-bg font-bold text-base">Let's Go →</Text>
            )}
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
