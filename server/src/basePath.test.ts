// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The app is reachable at two addresses at once and both have to work, so every case
 * here is written as a pair: the LAN form (no prefix) and the tunnelled form (the full
 * prefix, unstripped, exactly as Cloudflare and the OS front door deliver it).
 *
 * Getting this wrong does not look like a bug on the developer's machine — the LAN form
 * is the one you test locally, and it keeps working perfectly while every phone that
 * scanned the QR code gets a blank page.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { getBasePath, injectBase, normBasePath, resetBasePath, setBasePath, stripBasePath, withBase } from './basePath';

test('normBasePath: the two spellings of "served at the root" both mean nothing to strip', () => {
  // '/' is the dangerous one. Left as-is it would match the start of every URL in the
  // app, and stripping it would take the leading slash off every request.
  assert.equal(normBasePath(''), '');
  assert.equal(normBasePath('/'), '');
  assert.equal(normBasePath('   '), '');
  assert.equal(normBasePath(undefined), '');
  assert.equal(normBasePath(null), '');
  assert.equal(normBasePath(42), '');
});

test('normBasePath: normalises whatever shape the platform sends', () => {
  assert.equal(normBasePath('/companion'), '/companion');
  assert.equal(normBasePath('companion'), '/companion', 'a missing leading slash is added');
  assert.equal(normBasePath('/companion/'), '/companion', 'a trailing slash is dropped');
  assert.equal(normBasePath('/companion///'), '/companion');
  assert.equal(normBasePath('  /prayer-times  '), '/prayer-times', 'trimmed');
  assert.equal(normBasePath('/a/b'), '/a/b', 'a multi-segment path is legal');
});

test('stripBasePath: the LAN form is never touched', () => {
  // No prefix configured: this is a standalone install, or the box being reached
  // directly on the network. Every URL must pass through byte-for-byte.
  for (const u of ['/', '/api/app', '/healthz', '/week', '/assets/index-abc123.js', '/?x=1']) {
    assert.equal(stripBasePath(u, ''), u);
  }
});

test('stripBasePath: the tunnelled form has exactly one prefix removed', () => {
  const base = '/companion';
  assert.equal(stripBasePath('/companion/api/app', base), '/api/app');
  assert.equal(stripBasePath('/companion/healthz', base), '/healthz');
  assert.equal(stripBasePath('/companion/assets/index-abc123.js', base), '/assets/index-abc123.js');
  assert.equal(stripBasePath('/companion/sw.js', base), '/sw.js');
  assert.equal(stripBasePath('/companion/', base), '/');
  assert.equal(stripBasePath('/companion', base), '/', 'the app front page itself');
  assert.equal(stripBasePath('/companion?from=qr', base), '/?from=qr', 'front page with a query');
  assert.equal(stripBasePath('/companion#x', base), '/#x');
});

test('stripBasePath: BOTH forms are live at once — an unprefixed request still works with a prefix set', () => {
  // This is not a hypothetical. The tunnel delivers the prefix; the platform's own LAN
  // proxy and a kiosk on the network do not. The same process serves both, so a request
  // that simply lacks the prefix must fall through untouched rather than 404.
  const base = '/companion';
  assert.equal(stripBasePath('/api/app', base), '/api/app');
  assert.equal(stripBasePath('/healthz', base), '/healthz');
  assert.equal(stripBasePath('/', base), '/');
});

test('stripBasePath: a path that merely STARTS with the prefix is left alone', () => {
  // The reason the check is `base + '/'` and not `startsWith(base)`. A masjid that named
  // its path /masjid must still be able to have a route called /masjidname.
  assert.equal(stripBasePath('/masjidname/x', '/masjid'), '/masjidname/x');
  assert.equal(stripBasePath('/companionship', '/companion'), '/companionship');
  assert.equal(stripBasePath('/companion-old/api', '/companion'), '/companion-old/api');
});

test('stripBasePath: a doubled prefix loses exactly one level', () => {
  // /companion/companion/x is a request for the route "/companion/x" on this app — which
  // is a real possibility once the app has its own nested paths. Stripping greedily would
  // silently rewrite it into something else.
  assert.equal(stripBasePath('/companion/companion/x', '/companion'), '/companion/x');
});

test('stripBasePath: prefixes are case-sensitive, like every other URL path', () => {
  assert.equal(stripBasePath('/Companion/api/app', '/companion'), '/Companion/api/app');
});

test('stripBasePath: a multi-segment admin-chosen path works the same way', () => {
  assert.equal(stripBasePath('/apps/companion/api/app', '/apps/companion'), '/api/app');
  assert.equal(stripBasePath('/apps/companion', '/apps/companion'), '/');
  assert.equal(stripBasePath('/apps/other/api', '/apps/companion'), '/apps/other/api');
});

test('stripBasePath: an empty target is treated as the root', () => {
  assert.equal(stripBasePath('', ''), '/');
  assert.equal(stripBasePath('', '/companion'), '/');
});

test('withBase: server-emitted absolute paths carry the prefix', () => {
  // These are the URLs the SERVER writes for the BROWSER to resolve — the web manifest's
  // start_url and scope, the service worker's registration path, the icon routes. A
  // start_url without the prefix installs a PWA that opens on somebody else's app.
  assert.equal(withBase('/companion', '/'), '/companion/');
  assert.equal(withBase('/companion', '/sw.js'), '/companion/sw.js');
  assert.equal(withBase('', '/sw.js'), '/sw.js');
  assert.equal(withBase('/companion', 'relative/thing'), 'relative/thing', 'only absolute paths are prefixed');
});

test('injectBase: the page carries the prefix twice, because the browser needs it twice', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8" /></head><body></body></html>';
  const out = injectBase(html, '/companion');
  // <base href> is what makes Vite's relative "./assets/…" resolve under the prefix.
  assert.match(out, /<base href="\/companion\/">/);
  // __OMOS_BASE__ is what the app's own code reads. <base href> cannot do this job:
  // it does not affect fetch('/api/app'), which is root-absolute.
  assert.match(out, /window\.__OMOS_BASE__="\/companion"/);
  assert.ok(out.indexOf('<base') > out.indexOf('<head>'), 'injected inside <head>, not before it');
  assert.ok(out.includes('<meta charset="utf-8" />'), 'the original head survives');
});

test('injectBase: at the root it still emits a valid, harmless base', () => {
  const out = injectBase('<html><head></head><body></body></html>', '');
  assert.match(out, /<base href="\/">/);
  assert.match(out, /window\.__OMOS_BASE__=""/);
});

test('injectBase: a hostile base path cannot break out of the attribute', () => {
  // The base path arrives from the platform over the network and lands in an HTML
  // attribute on every page this app serves. Restricting the charset is stronger than
  // escaping it, because there is nothing legitimate outside it.
  const out = injectBase('<html><head></head></html>', '/x"><script>alert(1)</script>');
  assert.ok(!out.includes('<script>alert(1)</script>'), 'no injected element');
  assert.match(out, /<base href="\/xscriptalert1\/script\/">/);
  assert.equal((out.match(/<script>/g) ?? []).length, 1, 'only our own __OMOS_BASE__ script tag');
});

test('injectBase: tolerates a <head> with attributes, and a document without one', () => {
  const withAttrs = injectBase('<html><head data-x="1"><title>t</title></head></html>', '/c');
  assert.match(withAttrs, /<head data-x="1">\s*\n\s*<base href="\/c\/">/);
  const none = '<html><body>no head here</body></html>';
  assert.equal(injectBase(none, '/c'), none, 'left alone rather than mangled');
});

test('the base path holder round-trips through the same normalisation as everything else', () => {
  resetBasePath();
  assert.equal(getBasePath(), '', 'defaults to the root, which is what a standalone install stays on');
  setBasePath('companion/');
  assert.equal(getBasePath(), '/companion');
  setBasePath('/');
  assert.equal(getBasePath(), '', 'remote access turned off puts us back at the root');
  resetBasePath();
});
