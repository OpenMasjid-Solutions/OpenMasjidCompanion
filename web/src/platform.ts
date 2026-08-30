// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * platform.ts — which phone, which browser, and can it install this app.
 *
 * **This is the only user-agent table in the repository, and it has to stay that way.** Two
 * tables that disagree is not a style problem: the onboarding page would tell somebody to press
 * a button the install code has already decided not to offer, and the two would be right about
 * different browsers. `pwa.ts` re-exports its answers rather than sniffing again.
 *
 * Sniffing at all is a last resort and it is used here because there is genuinely nothing to
 * feature-detect. **Every browser on iOS is WebKit**, so Chrome, Firefox and the in-app browser
 * that opens when you tap a link in Instagram are indistinguishable from Safari to any API a
 * page can call — and only Safari's own Share sheet can add a web app to the Home Screen. The
 * absence of `beforeinstallprompt` says nothing either: a Chromium browser that will fire it in
 * a second looks exactly like one that never will.
 *
 * The strings are pinned by `platform.test.ts`. A regex that quietly stops matching fails
 * silently, on exactly the phones nobody in the masjid tests on.
 */

/** The operating system, as far as it changes what we tell somebody to do. */
export type Os = 'ios' | 'android' | 'macos' | 'windows' | 'linux' | 'other';

/** Coarser, for the admin's breakdown: a masjid wants iPhone / Android / computer. */
export type Device = 'ios' | 'android' | 'desktop' | 'other';

export type BrowserId = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'opera' | 'inapp' | 'other';

/** Installed and launched from the home screen, or an ordinary browser tab. */
export type Mode = 'standalone' | 'browser';

/** What this module reads. Passed in rather than taken from globals so every rule below is a
 *  pure function a test can drive without a browser. */
export interface Env {
  ua: string;
  /** `navigator.platform`. Deprecated, still the only way to catch an iPad claiming to be a
   *  Mac — it reports "MacIntel" and a real touch count, where a Mac reports no touch. */
  platform: string;
  maxTouchPoints: number;
}

export function currentEnv(): Env {
  if (typeof navigator === 'undefined') return { ua: '', platform: '', maxTouchPoints: 0 };
  return {
    ua: navigator.userAgent || '',
    platform: navigator.platform || '',
    maxTouchPoints: (navigator as unknown as { maxTouchPoints?: number }).maxTouchPoints ?? 0,
  };
}

/**
 * The apps that open links inside themselves.
 *
 * Named rather than lumped together, because "open this in Safari" is advice somebody has to
 * act on while looking at an unfamiliar screen, and "tap the ⋯ in the corner of Instagram" is
 * only useful if we know they are in Instagram. The value is the app's name as a musalli would
 * say it, dropped straight into a sentence.
 */
const IN_APP: [RegExp, string][] = [
  [/FBAN|FBAV|FB_IAB|FBIOS|FB4A/i, 'Facebook'],
  [/Instagram/i, 'Instagram'],
  [/\bWhatsApp/i, 'WhatsApp'],
  [/MicroMessenger/i, 'WeChat'],
  [/\bLine\//i, 'LINE'],
  [/Snapchat/i, 'Snapchat'],
  [/LinkedInApp/i, 'LinkedIn'],
  [/TwitterAndroid|\bTwitter\b/i, 'X'],
  [/TikTok|BytedanceWebview|musical_ly/i, 'TikTok'],
  [/Pinterest/i, 'Pinterest'],
  [/\bGSA\//i, 'the Google app'],
  [/\bYJApp|Telegram/i, 'Telegram'],
];

/**
 * Which app is holding this page inside itself, or '' for a real browser.
 *
 * The last rule is the general one: `; wv)` is what Android puts in the user agent of a
 * WebView, which is every "browser" that is really a screen inside another app. There is no
 * equivalent on iOS — `SFSafariViewController` carries Safari's user agent exactly, and cannot
 * add to the Home Screen — so that case is genuinely undetectable and the honest response is
 * the one this app already gives: instructions that name Safari, which are at least true.
 */
export function inAppOf(ua: string): string {
  for (const [re, name] of IN_APP) if (re.test(ua)) return name;
  if (/;\s*wv\)/.test(ua)) return 'another app';
  return '';
}

export function osOf(env: Env): Os {
  const { ua } = env;
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  // An iPad on iPadOS 13+ requests desktop sites by default and reports itself as a Mac. The
  // touch count is the only thing that separates it from a MacBook.
  if (env.platform === 'MacIntel' && env.maxTouchPoints > 1) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Linux|X11|CrOS/i.test(ua)) return 'linux';
  return 'other';
}

/** What the admin's breakdown counts. A phone is a phone; the three desktops are one row. */
export function deviceOf(os: Os): Device {
  if (os === 'ios' || os === 'android') return os;
  if (os === 'macos' || os === 'windows' || os === 'linux') return 'desktop';
  return 'other';
}

/**
 * Which browser.
 *
 * The order is the whole thing. Every Chromium browser carries `Chrome/` and every iOS browser
 * carries `Safari/`, so testing for the common token first matches all of them — the specific
 * marker has to be checked before the general one, all the way down.
 */
export function browserOf(env: Env): BrowserId {
  const { ua } = env;
  if (inAppOf(ua)) return 'inapp';

  if (osOf(env) === 'ios') {
    // All WebKit underneath, and the distinction still matters: only Safari can install.
    if (/CriOS/i.test(ua)) return 'chrome';
    if (/FxiOS/i.test(ua)) return 'firefox';
    if (/EdgiOS/i.test(ua)) return 'edge';
    if (/OPiOS|OPT\//i.test(ua)) return 'opera';
    if (/DuckDuckGo|YaBrowser|Brave/i.test(ua)) return 'other';
    // Anything unrecognised is assumed to be Safari. That is the safer way to be wrong: the
    // worst case is Share-sheet instructions, which are true of iOS in general — where the
    // other way round tells somebody already in Safari to go and open Safari.
    return 'safari';
  }

  if (/Edg(A|iOS)?\//i.test(ua)) return 'edge';
  if (/OPR\/|Opera/i.test(ua)) return 'opera';
  if (/SamsungBrowser/i.test(ua)) return 'samsung';
  if (/Firefox\/|FxiOS/i.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\//i.test(ua)) return 'chrome';
  // Safari last: it is the one that identifies itself by what it does NOT say.
  if (/Safari\//i.test(ua)) return 'safari';
  return 'other';
}

/** For naming the browser back to a musalli in a sentence. The admin panel has its own map of
 *  the same values in different words — see the note in `admin/Insights.tsx`. */
export const BROWSER_LABEL: Record<BrowserId, string> = {
  safari: 'Safari',
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  samsung: 'Samsung Internet',
  opera: 'Opera',
  inapp: 'In-app browser',
  other: 'Other',
};

/** Are we running as an installed app rather than in a browser tab? */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  // iOS has never implemented `display-mode: standalone` for home-screen web apps; it has its
  // own non-standard flag instead, and checking only the standard one misses every iPhone.
  const ios = (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  return ios || window.matchMedia('(display-mode: standalone)').matches;
}

export function modeOf(): Mode {
  return isStandalone() ? 'standalone' : 'browser';
}

/**
 * How this browser can put the app on a home screen — the one question the whole onboarding
 * page turns on, and every branch of it is a platform rule rather than a preference.
 *
 *  - `prompt`        Chromium has offered us a real install prompt. Press the button.
 *  - `ios-safari`    No API exists on iOS. Share → Add to Home Screen, by hand.
 *  - `menu`          Chromium-ish, but no prompt has been offered — the browser's own menu
 *                    still has "Install app". True of Firefox and Samsung Internet always, and
 *                    of Chrome when the event has not fired (or has already been used).
 *  - `switch`        This browser cannot install at all: an in-app webview, or anything but
 *                    Safari on iOS. The only useful advice is which browser to open instead.
 *  - `desktop`       A computer. It can often install, but this app is for a pocket.
 *  - `installed`     Already there.
 *  - `unavailable`   No secure context: on the masjid's own wifi there is no install API at all.
 */
export type InstallRoute = 'prompt' | 'ios-safari' | 'menu' | 'switch' | 'desktop' | 'installed' | 'unavailable';

export function installRoute(input: {
  os: Os;
  browser: BrowserId;
  secure: boolean;
  standalone: boolean;
  /** Has Chromium actually handed us a `beforeinstallprompt` to fire? */
  prompt: boolean;
}): InstallRoute {
  if (input.standalone) return 'installed';
  if (!input.secure) return 'unavailable';
  // Checked before the prompt: an in-app webview can fire `beforeinstallprompt` and then
  // install into a container the person can never find again.
  if (input.browser === 'inapp') return 'switch';
  if (input.os === 'ios') return input.browser === 'safari' ? 'ios-safari' : 'switch';
  if (input.prompt) return 'prompt';
  if (input.os === 'android') return 'menu';
  return 'desktop';
}

/** Which browser to send somebody to when theirs cannot install. */
export function preferredBrowser(os: Os): string {
  return os === 'ios' ? 'Safari' : 'Chrome';
}
