import React, { useEffect, useMemo, useRef, useState } from 'react';
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
import * as Linking from 'expo-linking';
import { useDispatch } from 'react-redux';
import { supabase } from '../lib/supabase';
import { setSession } from '../store/authSlice';

const EMAIL_REDIRECT_URL = Linking.createURL('auth-callback');
const PASSWORD_RESET_URL = Linking.createURL('password-reset');

const TAB = { PHONE: 'phone', EMAIL: 'email' };

function formatPhoneDisplay(digits) {
  const d = digits.slice(0, 10);
  if (d.length === 0) return '';
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function digitsOnly(s) {
  return (s || '').replace(/\D/g, '');
}

async function driverRowExists(userId) {
  const { data, error } = await supabase
    .from('drivers')
    .select('id')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[AuthScreen] driver lookup failed', error.message);
    return false;
  }
  return !!data;
}

export default function AuthScreen({ navigation }) {
  const dispatch = useDispatch();
  const [tab, setTab] = useState(TAB.PHONE);
  const SHOW_PHONE_TAB = true;

  // Phone state
  const [phoneDigits, setPhoneDigits] = useState('');
  const [otpSent, setOtpSent] = useState(false);
  const [otp, setOtp] = useState(['', '', '', '', '', '']);
  const [resendSec, setResendSec] = useState(0);
  const otpRefs = useRef([]);

  // Email state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [needsSignUp, setNeedsSignUp] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  // Shared
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const e164 = useMemo(() => {
    const d = phoneDigits;
    return d.length === 10 ? `+1${d}` : null;
  }, [phoneDigits]);

  useEffect(() => {
    if (resendSec <= 0) return;
    const id = setInterval(() => setResendSec((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [resendSec]);

  async function onPostAuthSession(session) {
    dispatch(setSession(session));
    const userId = session?.user?.id;
    if (!userId) return;
    const exists = await driverRowExists(userId);
    if (!exists) {
      navigation.navigate('Name');
    }
  }

  async function sendOtp() {
    setError(null);
    if (!e164) {
      setError('Please enter a valid 10-digit phone number.');
      return;
    }
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithOtp({
      phone: e164,
      options: { shouldCreateUser: true },
    });
    setBusy(false);
    if (err) {
      if (err.message?.toLowerCase().includes('provider')) {
        setError('SMS not available right now. Please use email instead.');
      } else {
        setError(err.message || 'Could not send code. Try again.');
      }
      return;
    }
    setOtpSent(true);
    setResendSec(60);
    setOtp(['', '', '', '', '', '']);
    setTimeout(() => otpRefs.current[0]?.focus(), 50);
  }

  async function verifyOtpCode(codeArr = otp) {
    const token = codeArr.join('');
    if (token.length !== 6 || !e164) return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await supabase.auth.verifyOtp({
      phone: e164,
      token,
      type: 'sms',
    });
    setBusy(false);
    if (err) {
      setError('Incorrect code. Please try again.');
      return;
    }
    if (data?.session) await onPostAuthSession(data.session);
  }

  function handleOtpChange(idx, value) {
    const digit = digitsOnly(value).slice(-1);
    const next = [...otp];
    next[idx] = digit;
    setOtp(next);
    if (digit && idx < 5) otpRefs.current[idx + 1]?.focus();
    if (idx === 5 && digit) verifyOtpCode(next);
  }

  async function emailContinue() {
    setError(null);
    setNeedsSignUp(false);
    if (!email || !password) {
      setError('Email and password are required.');
      return;
    }
    setBusy(true);
    const { data, error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (!err) {
      if (data?.session) await onPostAuthSession(data.session);
      return;
    }
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('invalid login') || msg.includes('invalid credentials')) {
      setNeedsSignUp(true);
      setError("No account found for this email. Create one?");
      return;
    }
    setError(err.message || 'Could not sign in.');
  }

  async function emailCreateAccount() {
    setError(null);
    if (!email || !password) {
      setError('Email and password are required.');
      return;
    }
    setBusy(true);
    const { data, error: err } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: { emailRedirectTo: EMAIL_REDIRECT_URL },
    });
    setBusy(false);
    setNeedsSignUp(false);
    if (err) {
      setError(err.message || 'Could not create account.');
      return;
    }
    if (data?.session) {
      await onPostAuthSession(data.session);
    } else {
      setEmailSent(true);
    }
  }

  async function sendPasswordReset() {
    setError(null);
    if (!email.trim()) {
      setError('Enter your email above first.');
      return;
    }
    setBusy(true);
    const { error: err } = await supabase.auth.resetPasswordForEmail(
      email.trim(),
      { redirectTo: PASSWORD_RESET_URL }
    );
    setBusy(false);
    if (err) {
      setError(err.message || 'Could not send reset email.');
      return;
    }
    setResetSent(true);
  }

  if (resetSent) {
    return (
      <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
        <View className="flex-1 px-6 justify-center">
          <Text className="text-accent text-3xl font-bold mb-3">
            🔑 Reset link sent
          </Text>
          <Text className="text-text mb-6">
            We sent a password reset link to {email}. Tap the link, choose a
            new password, then come back and sign in.
          </Text>
          <Pressable
            onPress={() => {
              setResetSent(false);
              setError(null);
            }}
            className="bg-accent rounded-lg py-3 items-center"
          >
            <Text className="text-bg font-bold">Back to sign in</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  if (emailSent) {
    return (
      <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
        <View className="flex-1 px-6 justify-center">
          <Text className="text-accent text-3xl font-bold mb-3">
            📧 Check your email
          </Text>
          <Text className="text-text mb-6">
            We sent a confirmation link to {email}. Tap the link, then come back
            and sign in.
          </Text>
          <Pressable
            onPress={() => {
              setEmailSent(false);
              setNeedsSignUp(false);
              setError(null);
            }}
            className="bg-accent rounded-lg py-3 items-center"
          >
            <Text className="text-bg font-bold">Back to sign in</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView className="flex-1 bg-bg" edges={['top']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        className="flex-1"
      >
        <View className="px-6 pt-6 pb-2">
          <Text className="text-accent text-3xl font-bold">🚕 LvTaxi</Text>
          <Text className="text-muted mt-1">Sign in to see live staging.</Text>
        </View>

        {SHOW_PHONE_TAB ? (
          <View className="flex-row mx-6 mt-4 mb-2 bg-panel border border-border rounded-lg p-1">
            {[
              { k: TAB.PHONE, label: '📱 Phone' },
              { k: TAB.EMAIL, label: '📧 Email' },
            ].map((t) => {
              const active = tab === t.k;
              return (
                <Pressable
                  key={t.k}
                  onPress={() => {
                    setTab(t.k);
                    setError(null);
                  }}
                  className={`flex-1 py-2 rounded-md items-center ${
                    active ? 'bg-panel2' : ''
                  }`}
                >
                  <Text className={active ? 'text-accent' : 'text-muted'}>
                    {t.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <View className="px-6 mt-3 flex-1">
          {tab === TAB.PHONE ? (
            !otpSent ? (
              <>
                <Text className="text-muted text-xs mb-1">Phone number</Text>
                <View className="flex-row items-center bg-panel border border-border rounded-lg px-3 h-14">
                  <Text className="text-text mr-2">+1</Text>
                  <TextInput
                    keyboardType="number-pad"
                    value={formatPhoneDisplay(phoneDigits)}
                    onChangeText={(t) => setPhoneDigits(digitsOnly(t).slice(0, 10))}
                    placeholder="(702) 555-0123"
                    placeholderTextColor="#5A6478"
                    className="flex-1 text-text text-base"
                  />
                </View>

                {error ? (
                  <Text className="text-bad mt-2 text-sm">{error}</Text>
                ) : null}

                <Pressable
                  disabled={busy || !e164}
                  onPress={sendOtp}
                  className={`mt-5 rounded-lg py-3 items-center ${
                    busy || !e164 ? 'bg-panel border border-border' : 'bg-accent'
                  }`}
                >
                  {busy ? (
                    <ActivityIndicator color="#0B0F1A" />
                  ) : (
                    <Text
                      className={
                        e164 ? 'text-bg font-bold' : 'text-muted font-bold'
                      }
                    >
                      Send code
                    </Text>
                  )}
                </Pressable>
              </>
            ) : (
              <>
                <Text className="text-text">
                  Enter the 6-digit code sent to{' '}
                  <Text className="text-accent">
                    {formatPhoneDisplay(phoneDigits)}
                  </Text>
                </Text>
                <View className="flex-row justify-between mt-4">
                  {otp.map((v, i) => (
                    <TextInput
                      key={i}
                      ref={(r) => (otpRefs.current[i] = r)}
                      value={v}
                      onChangeText={(t) => handleOtpChange(i, t)}
                      keyboardType="number-pad"
                      maxLength={1}
                      className="w-12 h-14 bg-panel border border-border rounded-md text-text text-center text-xl"
                    />
                  ))}
                </View>

                {error ? (
                  <Text className="text-bad mt-2 text-sm">{error}</Text>
                ) : null}

                <Pressable
                  disabled={resendSec > 0 || busy}
                  onPress={sendOtp}
                  className="mt-5 items-center"
                >
                  <Text className={resendSec > 0 ? 'text-muted' : 'text-accent'}>
                    {resendSec > 0
                      ? `Resend in ${resendSec}s`
                      : 'Resend code'}
                  </Text>
                </Pressable>

                <Pressable
                  onPress={() => {
                    setOtpSent(false);
                    setOtp(['', '', '', '', '', '']);
                    setError(null);
                  }}
                  className="mt-2 items-center"
                >
                  <Text className="text-muted">Change number</Text>
                </Pressable>
              </>
            )
          ) : (
            <>
              <Text className="text-muted text-xs mb-1">Email</Text>
              <TextInput
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  if (needsSignUp) {
                    setNeedsSignUp(false);
                    setError(null);
                  }
                }}
                keyboardType="email-address"
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="you@example.com"
                placeholderTextColor="#5A6478"
                className="bg-panel border border-border rounded-lg px-3 h-14 text-text text-base"
              />

              <Text className="text-muted text-xs mt-3 mb-1">Password</Text>
              <View className="flex-row items-center bg-panel border border-border rounded-lg px-3 h-14">
                <TextInput
                  value={password}
                  onChangeText={(t) => {
                    setPassword(t);
                    if (needsSignUp) {
                      setNeedsSignUp(false);
                      setError(null);
                    }
                  }}
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

              <Pressable
                disabled={busy}
                onPress={sendPasswordReset}
                className="mt-3 self-end"
              >
                <Text className="text-accent text-sm">Forgot password?</Text>
              </Pressable>

              {error ? (
                <Text className="text-bad mt-2 text-sm">{error}</Text>
              ) : null}

              <Pressable
                disabled={busy}
                onPress={needsSignUp ? emailCreateAccount : emailContinue}
                className={`mt-5 rounded-lg py-3 items-center ${
                  busy ? 'bg-panel border border-border' : 'bg-accent'
                }`}
              >
                {busy ? (
                  <ActivityIndicator color="#0B0F1A" />
                ) : (
                  <Text className="text-bg font-bold">
                    {needsSignUp ? 'Create account' : 'Continue'}
                  </Text>
                )}
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
