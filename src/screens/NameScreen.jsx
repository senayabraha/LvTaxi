import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useDispatch, useSelector } from 'react-redux';
import { supabase } from '../lib/supabase';
import { setProfile } from '../store/driversSlice';
import { setIsAdmin } from '../store/authSlice';
import { DRIVER_STATUS, TAXI_COMPANIES, TAXI_COMPANY_OTHER } from '../lib/constants';

export default function NameScreen({ navigation }) {
  const dispatch = useDispatch();
  const userId = useSelector((s) => s.auth.session?.user?.id);
  const userPhone = useSelector((s) => s.auth.session?.user?.phone) ?? null;
  const userEmail = useSelector((s) => s.auth.session?.user?.email) ?? null;

  const [name, setName] = useState('');
  const [company, setCompany] = useState(null);
  const [customCompany, setCustomCompany] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Resolve the value to persist into drivers.taxi_company. Predefined options
  // save their exact label; "Other" saves the trimmed custom text, or null when
  // that text is empty/whitespace; no selection saves null.
  function resolveCompanyValue() {
    if (company === TAXI_COMPANY_OTHER) {
      const trimmed = customCompany.trim();
      return trimmed ? trimmed : null;
    }
    return company ?? null;
  }

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
      taxi_company: skip ? null : resolveCompanyValue(),
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

        <ScrollView
          className="flex-1 px-6"
          contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', paddingVertical: 24 }}
          keyboardShouldPersistTaps="handled"
        >
          <Text className="text-accent text-3xl font-bold">
            Set up your driver profile
          </Text>
          <Text className="text-muted mt-2 mb-6">
            Your name and taxi company are only visible to you and LV Taxi admin.
          </Text>

          <Text className="text-muted text-xs mb-1">What should we call you?</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Your first name"
            placeholderTextColor="#5A6478"
            autoCapitalize="words"
            className="bg-panel border border-border rounded-lg px-4 h-14 text-text text-lg"
          />

          <Text className="text-muted text-xs mt-6 mb-2">
            Which taxi company do you work for?
          </Text>
          <View>
            {TAXI_COMPANIES.map((option) => {
              const selected = company === option;
              return (
                <Pressable
                  key={option}
                  disabled={busy}
                  onPress={() => setCompany(option)}
                  className={`flex-row items-center rounded-lg border px-4 py-3 mb-2 ${
                    selected ? 'bg-accent/10 border-accent' : 'bg-panel border-border'
                  }`}
                >
                  <View
                    className={`w-5 h-5 rounded-full border mr-3 items-center justify-center ${
                      selected ? 'border-accent' : 'border-border'
                    }`}
                  >
                    {selected ? (
                      <View className="w-2.5 h-2.5 rounded-full bg-accent" />
                    ) : null}
                  </View>
                  <Text
                    className={`text-base ${selected ? 'text-accent' : 'text-text'}`}
                  >
                    {option}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {company === TAXI_COMPANY_OTHER ? (
            <TextInput
              value={customCompany}
              onChangeText={setCustomCompany}
              placeholder="Enter your taxi company"
              placeholderTextColor="#5A6478"
              autoCapitalize="words"
              className="bg-panel border border-border rounded-lg px-4 h-14 text-text text-lg mt-1"
            />
          ) : null}

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
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
