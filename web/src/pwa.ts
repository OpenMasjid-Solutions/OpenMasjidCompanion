// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * pwa.ts — installing this app on a phone, and updating it once it is there.
 *
 * Three facts shape everything here, and all three are platform truths rather than choices:
 *
 *  1. **It needs a secure context.** Over plain HTTP on the masjid's LAN there is no
 *     `serviceWorker` and no install prompt at all. So the page must not offer either — a
 *     button that cannot work is worse than no button (CLAUDE.md §6.4).
 *  2. **iOS has no install prompt.** Safari fires no `beforeinstallprompt` and exposes no API;
 *     the only route is Share → Add to Home Screen, by hand. An app that waits for an event
 *     that never comes shows an iPhone user nothing at all, for ever. So iOS is detected and
 *     told what to tap.
 *  3. **An update must never reload the page under someone.** Swapping the worker mid-read
 *     reloads what they were looking at. The new version waits; the reader presses Refresh.
 */
import { useCallback, useEffect, useState } from 'react';
import { withBase } from './base';

/** `BeforeInstallPromptEvent` is Chromium-only and not in the DOM lib. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallKind =
  /** Chromium: the browser will show a real prompt when asked. */
  | 'prompt'
  /** iOS Safari: no API — the musalli must use the Share sheet. */
  | 'ios'
  /** iOS, but in Chrome / Firefox / an in-app browser, where Add to Home Screen is not
   *  available at all. The only useful thing to say is "open this in Safari". */
  | 'ios-other'
  /** Already running from the home screen. */
  | 'installed'
  /** Not offerable: no secure context, or a browser that cannot. */
  | 'unavailable';

/** Are we running as an installed app rather than in a browser tab? */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

/** iOS or iPadOS, including iPadOS pretending to be a Mac. Detected because there is genuinely
 *  no feature to detect: the absence of `beforeinstallprompt` is indistinguishable from a
 *  browser that simply has not fired it yet. */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  const iOS = /iPad|iPhone|iPod/.test(ua);
  const iPadOS = navigator.platform === 'MacIntel' && (navigator as unknown as { maxTouchPoints: number }).maxTouchPoints > 1;
  return iOS || iPadOS;
}

/**
 * On iOS, is this Safari itself?
 *
 * **Add to Home Screen is a Safari feature, not an iOS one.** Every browser on iOS is WebKit
 * underneath, which makes them look identical to feature detection, but only Safari's own share
 * sheet installs a web app. Someone in Chrome, or in the in-app browser that opens when they tap
 * a link in WhatsApp or Instagram, can follow "Share → Add to Home Screen" for as long as they
 * like and never find it — so the app has to say "open this in Safari first" instead.
 *
 * A DENYLIST, not an allowlist of Safari. Every one of these puts its own token in the user
 * agent while also carrying "Safari/605", so testing FOR Safari matches all of them; testing
 * for each impostor does not. An unrecognised browser is therefore assumed to be Safari, which
 * is the safer way round: the worst case is the Share-sheet instructions, which are at least
 * true of iOS in general.
 */
const NOT_SAFARI = /(CriOS|FxiOS|EdgiOS|OPiOS|OPT\/|YaBrowser|DuckDuckGo|FBAN|FBAV|FB_IAB|Instagram|Twitter|Snapchat|LinkedInApp|Pinterest|MicroMessenger|Line\/|GSA\/)/i;

export function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false;
  return isIos() && !NOT_SAFARI.test(navigator.userAgent);
}

/**
 * Register the service worker, and report when a new version is waiting.
 *
 * `secure` gates the whole thing: the caller passes what the SERVER said about remote access
 * rather than trusting `location.protocol`, because a page opened at `http://192.168.1.20:7880`
 * is a perfectly normal way for a kiosk to reach this app and must not be told it is broken.
 */
export function useServiceWorker(secure: boolean): { updateReady: boolean; applyUpdate: () => void } {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);

  useEffect(() => {
    if (!secure || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    let cancelled = false;

    const watch = (reg: ServiceWorkerRegistration) => {
      // Already waiting when we arrived — a second tab installed it.
      if (reg.waiting && navigator.serviceWorker.controller) setWaiting(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const next = reg.installing;
        if (!next) return;
        next.addEventListener('statechange', () => {
          // `controller` distinguishes an UPDATE from the very first install. On a first
          // install there is nothing to refresh into and no prompt to show.
          if (next.state === 'installed' && navigator.serviceWorker.controller && !cancelled) setWaiting(next);
        });
      });
    };

    navigator.serviceWorker
      .register(withBase('/sw.js'))
      .then((reg) => {
        if (cancelled) return;
        watch(reg);
        // A phone left open on a shelf should not sit on last week's build for ever.
        const id = setInterval(() => void reg.update().catch(() => undefined), 60 * 60_000);
        return () => clearInterval(id);
      })
      .catch(() => {
        // An unsupported or blocked worker is not an error worth showing anyone: the app works
        // perfectly well online without one.
      });

    return () => {
      cancelled = true;
    };
  }, [secure]);

  const applyUpdate = useCallback(() => {
    if (!waiting) return;
    // The worker skips waiting, then `controllerchange` reloads us into the new version. Only
    // ever on the reader's own say-so.
    waiting.postMessage('skip-waiting');
    const onChange = () => window.location.reload();
    navigator.serviceWorker.addEventListener('controllerchange', onChange, { once: true });
  }, [waiting]);

  return { updateReady: !!waiting, applyUpdate };
}

/**
 * Whether and how this app can be added to the home screen.
 *
 * `secure` comes from the server (see above). Everything else is browser state.
 */
export function useInstall(secure: boolean): { kind: InstallKind; install: () => Promise<void>; dismissed: boolean; dismiss: () => void } {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem('omc-install-dismissed') === '1';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (!secure) return;
    const onPrompt = (e: Event) => {
      // Suppressing the browser's own banner so the app can ask in its own words, at a moment
      // that makes sense — not the instant the page opens.
      e.preventDefault();
      setEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => setInstalled(true);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [secure]);

  const kind: InstallKind = installed
    ? 'installed'
    : !secure
      ? 'unavailable'
      : event
        ? 'prompt'
        : isIos()
          ? isIosSafari()
            ? 'ios'
            : 'ios-other'
          : 'unavailable';

  const dismiss = useCallback(() => {
    setDismissed(true);
    try {
      localStorage.setItem('omc-install-dismissed', '1');
    } catch {
      /* private browsing — it just will not persist */
    }
  }, []);

  const install = useCallback(async () => {
    if (!event) return;
    await event.prompt();
    const choice = await event.userChoice;
    // The event is single-use whatever they chose; a second prompt would do nothing.
    setEvent(null);
    if (choice.outcome === 'dismissed') dismiss();
  }, [event, dismiss]);

  return { kind, install, dismissed, dismiss };
}
