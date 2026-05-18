import React, { useState } from 'react';
import { supabase } from './supabase.js';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function onSubmit(e) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setBusy(false);
    if (err) setError('Incorrect email or password.');
  }

  return (
    <div className="flex h-full items-center justify-center bg-bg">
      <form
        onSubmit={onSubmit}
        className="bg-panel border border-border rounded-lg p-8 w-full max-w-sm"
      >
        <div className="text-accent text-3xl font-bold mb-1">🚕 LvTaxi</div>
        <div className="text-muted text-sm mb-6">Admin Panel</div>

        <label className="block text-muted text-xs mb-1">Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          autoComplete="email"
          className="w-full bg-panel2 border border-border rounded px-3 h-11 text-text mb-3"
        />

        <label className="block text-muted text-xs mb-1">Password</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          className="w-full bg-panel2 border border-border rounded px-3 h-11 text-text mb-4"
        />

        {error ? <div className="text-bad text-sm mb-3">{error}</div> : null}

        <button
          type="submit"
          disabled={busy || !email || !password}
          className="w-full bg-accent text-bg font-bold rounded h-11 disabled:opacity-50"
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        <div className="text-muted text-xs mt-4 text-center">
          Use the same account as your LvTaxi app, with{' '}
          <code>role = 'admin'</code>.
        </div>
      </form>
    </div>
  );
}
