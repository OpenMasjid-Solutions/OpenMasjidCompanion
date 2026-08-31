// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The way in to the admin panel — four screens for four genuinely different situations.
 *
 * The wording matters more than the code here. The reader is a masjid volunteer who wants to
 * put prayer times on people's phones, not a systems administrator, so every message says what
 * happened and what to do next, and none of them says "error".
 */
import { useState, type FormEvent } from 'react';
import { KeyRound, LayoutDashboard, PlugZap, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { Note } from '../ui';
import type { AuthState } from './session';

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <main className="centre-wrap">
      <section className="glass centre-card">
        <span className="centre-emblem">{icon}</span>
        <h1 className="centre-title">{title}</h1>
        {children}
      </section>
    </main>
  );
}

/** Shared password form. `mode` only changes the words and which endpoint it posts to. */
function PasswordForm({ mode, onDone }: { mode: 'login' | 'setup'; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const r = await api.post(mode === 'setup' ? '/api/setup' : '/api/login', { password });
    setBusy(false);
    if (r.ok) {
      setPassword('');
      onDone();
    } else {
      setError(r.error);
    }
  };

  return (
    <form onSubmit={submit} style={{ width: '100%', textAlign: 'start' }}>
      <div className="field">
        <label className="label" htmlFor="pw">
          {mode === 'setup' ? 'Choose a password' : 'Password'}
        </label>
        <input
          id="pw"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          // A password manager should offer to save a NEW password on setup and fill an
          // existing one on login — the same autocomplete value would do the wrong thing on
          // one of the two screens.
          autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
          minLength={mode === 'setup' ? 8 : undefined}
          required
          autoFocus
        />
        {mode === 'setup' && <p className="hint">At least 8 characters. Keep it somewhere safe — there is no way to reset it.</p>}
      </div>
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn--primary btn--block" type="submit" disabled={busy || password.length === 0}>
        {busy ? <span className="spinner" /> : mode === 'setup' ? 'Set password' : 'Sign in'}
      </button>
    </form>
  );
}

export function Auth({ state, onSignedIn }: { state: AuthState; onSignedIn: () => void }): JSX.Element {
  const [showPassword, setShowPassword] = useState(false);

  switch (state.kind) {
    /** Under OpenMasjidOS, the platform is up, the visitor just is not signed in there. The
     *  fix is one click in the dashboard, so that is what this says — it does not offer a
     *  password box that would only confuse someone who has never set one. */
    case 'use-dashboard':
      return (
        <Card icon={<LayoutDashboard size={26} strokeWidth={1.75} aria-hidden="true" />} title="Open this from your dashboard">
          <p className="centre-lead">
            Sign in to <b>OpenMasjidOS</b> and press <b>Open</b> on the Companion app. It will sign you in here
            automatically.
          </p>
          {state.session.hasPassword &&
            (showPassword ? (
              <PasswordForm mode="login" onDone={onSignedIn} />
            ) : (
              <button className="btn btn--ghost btn--block" onClick={() => setShowPassword(true)}>
                <KeyRound size={16} aria-hidden="true" /> Use this app&rsquo;s password instead
              </button>
            ))}
        </Card>
      );

    /** The recovery case, and the one that has to be right. OpenMasjidOS cannot be reached —
     *  a restore onto a new box, the core stopped, a network change — so the dashboard cannot
     *  sign anyone in and saying "press Open" would be advice that cannot work. */
    case 'platform-down':
      return (
        <Card icon={<PlugZap size={26} strokeWidth={1.75} aria-hidden="true" />} title="OpenMasjidOS isn&rsquo;t answering">
          <p className="centre-lead">
            This app can&rsquo;t reach your OpenMasjidOS dashboard right now, so it can&rsquo;t sign you in the usual
            way. That&rsquo;s what this password is for.
          </p>
          {state.session.hasPassword ? (
            <PasswordForm mode="login" onDone={onSignedIn} />
          ) : (
            <>
              <Note tone="warn">
                No password has been set for this app yet. You can set one now &mdash; but only because OpenMasjidOS
                is unreachable. Once it&rsquo;s back, signing in through the dashboard is the normal way in.
              </Note>
              <PasswordForm mode="setup" onDone={onSignedIn} />
            </>
          )}
        </Card>
      );

    /** Standalone first run — no platform at all, so there is nothing to defer to. */
    case 'choose-password':
      return (
        <Card icon={<ShieldCheck size={26} strokeWidth={1.75} aria-hidden="true" />} title="Set up this app">
          <p className="centre-lead">Choose a password for the settings panel. Only you need it &mdash; nobody visiting the prayer times ever will.</p>
          <PasswordForm mode="setup" onDone={onSignedIn} />
        </Card>
      );

    case 'password':
      return (
        <Card icon={<KeyRound size={26} strokeWidth={1.75} aria-hidden="true" />} title="Sign in">
          <PasswordForm mode="login" onDone={onSignedIn} />
        </Card>
      );

    case 'in':
      // Never rendered — the panel handles this state. Present so the switch is exhaustive and
      // a new AuthState variant fails to compile rather than falling through to nothing.
      return <></>;
  }
}
