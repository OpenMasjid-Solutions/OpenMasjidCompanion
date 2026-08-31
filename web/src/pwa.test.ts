// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Which browser is this, and can it install a web app?
 *
 * **Add to Home Screen is a Safari feature, not an iOS one.** Every browser on iOS is WebKit
 * underneath, so they are indistinguishable to feature detection — and telling someone in
 * Chrome to look for "Add to Home Screen" in their Share sheet sends them hunting for a button
 * that is not on their screen. There is no way to know except the user-agent string, so the
 * strings are pinned here: they are the whole mechanism, and a regex that quietly stops matching
 * fails silently on exactly the phones nobody tests on.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { isIos, isIosSafari } from './pwa';

/** Pretend to be a browser. `pwa.ts` reads `navigator`, so give it one.
 *  `defineProperty`, not assignment: Node 22 exposes a real `navigator` with only a getter. */
function as(ua: string, platform = 'iPhone', maxTouchPoints = 5): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: ua, platform, maxTouchPoints },
    configurable: true,
    writable: true,
  });
}

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';

test('SAFARI ON AN IPHONE IS THE ONE THAT CAN INSTALL', () => {
  as(`${IPHONE} Version/17.4 Mobile/15E148 Safari/604.1`);
  assert.equal(isIos(), true);
  assert.equal(isIosSafari(), true);
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
    as(ua);
    assert.equal(isIos(), true, `${name} is still iOS`);
    assert.equal(isIosSafari(), false, `${name} cannot add to the home screen`);
  }
});

test('an iPad pretending to be a Mac is still iOS', () => {
  // iPadOS reports MacIntel. Without the touch-point check every desktop Safari would be told
  // to use a Share sheet it does not have.
  as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15', 'MacIntel', 5);
  assert.equal(isIos(), true);
  assert.equal(isIosSafari(), true);
});

test('a real Mac is not iOS, and is never told about a Share sheet', () => {
  as('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15', 'MacIntel', 0);
  assert.equal(isIos(), false);
  assert.equal(isIosSafari(), false);
});

test('Android is not iOS — it gets a real install prompt instead', () => {
  as('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/122.0.0.0 Mobile Safari/537.36', 'Linux armv8l', 5);
  assert.equal(isIos(), false);
  assert.equal(isIosSafari(), false);
});

test('AN UNKNOWN iOS BROWSER IS ASSUMED TO BE SAFARI', () => {
  // The safer way round. Being wrong here shows the Share-sheet instructions, which are at
  // least true of iOS in general; being wrong the other way would tell someone already IN
  // Safari to go and open Safari.
  as(`${IPHONE} Version/17.4 Mobile/15E148 SomeNewBrowser/1.0 Safari/604.1`);
  assert.equal(isIosSafari(), true);
});
