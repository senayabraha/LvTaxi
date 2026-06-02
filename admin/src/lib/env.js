// Centralized, secret-safe environment validation for the admin app.
//
// IMPORTANT: this app uses ONLY the Supabase *publishable* key (same key the
// mobile app ships). A service role key must NEVER be referenced here or
// anywhere in the frontend. We deliberately do not log key values — only their
// presence/absence — so secrets never reach the console.

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
export const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

// Returns the list of required env var names that are missing/empty.
export function getMissingEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push('VITE_SUPABASE_URL');
  if (!SUPABASE_PUBLISHABLE_KEY) missing.push('VITE_SUPABASE_PUBLISHABLE_KEY');
  return missing;
}

export const ENV_VALID = getMissingEnv().length === 0;
