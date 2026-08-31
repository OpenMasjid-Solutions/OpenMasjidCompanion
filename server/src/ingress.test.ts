// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The real ingress test: build the actual server and drive it with real requests, in
 * both of the shapes it is reached in.
 *
 * basePath.test.ts proves the arithmetic. This proves the arithmetic is WIRED — that
 * `rewriteUrl` is on the Fastify instance, that it runs before routing, that the static
 * plugin and the SPA fallback sit behind it too, and that the page the browser gets back
 * carries the prefix it needs to fetch anything else.
 *
 * Every assertion is written as a pair. A change that breaks the tunnelled form while
 * leaving the LAN form perfect is the failure this app is most exposed to, because the
 * LAN form is the one a developer sees.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { Store } from './store';
import { buildServer } from './server';
import { resetBasePath, setBasePath } from './basePath';

const BASE = '/companion';

/** A stand-in for what Vite builds: a `<head>`, a relative asset reference of the shape
 *  Vite emits, and one real asset file so the static plugin has something to serve. */
const INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" /><title>Companion</title></head>
<body><div id="root"></div><script type="module" src="./assets/app.js"></script></body></html>`;

let dir = '';
let publicDir = '';
let store: Store;
let app: FastifyInstance;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-ingress-'));
  publicDir = path.join(dir, 'public');
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(publicDir, 'assets', 'app.js'), 'export const ok = 1;\n');
  store = new Store(path.join(dir, 'data'));
  app = await buildServer({ store, publicDir });
  await app.ready();
});

after(async () => {
  resetBasePath();
  await app?.close();
  store?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('LAN form: the app answers at the root with no prefix configured', async () => {
  resetBasePath();
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  const api = await app.inject({ method: 'GET', url: '/api/app' });
  assert.equal(api.statusCode, 200);
  assert.equal(api.json<{ data: { basePath: string } }>().data.basePath, '');
  const page = await app.inject({ method: 'GET', url: '/' });
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /<base href="\/">/);
  assert.match(page.body, /window\.__OMOS_BASE__=""/);
  assert.equal((await app.inject({ method: 'GET', url: '/assets/app.js' })).statusCode, 200);
});

test('tunnelled form: the same server answers with the full prefix still on the front', async () => {
  // This is the request line Cloudflare + the OS front door actually deliver. Nothing
  // strips the prefix before us, which is the whole reason rewriteUrl exists.
  setBasePath(BASE);
  assert.equal((await app.inject({ method: 'GET', url: `${BASE}/healthz` })).statusCode, 200);

  const api = await app.inject({ method: 'GET', url: `${BASE}/api/app` });
  assert.equal(api.statusCode, 200);
  assert.equal(api.json<{ data: { basePath: string } }>().data.basePath, BASE, 'the page is told where it is');

  assert.equal((await app.inject({ method: 'GET', url: `${BASE}/assets/app.js` })).statusCode, 200, 'static assets resolve under the prefix');
});

test('tunnelled form: the page comes back knowing its own prefix', async () => {
  setBasePath(BASE);
  for (const url of [`${BASE}/`, BASE, `${BASE}?from=qr`]) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    assert.match(res.headers['content-type'] as string, /text\/html/);
    // Both halves, because the browser needs both: <base href> for Vite's relative
    // asset URLs, __OMOS_BASE__ for the root-absolute fetches the app makes itself.
    assert.match(res.body, /<base href="\/companion\/">/, url);
    assert.match(res.body, /window\.__OMOS_BASE__="\/companion"/, url);
  }
});

test('both forms at once: an unprefixed request still works while a prefix is configured', async () => {
  // The platform's LAN proxy and a kiosk on the network reach the same process without
  // the prefix, at the same time as phones reach it with one. Both must work.
  setBasePath(BASE);
  assert.equal((await app.inject({ method: 'GET', url: '/healthz' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/app' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 200);
});

test('SPA routes resolve to the shell in both forms', async () => {
  resetBasePath();
  for (const url of ['/week', '/month', '/give', '/admin']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `LAN ${url}`);
    assert.match(res.headers['content-type'] as string, /text\/html/);
  }
  setBasePath(BASE);
  for (const url of ['/week', '/month', '/give', '/admin']) {
    const res = await app.inject({ method: 'GET', url: BASE + url });
    assert.equal(res.statusCode, 200, `tunnelled ${url}`);
    assert.match(res.body, /window\.__OMOS_BASE__="\/companion"/);
  }
});

test('a missing FILE 404s instead of being handed the app shell', async () => {
  // A stale /assets/x.js answered with HTML is a syntax error the browser reports
  // somewhere far away from the cause. Anything with an extension must fail honestly.
  resetBasePath();
  const lan = await app.inject({ method: 'GET', url: '/assets/gone-abc123.js' });
  assert.equal(lan.statusCode, 404);
  assert.doesNotMatch(lan.body, /<!doctype html>/i);

  setBasePath(BASE);
  const tun = await app.inject({ method: 'GET', url: `${BASE}/assets/gone-abc123.js` });
  assert.equal(tun.statusCode, 404);
  assert.doesNotMatch(tun.body, /<!doctype html>/i);
});

test('an unknown API route answers JSON, never the app shell', async () => {
  resetBasePath();
  const lan = await app.inject({ method: 'GET', url: '/api/nope' });
  assert.equal(lan.statusCode, 404);
  assert.deepEqual(lan.json(), { error: 'Not found.' });

  setBasePath(BASE);
  const tun = await app.inject({ method: 'GET', url: `${BASE}/api/nope` });
  assert.equal(tun.statusCode, 404);
  assert.deepEqual(tun.json(), { error: 'Not found.' });
});

test('a path that only looks like the prefix is not rewritten', async () => {
  // A masjid whose path is /companion must still be able to reach a route the app really
  // does own at /companionship — greedy stripping would rewrite it into something else.
  setBasePath(BASE);
  const res = await app.inject({ method: 'GET', url: '/companionship' });
  assert.equal(res.statusCode, 200, 'falls through to the SPA shell as an ordinary route');
});

test('the baseline security headers are on every response, static included', async () => {
  resetBasePath();
  for (const url of ['/healthz', '/api/app', '/', '/assets/app.js']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.headers['x-content-type-options'], 'nosniff', url);
    assert.equal(res.headers['referrer-policy'], 'no-referrer', url);
  }
});

test('/healthz is a plain ok, with no configuration or secret in it', async () => {
  resetBasePath();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.deepEqual(res.json(), { ok: true });
});

test('/api/app carries nothing secret', async () => {
  resetBasePath();
  const body = (await app.inject({ method: 'GET', url: '/api/app' })).body;
  // The bootstrap is fetched by every phone that opens the app. Anything the platform
  // injected as a credential must be nowhere near it.
  assert.doesNotMatch(body, /secret/i);
  assert.doesNotMatch(body, /OPENMASJID_APP_SECRET/);
  const data = JSON.parse(body).data as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(data).sort(),
    ['basePath', 'contact', 'embedded', 'installName', 'name', 'publicUrl', 'remote', 'version'],
    'the public bootstrap is an explicit, reviewed list — a new key here reaches every musalli',
  );
  // `remote` decides whether the page offers to be installed and to send notifications. It is
  // three booleans about this app's own address; nothing in it is about a person.
  assert.deepEqual(Object.keys(data.remote as object).sort(), ['configured', 'enabled', 'secure']);
  /**
   * `contact` is the masjid's own PUBLIC information — the phone number and links it would print
   * on a poster — and it is here rather than behind a route of its own because every page
   * already fetches this and a second request for ten short strings would be a second thing to
   * be slow on a bad connection.
   *
   * Its shape is pinned for the same reason the outer list is. This is the one thing in the
   * bootstrap that an admin can type freely into, so a field appearing here that was not
   * intended to be public would be a field a masjid entered for their own reference and found
   * on every phone in the congregation.
   */
  assert.deepEqual(
    Object.keys(data.contact as object).sort(),
    ['address', 'email', 'facebook', 'instagram', 'phone', 'telegram', 'website', 'whatsapp', 'x', 'youtube'],
    'every contact field is meant to be read by strangers — check that before adding one',
  );
});
