import { supabase } from './supabase';
import {
  setSession,
  clearSession,
  setIsAdmin,
  setLoading,
} from '../store/authSlice';
import { setProfile, clearProfile } from '../store/driversSlice';
import { stopLocationTracking } from './locationEngine';
import { stopGeofenceManager } from './geofenceEngine';

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
        await fetchAndSetProfile(dispatch, session.user.id);
      }
    } catch (err) {
      console.warn('[sessionManager] init failed', err);
    } finally {
      dispatch(setLoading(false));
    }
  })();

  const { data: sub } = supabase.auth.onAuthStateChange(
    async (event, session) => {
      if (event === 'SIGNED_IN') {
        dispatch(setSession(session));
        if (session?.user?.id) {
          await fetchAndSetProfile(dispatch, session.user.id);
        }
      } else if (event === 'TOKEN_REFRESHED') {
        dispatch(setSession(session));
      } else if (event === 'SIGNED_OUT') {
        dispatch(clearSession());
        dispatch(clearProfile());
      }
    }
  );

  return () => {
    sub.subscription.unsubscribe();
  };
}

export async function signOut(dispatch) {
  try {
    await stopGeofenceManager();
  } catch {}
  try {
    stopLocationTracking();
  } catch {}
  await supabase.auth.signOut();
  dispatch(clearSession());
  dispatch(clearProfile());
}

export { fetchAndSetProfile };
