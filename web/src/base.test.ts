// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The browser half of the base path.
 *
 * `server/src/basePath.test.ts` proves the server strips the tunnel's prefix before routing.
 * This proves the page puts it back on. Both halves have to be right, and they fail in
 * opposite, equally invisible ways: the server getting it wrong 404s everything behind the
 * tunnel, while the page getting it wrong sends `fetch('/api/app')` to the ROOT of the
 * masjid's domain — out of this app entirely, into whatever OpenMasjidOS serves there.
 *
 * Neither is reproducible on a developer's machine, because on the LAN the base path is '' and
 * every function here is the identity.
 *
 * `BASE` is read once at module load, from a global the server injects into the page. So each
 * scenario re-imports the module under a different global, using a distinct query string —
 * ESM caches by specifier, so that is what gives a fresh copy.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

let scenarioId = 0;

/** Load base.ts as though the page had been served with this `window.__OMOS_BASE__`. */
async function serve(injected: unknown, origin = 'https://omos.example.org') {
  (globalThis as { window?: unknown }).window = { __OMOS_BASE__: injected, location: { origin } };
  return (await import(`./base.ts?scenario=${++scenarioId}`)) as typeof import('./base');
}

test('on the LAN, with no prefix, every function is the identity', async () => {
  // The common developer case, and the one that hides every bug in this file.
  const b = await serve(undefined);
  assert.equal(b.BASE, '');
  assert.equal(b.withBase('/api/app'), '/api/app');
  assert.equal(b.stripBase('/admin'), '/admin');
  assert.equal(b.pageOrigin(), 'https://omos.example.org');
});

test('behind the tunnel, absolute in-app URLs get the prefix put back on', async () => {
  // The one that matters: a root-absolute fetch leaves this app. <base href> does NOT fix it —
  // that only affects RELATIVE URLs.
  const b = await serve('/companion');
  assert.equal(b.BASE, '/companion');
  assert.equal(b.withBase('/api/app'), '/companion/api/app');
  assert.equal(b.withBase('/api/public/logo'), '/companion/api/public/logo');
  assert.equal(b.withBase('/admin'), '/companion/admin');
  assert.equal(b.pageOrigin(), 'https://omos.example.org/companion');
});

test('the router sees the same route whichever address the page was opened at', async () => {
  const b = await serve('/companion');
  assert.equal(b.stripBase('/companion'), '/', 'the bare prefix is the home route');
  assert.equal(b.stripBase('/companion/'), '/');
  assert.equal(b.stripBase('/companion/admin'), '/admin');
  assert.equal(b.stripBase('/companion/week'), '/week');
});

test('a path that merely STARTS with the prefix is left alone', async () => {
  // "/masjid" must not quietly rewrite "/masjidname". The server's stripBasePath has the same
  // rule for the same reason; if the two disagreed, a route would resolve on one side only.
  const b = await serve('/masjid');
  assert.equal(b.stripBase('/masjidname'), '/masjidname');
  assert.equal(b.stripBase('/masjid-other/page'), '/masjid-other/page');
  assert.equal(b.stripBase('/masjid/page'), '/page');
});

test('a prefix the platform sent untidily is normalised, not trusted verbatim', async () => {
  for (const [given, expected] of [
    ['companion', '/companion'],
    ['/companion/', '/companion'],
    ['  /companion  ', '/companion'],
    ['/companion//', '/companion'],
    ['/', ''],
    ['', ''],
  ] as const) {
    const b = await serve(given);
    assert.equal(b.BASE, expected, `"${given}" should normalise to "${expected}"`);
  }
});

test('a relative path is not given a prefix, because it does not need one', async () => {
  // <base href> already resolves these. Prefixing them too would double it.
  const b = await serve('/companion');
  assert.equal(b.withBase('assets/x.js'), 'assets/x.js');
  assert.equal(b.withBase('./x.png'), './x.png');
});

test('a nested prefix works — the admin may put this app anywhere', async () => {
  const b = await serve('/apps/companion');
  assert.equal(b.withBase('/api/app'), '/apps/companion/api/app');
  assert.equal(b.stripBase('/apps/companion/admin'), '/admin');
  assert.equal(b.stripBase('/apps/other/admin'), '/apps/other/admin');
});
