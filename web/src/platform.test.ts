// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The user-agent table, pinned.
 *
 * These strings ARE the mechanism — there is nothing to feature-detect (see platform.ts) — and a
 * regex that quietly stops matching fails silently on exactly the phones nobody in the masjid
 * tests on. The failure is not cosmetic either: getting `browserOf` wrong on an iPhone tells
 * somebody to look for "Add to Home Screen" in a Share sheet that does not contain it, and they
 * conclude the masjid's app is broken.
 *
 * Every function here takes its environment as an argument, so none of this needs a browser.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { browserOf, deviceOf, inAppOf, installRoute, osOf, preferredBrowser, type Env } from './platform';

const env = (ua: string, platform = 'iPhone', maxTouchPoints = 5): Env => ({ ua, platform, maxTouchPoints });

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko)';

// ── Which phone ──────────────────────────────────────────────────────────────

test('the operating system, including an iPad claiming to be a Mac', () => {
  assert.equal(osOf(env(`${IPHONE} Version/17.4 Mobile/15E148 Safari/604.1`)), 'ios');
  assert.equal(osOf(env(`${ANDROID} Chrome/122.0.0.0 Mobile Safari/537.36`, 'Linux armv8l')), 'android');
  // iPadOS 13+ requests desktop sites by default and reports MacIntel. The touch count is the
  // only thing separating it from a MacBook — without it, every desktop Safari would be handed
  // instructions for a Share sheet it does not have.
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15';
  assert.equal(osOf(env(MAC, 'MacIntel', 5)), 'ios', 'an iPad');
  assert.equal(osOf(env(MAC, 'MacIntel', 0)), 'macos', 'a real Mac');
  assert.equal(osOf(env('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0', 'Win32', 0)), 'windows');
});

test('the admin only ever sees four device rows', () => {
  // A masjid does nothing differently for Windows than for Linux. "iPhone vs Android" decides
  // which half of the poster's instructions matter, which is why that split is the one kept.
  assert.equal(deviceOf('ios'), 'ios');
  assert.equal(deviceOf('android'), 'android');
  for (const os of ['macos', 'windows', 'linux'] as const) assert.equal(deviceOf(os), 'desktop');
  assert.equal(deviceOf('other'), 'other');
});

// ── Which browser ────────────────────────────────────────────────────────────

test('SAFARI ON AN IPHONE IS THE ONE THAT CAN INSTALL', () => {
  const e = env(`${IPHONE} Version/17.4 Mobile/15E148 Safari/604.1`);
  assert.equal(browserOf(e), 'safari');
  assert.equal(installRoute({ os: 'ios', browser: 'safari', secure: true, standalone: false, prompt: false }), 'ios-safari');
});

test('every other iOS browser is iOS, and is NOT Safari', () => {
  // All of these carry "Safari/605" too, which is why testing FOR Safari matches every one of
  // them and testing for each impostor does not.
  const others: [string, string][] = [
    ['Chrome', `${IPHONE} CriOS/122.0.6261.89 Mobile/15E148 Safari/604.1`],
    ['Firefox', `${IPHONE} FxiOS/124.0 Mobile/15E148 Safari/605.1.15`],
    ['Edge', `${IPHONE} Version/17.0 EdgiOS/122.0.0.0 Mobile/15E148 Safari/605.1.15`],
    ['Opera', `${IPHONE} OPiOS/16.0.0.0 Mobile/15E148 Safari/9537.53`],
    ['DuckDuckGo', `${IPHONE} Version/17.0 Mobile/15E148 DuckDuckGo/7 Safari/605.1.15`],
    ['Facebook in-app', `${IPHONE} Mobile/15E148 [FBAN/FBIOS;FBAV/450.0.0.35.108]`],
    ['Instagram in-app', `${IPHONE} Mobile/15E148 Instagram 302.0.0.23.113`],
    ['Google app', `${IPHONE} Version/17.0 Mobile/15E148 Safari/604.1 GSA/295.0`],
  ];
  for (const [name, ua] of others) {
    const e = env(ua);
    assert.equal(osOf(e), 'ios', `${name} is still iOS`);
    assert.notEqual(browserOf(e), 'safari', `${name} cannot add to the home screen`);
    assert.equal(
      installRoute({ os: 'ios', browser: browserOf(e), secure: true, standalone: false, prompt: false }),
      'switch',
      `${name} must be told to open Safari`,
    );
  }
});

test('AN UNKNOWN iOS BROWSER IS ASSUMED TO BE SAFARI', () => {
  // The safer way round. Being wrong here shows the Share-sheet instructions, which are at least
  // true of iOS in general; being wrong the other way tells somebody already IN Safari to go and
  // open Safari, which is unfollowable advice.
  assert.equal(browserOf(env(`${IPHONE} Version/17.4 Mobile/15E148 SomeNewBrowser/1.0 Safari/604.1`)), 'safari');
});

test('the Android browsers, each found before the token they all share', () => {
  // Every one of these carries "Chrome/" as well. The specific marker has to be tested before
  // the general one, all the way down, or they all come back as Chrome.
  const cases: [string, string][] = [
    ['chrome', `${ANDROID} Chrome/122.0.0.0 Mobile Safari/537.36`],
    ['edge', `${ANDROID} Chrome/122.0.0.0 Mobile Safari/537.36 EdgA/122.0.0.0`],
    ['opera', `${ANDROID} Chrome/122.0.0.0 Mobile Safari/537.36 OPR/79.0.0.0`],
    ['samsung', `${ANDROID} SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36`],
    ['firefox', 'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0'],
  ];
  for (const [want, ua] of cases) assert.equal(browserOf(env(ua, 'Linux armv8l')), want, ua);
});

test('a desktop Safari is Safari, and Chrome on a Mac is not', () => {
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
  assert.equal(browserOf(env(`${MAC} Version/17.4 Safari/605.1.15`, 'MacIntel', 0)), 'safari');
  assert.equal(browserOf(env(`${MAC} (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36`, 'MacIntel', 0)), 'chrome');
});

// ── Inside somebody else's app ───────────────────────────────────────────────

test('IN-APP BROWSERS ARE NAMED, so the advice can name them back', () => {
  assert.equal(inAppOf(`${IPHONE} Mobile/15E148 Instagram 302.0.0.23.113`), 'Instagram');
  assert.equal(inAppOf(`${IPHONE} Mobile/15E148 [FBAN/FBIOS;FBAV/450.0]`), 'Facebook');
  assert.equal(inAppOf(`${ANDROID} Chrome/122.0.0.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0]`), 'Facebook');
  assert.equal(inAppOf(`${ANDROID} Version/4.0 Chrome/122.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0`), 'WeChat');
});

test('an Android WebView with no name is still not a browser', () => {
  // `; wv)` is what Android puts in the user agent of a WebView, which is every "browser" that
  // is really a screen inside another app. It is the general rule behind the named ones.
  const wv = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36';
  assert.equal(inAppOf(wv), 'another app');
  assert.equal(browserOf(env(wv, 'Linux armv8l')), 'inapp');
});

test('A WEBVIEW IS NEVER OFFERED AN INSTALL, EVEN WHEN IT OFFERS US ONE', () => {
  // Some in-app browsers do fire `beforeinstallprompt`, and taking it adds an icon that opens
  // back inside that app — a shortcut into Instagram, not the masjid's prayer times. Worse than
  // failing, because it looks like it worked.
  assert.equal(installRoute({ os: 'android', browser: 'inapp', secure: true, standalone: false, prompt: true }), 'switch');
});

// ── What to do about it ──────────────────────────────────────────────────────

test('the install route, in the order the checks have to happen', () => {
  const base = { os: 'android' as const, browser: 'chrome' as const, secure: true, standalone: false, prompt: false };
  assert.equal(installRoute({ ...base, standalone: true }), 'installed', 'already there beats everything');
  // Checked before the prompt: over plain HTTP on the masjid's wifi there is no install API at
  // all, and a kiosk on the LAN is a legitimate way to open this app rather than a fault.
  assert.equal(installRoute({ ...base, secure: false }), 'unavailable');
  assert.equal(installRoute({ ...base, prompt: true }), 'prompt');
  // Chromium that has not offered a prompt — or has already used it — still has "Install app" in
  // its own menu, and saying so is better than the silence this used to be.
  assert.equal(installRoute(base), 'menu');
  assert.equal(installRoute({ ...base, browser: 'firefox' }), 'menu');
  assert.equal(installRoute({ ...base, os: 'windows' }), 'desktop');
});

test('somebody is only ever sent to a browser that can actually do it', () => {
  assert.equal(preferredBrowser('ios'), 'Safari');
  assert.equal(preferredBrowser('android'), 'Chrome');
  assert.equal(preferredBrowser('windows'), 'Chrome');
});
