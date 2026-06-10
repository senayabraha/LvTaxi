import * as Linking from 'expo-linking';
import * as Sentry from '@sentry/react-native';
import { Alert } from 'react-native';
import { store } from '../store';
import { supabase } from './supabase';
import {
  setSession,
  clearSession,
  setIsAdmin,
  setLoading,
  setPasswordRecovery,
  setProfileFetching,
} from '../store/authSlice';
import { setProfile, clearProfile } from '../store/driversSlice';
import { stopLocationTracking } from './locationEngine';
import { stopGeofenceManager } from './geofenceEngine';
import { stopAllBackgroundTracking } from './backgroundTracking/backgroundTrackingService';
import { clearDriverPresence } from './zoneStatsEngine';
import { closeOrphanedVisits } from './visitReconciler';

let reconciledUserId = null;

async function reconcileOnce(userId) {
  if (!userId || reconciledUserId === userId) return;
  reconciledUserId = userId;
  try {
    await closeOrphanedVisits(userId);
  } catch (err) {
    console.warn('[sessionManager] reconcile failed', err);
  }
}

async function handleAuthDeepLink(url, dispatch) {
  if (!url) return;
  const parsed = Linking.parse(url);
  const params = { ...(parsed.queryParams || {}) };
  if (parsed.path && parsed.path.includes('#')) {
    const fragment = parsed.path.split('#')[1];
    new URLSearchParams(fragment).forEach((v, k) => {
      params[k] = v;
    });
  }
  const accessToken = params.access_token;
  const refreshToken = params.refresh_token;
  const isRecovery = params.type === 'recovery';
  if (accessToken && refreshToken) {
    const { error } = await supabase.auth.setSession({
      access_token: accessToken,
      refresh_token: refreshToken,
    });
    if (error) {
      console.warn('[sessionManager] deep-link setSession failed', error.message);
      return;
    }
    if (isRecovery && dispatch) dispatch(setPasswordRecovery(true));
  }
}

async function fetchAndSetProfile(dispatch, userId) {
  if (!userId) return;

  // Retry with exponential backoff so a transient network blip on launch does
  // not leave profile=null and bounce a valid session to the login screen (LIFE-4).
  // Delays: attempt 1→immediate, 2→1 s, 3→2 s (total wait up to ~3 s).
  const MAX_ATTEMPTS = 3;
  dispatch(setProfileFetching(true));
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
      const { data, error } = await supabase
        .from('drivers')
        .select('*')
        .eq('id', userId)
        .maybeSingle();

      if (error) {
        console.warn(
          `[sessionManager] profile fetch failed (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
          error.message
        );
        if (attempt < MAX_ATTEMPTS - 1) continue;
        return; // all attempts exhausted — profile stays null
      }

      if (data) {
        // Auto-cancel deletion if the driver signs back in during the 48-hour window.
        if (
          data.deletion_status === 'scheduled_for_deletion' &&
          data.deletion_scheduled_for &&
          new Date(data.deletion_scheduled_for) > new Date()
        ) {
          try {
            const { error: cancelErr } = await supabase.functions.invoke(
              'cancel-account-deletion'
            );
            if (cancelErr) {
              console.warn('[sessionManager] auto-cancel deletion failed', cancelErr.message);
            } else {
              data.deletion_status = 'active';
              data.deletion_scheduled_for = null;
              data.deletion_cancelled_at = new Date().toISOString();
              // Delay the alert slightly so the UI is fully mounted first.
              setTimeout(() => {
                Alert.alert(
                  'Deletion canceled',
                  'Your account deletion request has been canceled because you signed back in.'
                );
              }, 800);
            }
          } catch (e) {
            console.warn('[sessionManager] auto-cancel deletion threw', e);
          }
        }
        dispatch(setProfile(data));
        dispatch(setIsAdmin(data.role === 'admin'));
      }
      return; // success (data may be null for a brand-new account row)
    }
  } finally {
    dispatch(setProfileFetching(false));
  }
}

export function setupSessionListener(dispatch) {
  (async () => {
    try {
      const { data } = await supabase.auth.getSession();
      const session = data?.session ?? null;
      dispatch(setSession(session));
      if (session?.user?.id) {
        Sentry.setUser({ id: session.user.id });
        await fetchAndSetProfile(dispatch, session.user.id);
        reconcileOnce(session.user.id);
      }
    } catch (err) {
      console.warn('[sessionManager] init failed', err);
    } finally {
      dispatch(setLoading(false));
    }
  })();

  const { data: sub } = supabase.auth.onAuthStateChange(
    async (event, session) => {
      if (event === 'PASSWORD_RECOVERY') {
        dispatch(setSession(session));
        dispatch(setPasswordRecovery(true));
      } else if (event === 'SIGNED_IN') {
        dispatch(setSession(session));
        if (session?.user?.id) {
          Sentry.setUser({ id: session.user.id });
          await fetchAndSetProfile(dispatch, session.user.id);
          reconcileOnce(session.user.id);
        }
      } else if (event === 'TOKEN_REFRESHED') {
        dispatch(setSession(session));
      } else if (event === 'SIGNED_OUT') {
        Sentry.setUser(null);
        reconciledUserId = null;
        // Capture before clearSession wipes the session from Redux.
        const userId = store.getState().auth.session?.user?.id ?? null;
        // Run the same cleanup that signOut() does so token-expiry / server-side
        // forced logout also drops presence and stops background tasks (LIFE-3).
        if (userId) {
          try { await clearDriverPresence(userId); } catch {}
        }
        try { await stopAllBackgroundTracking(); } catch {}
        try { await stopGeofenceManager(); } catch {}
        try { stopLocationTracking(); } catch {}
        dispatch(clearSession());
        dispatch(clearProfile());
      } else if (event === 'USER_UPDATED') {
        dispatch(setSession(session));
      }
    }
  );

  Linking.getInitialURL()
    .then((url) => handleAuthDeepLink(url, dispatch))
    .catch(() => {});
  const linkSub = Linking.addEventListener('url', ({ url }) => {
    handleAuthDeepLink(url, dispatch);
  });

  return () => {
    sub.subscription.unsubscribe();
    linkSub?.remove?.();
  };
}

export async function signOut(dispatch) {
  // Logout is a TRACKING_DISABLED trigger: stop every background task and drop the
  // driver out of live presence counts before the session goes away.
  const userId = store.getState().auth.session?.user?.id ?? null;
  if (userId) {
    try {
      await clearDriverPresence(userId);
    } catch {}
  }
  try {
    await stopAllBackgroundTracking();
  } catch {}
  try {
    await stopGeofenceManager();
  } catch {}
  try {
    stopLocationTracking();
  } catch {}
  Sentry.setUser(null);
  await supabase.auth.signOut();
  dispatch(clearSession());
  dispatch(clearProfile());
}

export { fetchAndSetProfile };
