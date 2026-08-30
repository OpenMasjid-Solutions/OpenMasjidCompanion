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
import { browserOf, currentEnv, inAppOf, installRoute, isStandalone, osOf, type BrowserId, type InstallRoute, type Os } from './platform';

export { isStandalone };

/** `BeforeInstallPromptEvent` is Chromium-only and not in the DOM lib. */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * iOS or iPadOS, including an iPad claiming to be a Mac.
 *
 * Kept as its own name because three unrelated places ask exactly this question — the install
 * prompt, the reminders screen (iOS cannot subscribe outside a Home Screen app) and the
 * onboarding page. The rule itself lives in platform.ts, which is the only user-agent table
 * in this repository; this is a reading of it, not a second copy.
 */
export function isIos(): boolean {
  return osOf(currentEnv()) === 'ios';
}

/**
 * On iOS, is this Safari itself?
 *
 * **Add to Home Screen is a Safari feature, not an iOS one.** Someone in Chrome, or in the
 * in-app browser that opens when they tap a link in WhatsApp, can follow "Share → Add to Home
 * Screen" for as long as they like and never find it — so the app says "open this in Safari"
 * instead. See platform.ts for why this can only be a user-agent test.
 */
export function isIosSafari(): boolean {
  const env = currentEnv();
  return osOf(env) === 'ios' && browserOf(env) === 'safari';
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

/** What `useInstall` reports. `os` and `browser` ride along because the pages that ask this
 *  also have to NAME the browser in a sentence, and re-detecting it there is how two answers
 *  start disagreeing. */
export interface Install {
  route: InstallRoute;
  os: Os;
  browser: BrowserId;
  /** The app holding this page inside itself ("Instagram", "WhatsApp"), or '' for a real
   *  browser. Named rather than lumped together because "you tapped this link inside Instagram"
   *  is advice somebody can act on and "you are in an in-app browser" is jargon. */
  inApp: string;
  install: () => Promise<void>;
  dismissed: boolean;
  dismiss: () => void;
  /** True from the moment the browser reports the app was added, so a step can tick itself
   *  without a reload — `appinstalled` fires while the page is still open. */
  installed: boolean;
}

/**
 * Whether and how this app can be added to the home screen.
 *
 * `secure` comes from the server (see above). Everything else is browser state.
 */
export function useInstall(secure: boolean): Install {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());
  const [env] = useState(currentEnv);
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

  const os = osOf(env);
  const route = installRoute({ os, browser: browserOf(env), secure, standalone: installed, prompt: !!event });

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

  return { route, os, browser: browserOf(env), inApp: inAppOf(env.ua), install, dismissed, dismiss, installed };
}
