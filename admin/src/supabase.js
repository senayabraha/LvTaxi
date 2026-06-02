import { createClient } from '@supabase/supabase-js';
import {
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  getMissingEnv,
} from './lib/env.js';

// Validate env up front — log only which vars are missing, never their values.
const missing = getMissingEnv();
if (missing.length) {
  console.warn(
    `[supabase] Missing required env var(s): ${missing.join(', ')}. ` +
      'Set them in admin/.env (see .env.example).'
  );
}

export const supabase = createClient(
  SUPABASE_URL ?? '',
  SUPABASE_PUBLISHABLE_KEY ?? '',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  }
);
