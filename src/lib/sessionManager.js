import * as Linking from 'expo-linking';
import * as Sentry from '@sentry/react-native';
import { store } from '../store';
import { supabase } from './supabase';
import {
  setSession,
  clearSession,
  setIsAdmin,
  setLoading,
  setPasswordRecovery,
} from '../store/authSlice';
import { setProfile, clearProfile } from '../store/driversSlice';
import { stopLocationTracking } from './locationEngine';
import { stopGeofenceManager } from './geofenceEngine';
import { stopAllBackgroundTracking } from './backgroundTracking/backgroundTrackingService';
import { clearDriverPresence } from './zoneStatsEngine';
import { closeOrphanedVisits } from './visitReconciler';

let hasReconciled = false;

async function reconcileOnce(userId) {
  if (hasReconciled || !userId) return;
  hasReconciled = true;
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
  const { data, error } = await supabase
    .from('drivers')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) {
    console.warn('[sessionManager] profile fetch failed', error.message);
    return;
  }
  if (data) {
    dispatch(setProfile(data));
    dispatch(setIsAdmin(data.role === 'admin'));
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
