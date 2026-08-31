// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Who the admin is, and how they can get in.
 *
 * The three not-signed-in states below are deliberately separate all the way to the screen.
 * "You are not signed in" and "OpenMasjidOS is unreachable" look similar and are completely
 * different problems: the first is solved by pressing Open in the dashboard, the second can
 * only be solved by the local password — and an app that shows the first message during the
 * second situation has locked its admin out of their own masjid's app with advice that cannot
 * work.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

export interface Session {
  authed: boolean;
  /** The admin's OpenMasjidOS name, when SSO signed them in. Display only. */
  username?: string;
  /** Standalone with no password yet — go straight to choosing one. */
  needsSetup: boolean;
  hasPassword: boolean;
  sso: { enabled: boolean; reachable: boolean };
}

/** What the panel should actually put on screen. Derived once, here, so no screen has to
 *  re-derive it and get it subtly different. */
export type AuthState =
  /** Signed in — show the panel. */
  | { kind: 'in'; session: Session }
  /** Under OpenMasjidOS, platform up, just not signed in. Press Open in the dashboard. */
  | { kind: 'use-dashboard'; session: Session }
  /** Under OpenMasjidOS, but the platform is UNREACHABLE. The local password is the way in —
   *  and if none was ever set, setting one is allowed precisely now. */
  | { kind: 'platform-down'; session: Session }
  /** Standalone, no password yet — choose one. */
  | { kind: 'choose-password'; session: Session }
  /** Standalone with a password — sign in. */
  | { kind: 'password'; session: Session };

export function authStateOf(s: Session): AuthState {
  if (s.authed) return { kind: 'in', session: s };
  if (s.sso.enabled && s.sso.reachable) return { kind: 'use-dashboard', session: s };
  if (s.sso.enabled && !s.sso.reachable) return { kind: 'platform-down', session: s };
  if (s.needsSetup) return { kind: 'choose-password', session: s };
  return { kind: 'password', session: s };
}

export function useSession(): {
  state: AuthState | null;
  error: string;
  reload: () => Promise<void>;
} {
  const [state, setState] = useState<AuthState | null>(null);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const r = await api.get<Session>('/api/session');
    if (r.ok) {
      setState(authStateOf(r.data));
      setError('');
    } else {
      setError(r.error);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { state, error, reload };
}
