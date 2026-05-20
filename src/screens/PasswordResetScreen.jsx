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
import { useDispatch } from 'react-redux';
import { supabase } from '../lib/supabase';
import { setPasswordRecovery } from '../store/authSlice';
import { signOut } from '../lib/sessionManager';

const MIN_LEN = 8;

export default function PasswordResetScreen() {
  const dispatch = useDispatch();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setError(null);
    if (password.length < MIN_LEN) {
      setError(`Password must be at least ${MIN_LEN} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setBusy(false);
    if (err) {
      setError(err.message || 'Could not update password.');
      return;
    }
    dispatch(setPasswordRecovery(false));
  }

  async function cancel() {
    dispatch(setPasswordRecovery(false));
    await signOut(dispatch);
  }

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <View className="flex-1 px-6 justify-center">
          <Text className="text-accent text-3xl font-bold mb-2">
            🔑 Set a new password
          </Text>
          <Text className="text-muted mb-6">
            Choose a new password for your account.
          </Text>

          <Text className="text-muted text-xs mb-1">New password</Text>
          <View className="flex-row items-center bg-panel border border-border rounded-lg px-3 h-14">
            <TextInput
              value={password}
              onChangeText={setPassword}
              secureTextEntry={!showPassword}
              autoCapitalize="none"
              placeholder="••••••••"
              placeholderTextColor="#5A6478"
              className="flex-1 text-text text-base"
            />
            <Pressable onPress={() => setShowPassword((s) => !s)}>
              <Text className="text-muted">
                {showPassword ? 'Hide' : 'Show'}
              </Text>
            </Pressable>
          </View>

          <Text className="text-muted text-xs mt-3 mb-1">Confirm password</Text>
          <TextInput
            value={confirm}
            onChangeText={setConfirm}
            secureTextEntry={!showPassword}
            autoCapitalize="none"
            placeholder="••••••••"
            placeholderTextColor="#5A6478"
            className="bg-panel border border-border rounded-lg px-3 h-14 text-text text-base"
          />

          {error ? (
            <Text className="text-bad mt-3 text-sm">{error}</Text>
          ) : null}

          <Pressable
            disabled={busy}
            onPress={submit}
            className={`mt-6 rounded-lg py-3 items-center ${
              busy ? 'bg-panel border border-border' : 'bg-accent'
            }`}
          >
            {busy ? (
              <ActivityIndicator color="#0B0F1A" />
            ) : (
              <Text className="text-bg font-bold">Update password</Text>
            )}
          </Pressable>

          <Pressable
            disabled={busy}
            onPress={cancel}
            className="mt-4 items-center"
          >
            <Text className="text-muted">Cancel</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
