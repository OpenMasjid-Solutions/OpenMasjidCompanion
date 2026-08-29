// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Prayer reminders, as a musalli sets them.
 *
 * **This is the most refusable thing in the app**, and it is built that way on purpose: it is
 * off until someone asks, it asks the browser for permission only on a real tap, and turning
 * it off removes the subscription rather than merely muting it. Nothing about this screen
 * exists unless the reader opened it.
 *
 * THE PLATFORM TRUTHS THIS SCREEN HAS TO SAY OUT LOUD, because each one is otherwise a switch
 * that does nothing:
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
import { Bell, BellOff, Check, Loader2, X } from 'lucide-react';
import { api } from './api';
import { isIos, isStandalone } from './pwa';

export const PRAYERS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const;
export type Prayer = (typeof PRAYERS)[number];

const LABELS: Record<Prayer, string> = {
  fajr: 'Fajr',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
};

export interface Prefs {
  prayers: Prayer[];
  adhan: boolean;
  /** Minutes before the jamā'ah; null = not wanted. */
  beforeIqamah: number | null;
  /** Occasional notices from the masjid. A separate choice from the prayer reminders: someone
   *  who wants silence at prayer times may still want to hear about a funeral. */
  announcements: boolean;
}

/** Everything on, fifteen minutes before the jamā'ah — enough to leave the house. */
export const DEFAULTS: Prefs = { prayers: [...PRAYERS], adhan: false, beforeIqamah: 15, announcements: true };

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

function readState() {
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
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

export function Notify({ secure, onClose }: { secure: boolean; onClose: () => void }): JSX.Element {
  const [env, setEnv] = useState(readState);
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

  /** Push the current choices to the server for the subscription this device already has. */
  const save = useCallback(async (next: Prefs) => {
    setPrefs(next);
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api.post('/api/public/push/subscribe', { subscription: sub.toJSON(), prefs: next });
  }, []);

  const enable = async () => {
    setBusy(true);
    setError('');
    try {
      // Asked on a real tap and never before. A permission prompt on page load is how a
      // browser learns to block a site for good.
      const permission = await Notification.requestPermission();
      setEnv((e) => ({ ...e, permission }));
      if (permission !== 'granted') {
        setBusy(false);
        return;
      }

      const keyRes = await api.get<{ key: string; enabled: boolean }>('/api/public/push/key');
      if (!keyRes.ok || !keyRes.data.key) {
        setError('This masjid hasn’t finished setting up notifications yet.');
        setBusy(false);
        return;
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
        return;
      }
      setOn(true);
    } catch {
      setError('Your phone wouldn’t turn notifications on. It may be offline.');
    }
    setBusy(false);
  };

  const disable = async () => {
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
  };

  const togglePrayer = (p: Prayer) => {
    const next = prefs.prayers.includes(p) ? prefs.prayers.filter((x) => x !== p) : [...prefs.prayers, p];
    void save({ ...prefs, prayers: next });
  };

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal modal--sheet" role="dialog" aria-modal="true" aria-labelledby="notify-title" onClick={(e) => e.stopPropagation()}>
        <button className="icon-btn modal__close" onClick={onClose} aria-label="Close">
          <X size={18} aria-hidden="true" />
        </button>

        <h2 className="modal__title" id="notify-title">
          Prayer reminders
        </h2>

        {blocker ? (
          <Blocked blocker={blocker} />
        ) : on === null ? (
          <p className="modal__text">
            <Loader2 size={16} className="spin" aria-hidden="true" />
          </p>
        ) : !on ? (
          <>
            <p className="modal__text">
              A quiet reminder on this phone before each jamāʿah, and the occasional notice from the masjid. Only this
              device, and you can turn any of it off whenever you like &mdash; the masjid never sees who signed up.
            </p>
            {error && <p className="form-error">{error}</p>}
            <div className="modal__actions">
              <button className="btn btn--primary modal__go" onClick={() => void enable()} disabled={busy}>
                {busy ? <span className="spinner" /> : <Bell size={15} aria-hidden="true" />}
                Turn on reminders
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="notify__group">
              <div className="notify__label">Remind me for</div>
              <div className="notify__chips">
                {PRAYERS.map((p) => {
                  const chosen = prefs.prayers.includes(p);
                  return (
                    <button
                      key={p}
                      className={chosen ? 'chip chip--on' : 'chip'}
                      onClick={() => togglePrayer(p)}
                      aria-pressed={chosen}
                    >
                      {chosen && <Check size={13} aria-hidden="true" />}
                      {LABELS[p]}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="notify__group">
              <div className="notify__label">When</div>
              <div className="notify__chips">
                <button
                  className={prefs.adhan ? 'chip chip--on' : 'chip'}
                  onClick={() => void save({ ...prefs, adhan: !prefs.adhan })}
                  aria-pressed={prefs.adhan}
                >
                  {prefs.adhan && <Check size={13} aria-hidden="true" />}
                  At the adhan
                </button>
                {LEADS.map((m) => {
                  const chosen = prefs.beforeIqamah === m;
                  return (
                    <button
                      key={m}
                      className={chosen ? 'chip chip--on' : 'chip'}
                      // Tapping the chosen one clears it, so "adhan only" is reachable.
                      onClick={() => void save({ ...prefs, beforeIqamah: chosen ? null : m })}
                      aria-pressed={chosen}
                    >
                      {chosen && <Check size={13} aria-hidden="true" />}
                      {m} min before
                    </button>
                  );
                })}
              </div>
              {!prefs.adhan && prefs.beforeIqamah === null && (
                <p className="notify__hint">Nothing is selected, so no prayer reminders will be sent.</p>
              )}
            </div>

            {/* Its own group, because it is its own thing. Someone who wants silence at prayer
                times may still want to hear that the masjid is closed on Saturday — folding
                this in with the prayer switches would take that choice away from them. */}
            <div className="notify__group">
              <div className="notify__label">From the masjid</div>
              <div className="notify__chips">
                <button
                  className={prefs.announcements ? 'chip chip--on' : 'chip'}
                  onClick={() => void save({ ...prefs, announcements: !prefs.announcements })}
                  aria-pressed={prefs.announcements}
                >
                  {prefs.announcements && <Check size={13} aria-hidden="true" />}
                  Announcements
                </button>
              </div>
            </div>

            {error && <p className="form-error">{error}</p>}

            <div className="modal__actions">
              <button className="btn modal__later" onClick={() => void disable()} disabled={busy}>
                {busy ? <span className="spinner" /> : <BellOff size={15} aria-hidden="true" />}
                Turn reminders off
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Every one of these is a platform rule, so each says what it is and what would fix it. */
function Blocked({ blocker }: { blocker: Blocker }): JSX.Element {
  if (blocker === 'insecure') {
    return (
      <p className="modal__text">
        Reminders need this app to be opened over the internet rather than on the masjid&rsquo;s own wifi. Scan the QR
        code on the noticeboard, or ask the masjid for the link.
      </p>
    );
  }
  if (blocker === 'ios-not-installed') {
    return (
      <p className="modal__text">
        On an iPhone or iPad, reminders only work once this is on your <b>Home Screen</b>. Tap Share, then{' '}
        <b>Add to Home Screen</b>, open it from there, and this will be waiting.
      </p>
    );
  }
  if (blocker === 'denied') {
    return (
      <p className="modal__text">
        Notifications are blocked for this app in your browser&rsquo;s settings. You&rsquo;d need to allow them there
        first &mdash; we can&rsquo;t ask again from here.
      </p>
    );
  }
  return (
    <p className="modal__text">
      This browser can&rsquo;t do notifications. Opening the app in Chrome or Safari, or adding it to your home screen,
      usually does it.
    </p>
  );
}

/** The bell in the header. Hidden entirely when it could do nothing at all. */
export function NotifyButton({ secure, onOpen }: { secure: boolean; onOpen: () => void }): JSX.Element | null {
  const [env] = useState(readState);
  // 'insecure' and 'unsupported' mean there is nothing to offer and nothing to explain that
  // the reader could act on right now. iOS-not-installed and denied DO get the bell, because
  // both have a next step and a musalli wondering why there are no reminders deserves it.
  const blocker = blockerFor({ secure, ...env });
  if (blocker === 'insecure' || blocker === 'unsupported') return null;
  return (
    <button className="icon-btn" onClick={onOpen} aria-label="Prayer reminders">
      <Bell size={19} aria-hidden="true" />
    </button>
  );
}
