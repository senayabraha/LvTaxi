import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  ScrollView,
  Alert,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { useDispatch, useSelector } from 'react-redux';
import { signOut } from '../lib/sessionManager';
import { supabase } from '../lib/supabase';
import { setProfile } from '../store/driversSlice';
import { TAXI_COMPANIES, TAXI_COMPANY_OTHER } from '../lib/constants';
import TrackingDebugPanel from '../components/TrackingDebugPanel';

// Driver-facing legal pages. URLs come from app config (app.config.js → extra)
// with safe production fallbacks.
const PRIVACY_URL =
  Constants.expoConfig?.extra?.privacyPolicyUrl || 'https://lvtaxi.online/privacy';
const TERMS_URL =
  Constants.expoConfig?.extra?.termsUrl || 'https://lvtaxi.online/terms';

// Open an external legal URL safely. canOpenURL is unreliable for https links
// in Expo, so we open directly and surface a friendly error on failure.
async function openLegalUrl(url) {
  try {
    await Linking.openURL(url);
  } catch (err) {
    Alert.alert('Could not open link', err?.message || 'Please try again later.');
  }
}

// Convert raw automatic-tracking statuses into user-friendly labels. Unknown
// values fall back to a humanized form of the raw status.
function getStatusLabel(status) {
  const map = {
    tracking_disabled: 'Tracking off',
    active: 'Active',
    staged: 'Staged',
    off_duty: 'Off duty',
    passive_far: 'Outside work area',
    passive_near: 'Near work area',
  };
  if (map[status]) return map[status];
  return String(status || 'Unknown').replace(/_/g, ' ');
}

export default function ProfileScreen() {
  const dispatch = useDispatch();
  const session = useSelector((s) => s.auth.session);
  const isAdmin = useSelector((s) => s.auth.isAdmin);
  const profile = useSelector((s) => s.drivers.profile);
  const status = useSelector((s) => s.drivers.status);
  const [deleting, setDeleting] = useState(false);

  // Company editing
  const [editingCompany, setEditingCompany] = useState(false);
  const [companyChoice, setCompanyChoice] = useState(null);
  const [customCompany, setCustomCompany] = useState('');
  const [savingCompany, setSavingCompany] = useState(false);

  function openCompanyEditor() {
    const current = profile?.taxi_company ?? null;
    if (current && TAXI_COMPANIES.includes(current)) {
      setCompanyChoice(current);
      setCustomCompany('');
    } else if (current) {
      // A custom value that isn't one of the predefined options → pre-fill Other.
      setCompanyChoice(TAXI_COMPANY_OTHER);
      setCustomCompany(current);
    } else {
      setCompanyChoice(null);
      setCustomCompany('');
    }
    setEditingCompany(true);
  }

  function resolveCompanyValue() {
    if (companyChoice === TAXI_COMPANY_OTHER) {
      const trimmed = customCompany.trim();
      return trimmed ? trimmed : null;
    }
    return companyChoice ?? null;
  }

  async function saveCompany() {
    if (!profile?.id || savingCompany) return;
    setSavingCompany(true);
    const value = resolveCompanyValue();
    const { error } = await supabase
      .from('drivers')
      .update({ taxi_company: value })
      .eq('id', profile.id);
    setSavingCompany(false);
    if (error) {
      Alert.alert('Could not save', error.message || 'Please try again.');
      return;
    }
    dispatch(setProfile({ ...profile, taxi_company: value }));
    setEditingCompany(false);
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

  const taxiCompany = profile?.taxi_company;

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
      <ScrollView keyboardShouldPersistTaps="handled">
        <View className="px-4 pt-4">
          <Text className="text-accent text-2xl font-bold">Profile</Text>
        </View>

        <View className="mx-4 mt-4 bg-panel rounded-lg border border-border p-4">
          {/* 1. Signed in as */}
          <Text className="text-muted text-xs mb-1">Signed in as</Text>
          <Text className="text-text text-base">
            {session?.user?.phone || session?.user?.email || 'Unknown'}
          </Text>

          {/* 2. Name */}
          {profile?.full_name ? (
            <>
              <Text className="text-muted text-xs mt-3 mb-1">Name</Text>
              <Text className="text-text text-base">{profile.full_name}</Text>
            </>
          ) : null}

          {/* 3. Taxi company */}
          <View className="flex-row items-center justify-between mt-3 mb-1">
            <Text className="text-muted text-xs">Taxi company</Text>
            {!editingCompany ? (
              <Pressable onPress={openCompanyEditor} hitSlop={8}>
                <Text className="text-accent text-xs">Edit company</Text>
              </Pressable>
            ) : null}
          </View>
          {!editingCompany ? (
            <Text className="text-text text-base">
              {taxiCompany ? `🚕 ${taxiCompany}` : 'Not selected'}
            </Text>
          ) : (
            <View className="mt-1">
              {TAXI_COMPANIES.map((option) => {
                const selected = companyChoice === option;
                return (
                  <Pressable
                    key={option}
                    disabled={savingCompany}
                    onPress={() => setCompanyChoice(option)}
                    className={`flex-row items-center rounded-lg border px-3 py-2 mb-2 ${
                      selected ? 'bg-accent/10 border-accent' : 'bg-bg border-border'
                    }`}
                  >
                    <View
                      className={`w-4 h-4 rounded-full border mr-3 items-center justify-center ${
                        selected ? 'border-accent' : 'border-border'
                      }`}
                    >
                      {selected ? (
                        <View className="w-2 h-2 rounded-full bg-accent" />
                      ) : null}
                    </View>
                    <Text
                      className={`text-sm ${selected ? 'text-accent' : 'text-text'}`}
                    >
                      {option}
                    </Text>
                  </Pressable>
                );
              })}
              {companyChoice === TAXI_COMPANY_OTHER ? (
                <TextInput
                  value={customCompany}
                  onChangeText={setCustomCompany}
                  placeholder="Enter taxi company name"
                  placeholderTextColor="#5A6478"
                  autoCapitalize="words"
                  className="bg-bg border border-border rounded-lg px-3 h-12 text-text text-base mb-2"
                />
              ) : null}
              <View className="flex-row mt-1">
                <Pressable
                  disabled={savingCompany}
                  onPress={saveCompany}
                  className="bg-accent rounded-lg px-4 py-2 mr-2 items-center justify-center"
                >
                  {savingCompany ? (
                    <ActivityIndicator color="#0B0F1A" />
                  ) : (
                    <Text className="text-bg font-semibold text-sm">Save</Text>
                  )}
                </Pressable>
                <Pressable
                  disabled={savingCompany}
                  onPress={() => setEditingCompany(false)}
                  className="bg-bg border border-border rounded-lg px-4 py-2 items-center justify-center"
                >
                  <Text className="text-muted text-sm">Cancel</Text>
                </Pressable>
              </View>
            </View>
          )}
          <Text className="text-muted text-xs mt-2">
            Taxi company is visible to you and LV Taxi admin only.
          </Text>

          {/* 4. Driver status */}
          <Text className="text-muted text-xs mt-3 mb-1">Driver status</Text>
          <Text className="text-text">{getStatusLabel(status)}</Text>

          {/* Subscription row is intentionally hidden from the profile UI. */}

          {/* 5. Driver ID — admin/support only; hidden for regular drivers. */}
          {isAdmin ? (
            <>
              <Text className="text-muted text-xs mt-3 mb-1">Driver ID</Text>
              <Text className="text-text text-xs" numberOfLines={1}>
                {profile?.id ?? session?.user?.id ?? '—'}
              </Text>
            </>
          ) : null}

          {/* 6. Role (admin only) */}
          {isAdmin ? (
            <>
              <Text className="text-muted text-xs mt-3 mb-1">Role</Text>
              <Text className="text-accent text-base">Admin</Text>
            </>
          ) : null}
        </View>

        {/* ── Legal ──────────────────────────────────────────────────────── */}
        <View className="mx-4 mt-4 bg-panel rounded-lg border border-border p-4">
          <Text className="text-text text-base font-semibold mb-3">Legal</Text>
          <Pressable
            onPress={() => openLegalUrl(PRIVACY_URL)}
            className="flex-row items-center justify-between bg-bg border border-border rounded-lg px-4 py-3 mb-2"
          >
            <Text className="text-text text-base">Privacy Policy</Text>
            <Text className="text-accent text-base">›</Text>
          </Pressable>
          <Pressable
            onPress={() => openLegalUrl(TERMS_URL)}
            className="flex-row items-center justify-between bg-bg border border-border rounded-lg px-4 py-3"
          >
            <Text className="text-text text-base">Terms &amp; Conditions</Text>
            <Text className="text-accent text-base">›</Text>
          </Pressable>
        </View>

        {/* Admin-only diagnostics. */}
        {isAdmin ? <TrackingDebugPanel /> : null}

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
