import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';

const url =
  process.env.EXPO_PUBLIC_SUPABASE_URL ||
  Constants.expoConfig?.extra?.supabaseUrl ||
  '';

const anonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ||
  Constants.expoConfig?.extra?.supabaseAnonKey ||
  '';

if (!url || !anonKey) {
  console.warn(
    '[supabase] Missing EXPO_PUBLIC_SUPABASE_URL or EXPO_PUBLIC_SUPABASE_ANON_KEY. Auth and data calls will fail until these are set in .env.'
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
