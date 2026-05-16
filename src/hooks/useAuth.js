import { useEffect, useState } from 'react';
import { useDispatch } from 'react-redux';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import {
  GUEST_MODE_KEY,
  setGuest,
  setSession,
  setProfile,
  signOut as signOutAction,
} from '../store/driversSlice';
import { DRIVER_STATUS } from '../lib/constants';

function profileFromUser(user) {
  return {
    id: user.id,
    phone: user.phone ?? null,
    email: user.email ?? null,
    full_name: user.user_metadata?.full_name ?? null,
    status: DRIVER_STATUS.BROWSING,
    last_seen: new Date().toISOString(),
  };
}

async function clearGuestMode() {
  try {
    await AsyncStorage.removeItem(GUEST_MODE_KEY);
  } catch (error) {
    console.warn('[useAuth] guest mode clear failed', error);
  }
}

export function useAuth() {
  const dispatch = useDispatch();
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      dispatch(setSession(data.session ?? null));
      if (data.session?.user) {
        await clearGuestMode();
        loadProfile(data.session.user);
      } else {
        if (!mounted) return;
        dispatch(setGuest(true));
        setLoading(false);
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, session) => {
      dispatch(setSession(session ?? null));
      if (session?.user) {
        await clearGuestMode();
        loadProfile(session.user);
      } else {
        dispatch(setProfile(null));
        if (!mounted) return;
        dispatch(setGuest(true));
        setLoading(false);
      }
    });

    async function loadProfile(user) {
      const { data, error } = await supabase
        .from('drivers')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

      if (!mounted) return;

      if (error) {
        console.warn('[useAuth] profile fetch error', error.message);
      }

      if (!data) {
        const { data: created, error: createError } = await supabase
          .from('drivers')
          .upsert(profileFromUser(user), { onConflict: 'id' })
          .select()
          .maybeSingle();

        if (createError) {
          console.warn('[useAuth] profile create error', createError.message);
        }

        dispatch(setProfile(created ?? null));
      } else {
        const patch = {};
        if (!data.email && user.email) patch.email = user.email;
        if (!data.phone && user.phone) patch.phone = user.phone;
        if (!data.full_name && user.user_metadata?.full_name) {
          patch.full_name = user.user_metadata.full_name;
        }

        if (Object.keys(patch).length > 0) {
          const { data: updated, error: updateError } = await supabase
            .from('drivers')
            .update({ ...patch, last_seen: new Date().toISOString() })
            .eq('id', user.id)
            .select()
            .maybeSingle();

          if (updateError) {
            console.warn('[useAuth] profile update error', updateError.message);
          }

          dispatch(setProfile(updated ?? data));
        } else {
          dispatch(setProfile(data));
        }
      }
      setLoading(false);
    }

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [dispatch]);

  async function signOut() {
    await supabase.auth.signOut();
    await clearGuestMode();
    dispatch(signOutAction());
    dispatch(setGuest(true));
  }

  return {
    loading,
    signOut,
  };
}
