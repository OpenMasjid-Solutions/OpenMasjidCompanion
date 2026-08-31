// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * reminders.ts — the state behind prayer reminders, with no screen attached.
 *
 * Split out from `Notify.tsx` when notifications moved into Settings (Hasan, 2026-08-29),
 * because there are now **two places that can turn them on**: the settings screen, and the
 * onboarding page a musalli lands on from the QR code. Two copies of a subscribe flow is two
 * chances to forget the order that matters — tell the server to forget the row BEFORE
 * unsubscribing at the browser, or a failure leaves a row nothing can ever reach again.
 *
 * THE PLATFORM TRUTHS ANY SCREEN OVER THIS HAS TO SAY OUT LOUD, because each one is otherwise
 * a switch that does nothing:
 *
 *  - **A secure context is required.** Over plain HTTP on the masjid's LAN there is no
 *    PushManager at all. The server tells us whether we have one; we never guess from
 *    `location.protocol`, because a kiosk on the LAN is a legitimate way to open this app.
 *  - **On iOS the app must be on the Home Screen first.** Safari exposes no Notification API
 *    to a normal tab — 16.4 added web push, but only for installed web apps. Someone tapping
 *    "Allow" in a Safari tab would get nothing and no error, for ever.
 *  - **Permission can be denied permanently.** Once it is, no amount of asking helps; the only
 *    route back is the browser's own site settings, so that is what we say.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { isIos, isStandalone } from './pwa';

export const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
export type Prayer = (typeof PRAYERS)[number];

/** Jumu'ah is offered alongside the five, because on a Friday it is not Dhuhr — a different
 *  time, and often two of them hours apart. */
export type Notifiable = Prayer | 'jumuah';

export const LABELS: Record<Notifiable, string> = {
  fajr: 'Fajr',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
  jumuah: 'Jumuʿah',
};

export interface Prefs {
  prayers: Notifiable[];
  adhan: boolean;
  /** Minutes before the Iqamah; null = not wanted. */
  beforeIqamah: number | null;
  /** WHICH Jumu'ah, by position. null = all of them, which is the default. */
  jumuah: number[] | null;
  /** Occasional notices from the masjid. A separate choice from the prayer reminders: someone
   *  who wants silence at prayer times may still want to hear about a funeral. */
  announcements: boolean;
}

/** Everything on, fifteen minutes before the Iqamah — enough to leave the house. */
export const DEFAULTS: Prefs = {
  prayers: [...PRAYERS, 'jumuah'],
  adhan: false,
  beforeIqamah: 15,
  jumuah: null,
  announcements: true,
};

/** The lead times offered. A field would invite "0" and "60" and a lot of thought about a
 *  choice that has three sensible answers. */
export const LEADS = [5, 10, 15, 20, 30] as const;

/**
 * Why notifications cannot be offered here — or '' when they can.
 *
 * Pure, and exported, because this is the decision the whole screen turns on and every branch
 * of it is a platform rule rather than a preference. Getting it wrong shows somebody a switch
 * that silently does nothing.
 */
export type Blocker = '' | 'insecure' | 'ios-not-installed' | 'unsupported' | 'denied';

export function blockerFor(input: {
  secure: boolean;
  ios: boolean;
  standalone: boolean;
  hasPush: boolean;
  permission: NotificationPermission | 'unavailable';
}): Blocker {
  if (!input.secure) return 'insecure';
  // Checked BEFORE `hasPush`, because iOS Safari in a tab reports no PushManager at all and
  // "your browser doesn't support this" would be both wrong and unactionable — the same
  // browser supports it perfectly once the app is on the Home Screen.
  if (input.ios && !input.standalone) return 'ios-not-installed';
  if (!input.hasPush || input.permission === 'unavailable') return 'unsupported';
  if (input.permission === 'denied') return 'denied';
  return '';
}

export function readEnv() {
  const hasPush = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
  const permission: NotificationPermission | 'unavailable' =
    typeof Notification === 'undefined' ? 'unavailable' : Notification.permission;
  return { ios: isIos(), standalone: isStandalone(), hasPush, permission };
}

/**
 * base64url → the bytes `applicationServerKey` wants.
 *
 * Written over an explicitly allocated ArrayBuffer rather than `Uint8Array.from`, because the
 * latter is typed over `ArrayBufferLike` — which includes SharedArrayBuffer — and the DOM's
 * BufferSource will not accept that. Same bytes, a type the browser API actually takes.
 */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export interface Reminders {
  /** Why this device cannot have reminders, or '' when it can. */
  blocker: Blocker;
  /** Is this device subscribed? `null` while we are still finding out. */
  on: boolean | null;
  busy: boolean;
  error: string;
  prefs: Prefs;
  /** Ask the browser, subscribe, and store the current preferences. Resolves to whether it
   *  worked, so a caller mid-way through onboarding can move to the next step. */
  enable: () => Promise<boolean>;
  disable: () => Promise<void>;
  save: (next: Prefs) => Promise<void>;
}

/**
 * Everything a screen needs to offer prayer reminders on THIS device.
 *
 * **Nothing here happens on its own.** The browser is only asked for permission inside
 * `enable`, which is only ever called from a tap: a permission prompt on page load is how a
 * browser learns to block a site for good.
 */
export function useReminders(secure: boolean): Reminders {
  const [env, setEnv] = useState(readEnv);
  const [prefs, setPrefs] = useState<Prefs>(DEFAULTS);
  const [on, setOn] = useState<boolean | null>(null); // null = still finding out
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const blocker = blockerFor({ secure, ...env });

  /** What this device already chose, if anything. */
  useEffect(() => {
    if (blocker) {
      setOn(false);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!alive) return;
        if (!sub) {
          setOn(false);
          return;
        }
        const r = await api.post<{ prefs: Prefs | null }>('/api/public/push/prefs', { endpoint: sub.endpoint });
        if (!alive) return;
        // Subscribed at the browser but unknown to the server — a restored backup, or a
        // volume that was replaced. Treated as off, so the next tap re-registers it.
        if (r.ok && r.data.prefs) {
          setPrefs(r.data.prefs);
          setOn(true);
        } else {
          setOn(false);
        }
      } catch {
        if (alive) setOn(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [blocker]);

  /**
   * Push the current choices to the server for the subscription this device already has.
   *
   * The chip moves first, because a switch that waits on a round trip feels broken — but a
   * FAILED save is put back. Leaving the screen showing a choice the server never received is
   * the worst of both: the reader believes they have changed something, and their phone goes on
   * doing what it did before.
   */
  const save = useCallback(
    async (next: Prefs) => {
      const before = prefs;
      setPrefs(next);
      setError('');
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return;
        const r = await api.post('/api/public/push/subscribe', { subscription: sub.toJSON(), prefs: next });
        if (!r.ok) {
          setPrefs(before);
          setError(r.error);
        }
      } catch {
        setPrefs(before);
        setError('That didn’t save. Your phone may be offline.');
      }
    },
    [prefs],
  );

  const enable = useCallback(async (): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      // Asked on a real tap and never before. A permission prompt on page load is how a
      // browser learns to block a site for good.
      const permission = await Notification.requestPermission();
      setEnv((e) => ({ ...e, permission }));
      if (permission !== 'granted') {
        setBusy(false);
        return false;
      }

      const keyRes = await api.get<{ key: string; enabled: boolean }>('/api/public/push/key');
      if (!keyRes.ok || !keyRes.data.key) {
        setError('This masjid hasn’t finished setting up notifications yet.');
        setBusy(false);
        return false;
      }

      const reg = await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({
          // Required, and true in fact: every push this app sends shows a notification.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyRes.data.key),
        }));

      const r = await api.post('/api/public/push/subscribe', { subscription: sub.toJSON(), prefs });
      if (!r.ok) {
        setError(r.error);
        setBusy(false);
        return false;
      }
      setOn(true);
      setBusy(false);
      return true;
    } catch {
      setError('Your phone wouldn’t turn notifications on. It may be offline.');
    }
    setBusy(false);
    return false;
  }, [prefs]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        // Told to forget it, then unsubscribed at the browser. That order matters: if the
        // request fails we have not yet broken the only handle we have on the row.
        await api.post('/api/public/push/unsubscribe', { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setOn(false);
    } catch {
      setError('That didn’t work. Please try again.');
    }
    setBusy(false);
  }, []);

  return { blocker, on, busy, error, prefs, enable, disable, save };
}
