// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Where someone lands when they arrive.
 *
 * Pressing "Open" on Companion in the OpenMasjidOS dashboard is an admin action — they want the
 * settings panel, not the page a musalli sees. The platform always opens an app at its ROOT and
 * has no manifest field for a path, so this app has to notice for itself, from the `#omos=`
 * fragment the dashboard attaches to Fabric apps.
 *
 * The rule has to be narrow in both directions: a musalli who scanned the QR code must never be
 * thrown into an admin login, and an admin who deep-linked somewhere must not be dragged off it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

(globalThis as { window?: unknown }).window = { __OMOS_BASE__: '', location: { origin: 'https://x' } };
const { dashboardLanding, routeOf } = await import('./App');

test('opened from the dashboard at the root → the admin panel', () => {
  assert.equal(dashboardLanding('/', true), '/admin');
});

test('A MUSALLI IS NEVER SENT TO THE ADMIN PANEL', () => {
  // No fragment means nobody opened this from a dashboard — they scanned a QR code or typed the
  // address. Sending them to a login screen would be the worst first impression this app could
  // make, and it is the direction of this rule that must never break.
  assert.equal(dashboardLanding('/', false), null);
  assert.equal(dashboardLanding('unknown', false), null);
});

test('a deep link is left alone, even from the dashboard', () => {
  // They already said where they wanted to go.
  assert.equal(dashboardLanding('/admin', true), null, 'already there — no second redirect');
  assert.equal(dashboardLanding('unknown', true), null);
});

test('the decision is made about the ROUTE, so the tunnel prefix is already gone', () => {
  // `routeOf` is what strips "/companion", and base.test.ts covers that. Composing them here is
  // what main.tsx actually does, and it is the composition that could be got wrong.
  assert.equal(dashboardLanding(routeOf('/'), true), '/admin');
  assert.equal(dashboardLanding(routeOf('/admin'), true), null);
});

// ── The tab bar ──────────────────────────────────────────────────────────────

test('the Donate tab exists only when the masjid has appeals', async () => {
  const { tabsFor } = await import('./App');
  // null is "we have not asked yet" and must not draw a tab on a maybe — the bar would appear a
  // moment after the page settled, moving the thing under someone's thumb.
  assert.deepEqual(tabsFor(null).map((t) => t.route), ['/', '/settings'], 'before the answer arrives, no Donate tab');
  assert.deepEqual(tabsFor(0).map((t) => t.route), ['/', '/settings'], 'no appeals, no tab');
  assert.deepEqual(tabsFor(2).map((t) => t.route), ['/', '/give', '/settings']);
});

test('SETTINGS IS LAST, WHATEVER ELSE IS THERE', async () => {
  // On a phone the outer edges of a tab bar are where a thumb lands by accident, and Settings is
  // the tab nobody wants to open twice. Donate must never be the one that moves, either — a tab
  // that changes position when the masjid starts an appeal is a tab people mis-tap for a week.
  const { tabsFor } = await import('./App');
  for (const appeals of [null, 0, 1, 9]) {
    const routes = tabsFor(appeals).map((t) => t.route);
    assert.equal(routes[0], '/', `Salah first (appeals=${appeals})`);
    assert.equal(routes[routes.length - 1], '/settings', `Settings last (appeals=${appeals})`);
  }
});

test('the bar is drawn on every install, because Settings is always a place to go', async () => {
  // Tabs.tsx still draws nothing below two, and that rule has not changed — a single lit tab
  // over the only screen there is would be a label taking up the most valuable strip of a phone.
  // What changed is that there is now genuinely a second place on every install, so the guard no
  // longer fires. If Settings is ever removed, this is the test that says the guard matters again.
  const { tabsFor } = await import('./App');
  assert.ok(tabsFor(0).length >= 2, 'Salah and Settings');
  assert.ok(tabsFor(1).length >= 2);
});

test('the appeals page is a route of its own, and unknown paths still are not', async () => {
  assert.equal(routeOf('/give'), '/give');
  assert.equal(routeOf('/give/'), '/give');
  assert.equal(routeOf('/give/anything'), 'unknown');
  assert.equal(routeOf('/donate'), 'unknown');
});

test('THE QR CODE ROUTE RESOLVES, and only in the exact shape', async () => {
  // The single most load-bearing route in the app: it is what is PRINTED on a noticeboard, and
  // a poster that lands on the not-found page cannot be fixed by pushing a build.
  assert.equal(routeOf('/onboarding'), '/onboarding');
  assert.equal(routeOf('/onboarding/'), '/onboarding', 'a trailing slash is the same page');
  assert.equal(routeOf('/onboarding/extra'), 'unknown');
  assert.equal(routeOf('/settings'), '/settings');
  assert.equal(routeOf('/settings/'), '/settings');
});

test('the printed link is built once and carries the base path', async () => {
  const { onboardingUrl, ONBOARDING_PATH } = await import('./base');
  assert.equal(onboardingUrl('https://omos.example.org/companion'), 'https://omos.example.org/companion/onboarding');
  // A public URL with a trailing slash is what the platform reports for a root-mounted app, and
  // "…//onboarding" on a printed poster is not something anybody can fix afterwards.
  assert.equal(onboardingUrl('https://omos.example.org/'), 'https://omos.example.org/onboarding');
  assert.equal(onboardingUrl(''), '', 'no public URL means no link to print, not a broken one');
  // And the router has to agree with what was printed. This is the composition that matters.
  assert.equal(routeOf(ONBOARDING_PATH), '/onboarding');
});

test('a musalli opening the Donate tab is never landed on the admin panel', async () => {
  // dashboardLanding only ever redirects from the ROOT. Someone who followed a link to /give
  // said where they wanted to go.
  assert.equal(dashboardLanding('/give', true), null);
  assert.equal(dashboardLanding('/', true), '/admin');
});
