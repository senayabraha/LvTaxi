import React, { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import LoginScreen from './LoginScreen.jsx';
import MainTabs from './MainTabs.jsx';
import { ToastProvider } from './useToast.jsx';

export default function App() {
  const [session, setSession] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function checkRole(sess) {
      if (!sess?.user?.id) {
        if (mounted) {
          setIsAdmin(false);
          setLoading(false);
        }
        return;
      }
      const { data, error: err } = await supabase
        .from('drivers')
        .select('role')
        .eq('id', sess.user.id)
        .maybeSingle();
      if (!mounted) return;
      if (err) {
        setError(err.message);
        setIsAdmin(false);
      } else {
        setIsAdmin(data?.role === 'admin');
      }
      setLoading(false);
    }

    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      setSession(data.session ?? null);
      checkRole(data.session);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      if (!mounted) return;
      if (event === 'SIGNED_OUT') {
        setSession(null);
        setIsAdmin(false);
        setLoading(false);
        setError(null);
        return;
      }
      setSession(sess ?? null);
      if (sess) checkRole(sess);
      else {
        setIsAdmin(false);
        setLoading(false);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <ToastProvider>
      {loading ? (
        <div className="flex h-full items-center justify-center bg-bg">
          <div className="text-accent text-xl font-bold">🚕 LvTaxi Admin…</div>
        </div>
      ) : !session ? (
        <LoginScreen />
      ) : !isAdmin ? (
        <div className="flex h-full items-center justify-center bg-bg">
          <div className="max-w-md text-center">
            <div className="text-bad text-2xl font-bold mb-2">Access denied</div>
            <div className="text-muted mb-1">
              Signed in as {session.user.email ?? session.user.phone}
            </div>
            <div className="text-muted mb-6">
              This account is not an admin. Set{' '}
              <code>drivers.role = &apos;admin&apos;</code> in Supabase, then
              sign out and back in.
            </div>
            {error ? <div className="text-bad text-sm mb-4">{error}</div> : null}
            <button
              onClick={signOut}
              className="bg-panel border border-bad text-bad px-4 py-2 rounded"
            >
              Sign out
            </button>
          </div>
        </div>
      ) : (
        <MainTabs session={session} onSignOut={signOut} />
      )}
    </ToastProvider>
  );
}
