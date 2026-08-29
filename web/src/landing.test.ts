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
  assert.deepEqual(tabsFor(null).map((t) => t.route), ['/'], 'before the answer arrives, one place to go');
  assert.deepEqual(tabsFor(0).map((t) => t.route), ['/'], 'no appeals, no tab');
  assert.deepEqual(tabsFor(2).map((t) => t.route), ['/', '/give']);
});

test('ONE TAB IS NOT A TAB BAR', async () => {
  // Tabs.tsx draws nothing below two. A masjid with no appeals — most masjids, most of the year
  // — would otherwise get a bar with a single lit tab on it, which is a label taking up the most
  // valuable strip of a phone screen.
  const { tabsFor } = await import('./App');
  assert.ok(tabsFor(0).length < 2, 'the bar has nothing to draw');
  assert.ok(tabsFor(1).length >= 2, 'one appeal is enough to be worth a tab');
});

test('the appeals page is a route of its own, and unknown paths still are not', async () => {
  assert.equal(routeOf('/give'), '/give');
  assert.equal(routeOf('/give/'), '/give');
  assert.equal(routeOf('/give/anything'), 'unknown');
  assert.equal(routeOf('/donate'), 'unknown');
});

test('a musalli opening the Donate tab is never landed on the admin panel', async () => {
  // dashboardLanding only ever redirects from the ROOT. Someone who followed a link to /give
  // said where they wanted to go.
  assert.equal(dashboardLanding('/give', true), null);
  assert.equal(dashboardLanding('/', true), '/admin');
});
