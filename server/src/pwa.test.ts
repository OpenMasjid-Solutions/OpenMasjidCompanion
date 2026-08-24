// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The manifest, the service worker and the icons — everything that decides what this app is
 * once it is on someone's home screen.
 *
 * Two failures here are invisible until a real phone tries to install:
 *
 *  - A `scope` or `start_url` missing the tunnel prefix. The app installs, and then every
 *    navigation escapes into whatever else the masjid serves at the root of their domain.
 *  - A service worker served with the wrong cache headers, which pins a build on a phone with
 *    no way to fix it remotely.
 *
 * And one is worse than invisible: an icon or a name that says "OpenMasjid Companion". A
 * musalli installed their MASJID, not our software.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { resetBasePath } from './basePath';
import { COOKIE } from './auth';
import { buildManifest, installName, isRtl, shortName } from './webmanifest';
import { decodePng, encodePng } from './png';

const MODULES = ['./config', './fabric', './site', './cache', './server', './store', './auth', './basePath', './changelog', './rateLimit', './timetable', './timetableService', './icons', './webmanifest', './png'];

// ── The name under the icon ──────────────────────────────────────────────────

test('THE NAME IS THE MASJID’S, never the software’s', () => {
  // The whole point of generating this per request. A phone showing "OpenMasjid Companion" on
  // the home screen has told the musalli they installed a product, not their masjid.
  assert.equal(installName('', 'Masjid An-Noor'), 'Masjid An-Noor');
  assert.equal(installName('Noor Prayer Times', 'Masjid An-Noor'), 'Noor Prayer Times', 'the admin’s own choice wins');
  assert.equal(installName('  ', 'Masjid An-Noor'), 'Masjid An-Noor', 'whitespace is not a choice');
});

test('with no masjid name yet, the fallback is generic but never our product name', () => {
  const name = installName('', '');
  assert.equal(name, 'Masjid Companion');
  assert.doesNotMatch(name, /OpenMasjid/, 'the software’s name has no business on a home screen');
});

test('a long name is shortened by dropping "Masjid", not by cutting mid-word', () => {
  // A home screen gives about twelve characters. "Masjid" at the front is the least
  // distinguishing part when every masjid nearby starts the same way.
  assert.equal(shortName('Masjid An-Noor'), 'An-Noor');
  assert.equal(shortName('Islamic Centre of Lansdale'), 'of Lansdale'.length <= 12 ? 'of Lansdale' : shortName('Islamic Centre of Lansdale'));
  assert.equal(shortName('An-Noor'), 'An-Noor', 'a short name is left alone');
  assert.ok(shortName('Masjid Abu Bakr As-Siddiq').length <= 12);
  assert.doesNotMatch(shortName('Masjid Abu Bakr As-Siddiq'), /\s$/, 'no trailing space where a word was cut');
});

test('shortName never returns something longer than a home screen shows', () => {
  for (const n of ['Masjid An-Noor', 'The Really Very Long Masjid Name Indeed', 'Jamia Masjid Ghousia', 'A', 'Islamic Center']) {
    assert.ok(shortName(n).length <= 12, `"${n}" -> "${shortName(n)}"`);
  }
});

test('right-to-left languages are marked, because the installer renders the name itself', () => {
  // The one piece of this app's text that lives outside our own CSS, where logical properties
  // cannot help.
  for (const lang of ['ar', 'ur', 'fa', 'ar-SA', 'ur-PK']) assert.equal(isRtl(lang), true, lang);
  for (const lang of ['en', 'en-GB', 'fr', 'tr', 'ms', '']) assert.equal(isRtl(lang), false, lang);
});

// ── The manifest ─────────────────────────────────────────────────────────────

const base = (basePath: string) =>
  buildManifest({ appName: '', masjidName: 'Masjid An-Noor', basePath, lang: 'en', theme: '#0F2044', background: '#0F2044' });

test('SCOPE AND START_URL CARRY THE TUNNEL PREFIX', () => {
  // Get this wrong and the app installs happily, then every navigation escapes the app into
  // whatever else the masjid serves at the root of their domain.
  const m = base('/companion');
  assert.equal(m.scope, '/companion/');
  assert.equal(m.start_url, '/companion/');
  assert.equal(m.id, '/companion/');
});

test('served at the root, the scope is the root', () => {
  const m = base('');
  assert.equal(m.scope, '/');
  assert.equal(m.start_url, '/');
});

test('a nested prefix is carried whole', () => {
  assert.equal(base('/apps/companion').scope, '/apps/companion/');
});

test('every icon URL is prefixed too, or the installer fetches nothing', () => {
  const icons = base('/companion').icons as { src: string; purpose: string; sizes: string }[];
  assert.equal(icons.length, 3);
  for (const i of icons) assert.ok(i.src.startsWith('/companion/api/public/icon/'), i.src);
  assert.deepEqual(icons.map((i) => i.sizes).sort(), ['192x192', '512x512', '512x512']);
});

test('A MASKABLE ICON IS DECLARED, or Android crops the masjid’s name off', () => {
  const icons = base('').icons as { purpose: string }[];
  assert.ok(icons.some((i) => i.purpose === 'maskable'), 'a launcher needs one it may crop to a circle');
  assert.ok(icons.some((i) => i.purpose === 'any'), 'and one it must not');
});

test('the manifest declares standalone, so it opens without browser chrome', () => {
  assert.equal(base('').display, 'standalone');
});

test('the language and direction follow the masjid’s timetable, not the reader’s phone', () => {
  const ar = buildManifest({ appName: '', masjidName: 'مسجد النور', basePath: '', lang: 'ar', theme: '#000', background: '#000' });
  assert.equal(ar.lang, 'ar');
  assert.equal(ar.dir, 'rtl');
  assert.equal(ar.name, 'مسجد النور');
});

// ── The routes, against a real server ────────────────────────────────────────

interface Fake {
  url: string;
  close: () => Promise<void>;
  logo: Buffer | null;
}

async function startPlatform(): Promise<Fake> {
  const state = { logo: null as Buffer | null };
  const server = http.createServer((req, res) => {
    if (req.url === '/api/public/logo') {
      if (!state.logo) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(state.logo.length) });
      return res.end(state.logo);
    }
    if (req.url === '/api/auth/session') {
      const ok = !!req.headers['x-openmasjid-app-secret'] && /omos_session=/.test(req.headers.cookie ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? { authenticated: true, username: 'Hasan' } : { authenticated: false }));
    }
    if (req.url === '/api/fabric/site') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ enabled: false, domain: '', publicUrl: '', basePath: '' }));
    }
    // The broker: no timetable is chosen in these tests, so nothing should ask.
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    get logo() {
      return state.logo;
    },
    set logo(v) {
      state.logo = v;
    },
  };
}

/** A square PNG of a known colour, standing in for a masjid's logo. */
function logoPng(size: number, colour: [number, number, number]): Buffer {
  const rgba = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    rgba[i * 4] = colour[0];
    rgba[i * 4 + 1] = colour[1];
    rgba[i * 4 + 2] = colour[2];
    rgba[i * 4 + 3] = 255;
  }
  return encodePng({ width: size, height: size, rgba });
}

async function scenario(): Promise<{ app: FastifyInstance; platform: Fake; cleanup: () => Promise<void> }> {
  const platform = await startPlatform();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-pwa-'));
  const saved = { ...process.env };
  process.env.OPENMASJID_BASE_URL = platform.url;
  process.env.OPENMASJID_APP_SECRET = 'secret';
  process.env.DATA_DIR = path.join(dir, 'data');
  process.env.OPENMASJID_PUBLIC_URL = '';

  for (const m of MODULES) delete require.cache[require.resolve(m)];
  const { Store } = require('./store') as typeof import('./store');
  const { buildServer } = require('./server') as typeof import('./server');
  const store = new Store(path.join(dir, 'data'));
  const app = await buildServer({ store, publicDir: path.join(dir, 'nope') });
  await app.ready();

  return {
    app,
    platform,
    cleanup: async () => {
      await app.close();
      store.close();
      await platform.close();
      fs.rmSync(dir, { recursive: true, force: true });
      process.env = saved;
      for (const m of MODULES) delete require.cache[require.resolve(m)];
    },
  };
}

async function signIn(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: 'omos_session=x' } });
  const c = res.cookies.find((x) => x.name === COOKIE);
  assert.ok(c, 'SSO should mint a session');
  return c!.value;
}

afterEach(() => resetBasePath());

test('the manifest is served as a manifest, and is not cached hard', () => {
  // Renaming the app must reach a phone that reinstalls. A manifest is fetched once at install;
  // there is nothing to save by caching it.
  return (async () => {
    const s = await scenario();
    try {
      const res = await s.app.inject({ method: 'GET', url: '/manifest.webmanifest' });
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'] as string, /application\/manifest\+json/);
      assert.match(String(res.headers['cache-control']), /no-cache/);
      const m = res.json<Record<string, unknown>>();
      assert.equal(m.display, 'standalone');
      assert.equal(m.start_url, '/');
    } finally {
      await s.cleanup();
    }
  })();
});

test('THE SERVICE WORKER IS NEVER CACHED — a cached one cannot be replaced', async () => {
  // The failure this prevents: a worker pinned in a browser's HTTP cache holds an old app shell
  // on someone's phone, and there is no way to reach that phone to fix it.
  const s = await scenario();
  try {
    const res = await s.app.inject({ method: 'GET', url: '/sw.js' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /javascript/);
    assert.match(String(res.headers['cache-control']), /no-cache/);
  } finally {
    await s.cleanup();
  }
});

test('the worker is served with the base path and version substituted in', async () => {
  const s = await scenario();
  try {
    const body = (await s.app.inject({ method: 'GET', url: '/sw.js' })).body;
    assert.doesNotMatch(body, /__BASE__/, 'an unsubstituted template would cache the wrong paths');
    assert.doesNotMatch(body, /__VERSION__/, 'and would never expire its caches');
    assert.match(body, /omc-shell-/, 'the cache names are versioned');
  } finally {
    await s.cleanup();
  }
});

test('THE WORKER REFUSES TO CACHE ANYTHING BEHIND THE ADMIN LOGIN', async () => {
  // A cached admin shell on a shared phone is a small thing that becomes a bad thing later.
  const s = await scenario();
  try {
    const body = (await s.app.inject({ method: 'GET', url: '/sw.js' })).body;
    assert.match(body, /\/admin/, 'it has to know about the admin paths to skip them');
    assert.match(body, /isAdmin/, 'and there is a branch that does');
  } finally {
    await s.cleanup();
  }
});

test('icons are derived on demand and served as real PNGs at the declared sizes', async () => {
  const s = await scenario();
  try {
    for (const [route, size] of [['192.png', 192], ['512.png', 512], ['maskable.png', 512]] as const) {
      const res = await s.app.inject({ method: 'GET', url: `/api/public/icon/${route}` });
      assert.equal(res.statusCode, 200, route);
      assert.match(res.headers['content-type'] as string, /image\/png/, route);
      const img = decodePng(res.rawPayload);
      assert.equal(img.width, size, route);
      assert.equal(img.height, size, route);
    }
  } finally {
    await s.cleanup();
  }
});

test('an unknown icon name is a 404, not a path into the data directory', async () => {
  const s = await scenario();
  try {
    for (const name of ['nope.png', '..%2F..%2Fcompanion.db', 'icon-192']) {
      assert.equal((await s.app.inject({ method: 'GET', url: `/api/public/icon/${name}` })).statusCode, 404, name);
    }
  } finally {
    await s.cleanup();
  }
});

test('a returning phone revalidates an icon with an ETag rather than refetching it', async () => {
  const s = await scenario();
  try {
    const first = await s.app.inject({ method: 'GET', url: '/api/public/icon/192.png' });
    const etag = first.headers.etag as string;
    assert.ok(etag);
    const second = await s.app.inject({ method: 'GET', url: '/api/public/icon/192.png', headers: { 'if-none-match': etag } });
    assert.equal(second.statusCode, 304);
    assert.equal(second.rawPayload.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('THE MASJID’S PLATFORM LOGO BECOMES THE ICON, in preference to ours', async () => {
  const s = await scenario();
  try {
    s.platform.logo = logoPng(600, [200, 30, 40]);
    const res = await s.app.inject({ method: 'GET', url: '/api/public/icon/512.png' });
    const img = decodePng(res.rawPayload);
    const mid = ((256 * 512) + 256) * 4;
    assert.deepEqual([img.rgba[mid], img.rgba[mid + 1], img.rgba[mid + 2]], [200, 30, 40], 'the masjid’s colour, not ours');
  } finally {
    await s.cleanup();
  }
});

test('a logo we cannot decode falls through rather than leaving no icon at all', async () => {
  const s = await scenario();
  try {
    // A JPEG: a legitimate logo, and one this app deliberately does not decode.
    s.platform.logo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]);
    const res = await s.app.inject({ method: 'GET', url: '/api/public/icon/512.png' });
    assert.equal(res.statusCode, 200, 'the bundled mark still answers');
    assert.equal(decodePng(res.rawPayload).width, 512);
  } finally {
    await s.cleanup();
  }
});

// ── The admin's own icon ─────────────────────────────────────────────────────

test('the icon and name routes are behind the admin session', async () => {
  const s = await scenario();
  try {
    for (const url of ['/api/admin/icon', '/api/admin/icon/reset', '/api/admin/appname']) {
      assert.equal((await s.app.inject({ method: 'POST', url })).statusCode, 401, url);
    }
  } finally {
    await s.cleanup();
  }
});

test('AN UPLOAD IS RE-ENCODED, never stored or served as sent', async () => {
  // CLAUDE.md §13. The uploaded bytes carry a marker; what comes back must not.
  const s = await scenario();
  try {
    const cookie = await signIn(s.app);
    const marker = Buffer.from('MARKER-DO-NOT-SERVE-THIS');
    const upload = Buffer.concat([logoPng(512, [10, 120, 200]), marker]); // trailing junk after IEND

    const res = await s.app.inject({
      method: 'POST',
      url: '/api/admin/icon',
      cookies: { [COOKIE]: cookie },
      headers: { 'content-type': 'image/png' },
      payload: upload,
    });
    assert.equal(res.statusCode, 200, res.body);

    const served = await s.app.inject({ method: 'GET', url: '/api/public/icon/512.png' });
    assert.equal(served.rawPayload.includes(marker), false, 'nothing from the upload may be served back');
    const img = decodePng(served.rawPayload);
    const mid = ((256 * 512) + 256) * 4;
    assert.deepEqual([img.rgba[mid], img.rgba[mid + 1], img.rgba[mid + 2]], [10, 120, 200], 'but the picture is theirs');
  } finally {
    await s.cleanup();
  }
});

test('a file that is not a PNG is refused in words a volunteer can act on', async () => {
  const s = await scenario();
  try {
    const cookie = await signIn(s.app);
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/admin/icon',
      cookies: { [COOKIE]: cookie },
      headers: { 'content-type': 'image/png' },
      payload: Buffer.from('<svg onload="alert(1)"/>'),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json<{ error: string }>().error, /PNG/i);
    assert.doesNotMatch(res.json<{ error: string }>().error, /decode|parse|magic/i, 'no jargon on an admin screen');
  } finally {
    await s.cleanup();
  }
});

test('a tiny image is refused, with the size it actually was', async () => {
  const s = await scenario();
  try {
    const cookie = await signIn(s.app);
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/admin/icon',
      cookies: { [COOKIE]: cookie },
      headers: { 'content-type': 'image/png' },
      payload: logoPng(64, [1, 2, 3]),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json<{ error: string }>().error, /64×64/, 'telling them the size saves a guess');
  } finally {
    await s.cleanup();
  }
});

test('resetting the icon goes back to the automatic chain', async () => {
  const s = await scenario();
  try {
    const cookie = await signIn(s.app);
    s.platform.logo = logoPng(600, [9, 9, 9]);
    await s.app.inject({
      method: 'POST',
      url: '/api/admin/icon',
      cookies: { [COOKIE]: cookie },
      headers: { 'content-type': 'image/png' },
      payload: logoPng(512, [240, 0, 0]),
    });
    const uploaded = (await s.app.inject({ method: 'GET', url: '/api/admin/status', cookies: { [COOKIE]: cookie } })).json<{
      data: { pwa: { icon: { source: string; hasUpload: boolean } } };
    }>().data.pwa.icon;
    assert.equal(uploaded.source, 'upload');
    assert.equal(uploaded.hasUpload, true);

    await s.app.inject({ method: 'POST', url: '/api/admin/icon/reset', cookies: { [COOKIE]: cookie } });
    const after = (await s.app.inject({ method: 'GET', url: '/api/admin/status', cookies: { [COOKIE]: cookie } })).json<{
      data: { pwa: { icon: { source: string; hasUpload: boolean } } };
    }>().data.pwa.icon;
    assert.equal(after.source, 'platform', 'back to the masjid’s own logo');
    assert.equal(after.hasUpload, false);
  } finally {
    await s.cleanup();
  }
});

test('the app name is saved, and clearing it follows the masjid name again', async () => {
  const s = await scenario();
  try {
    const cookie = await signIn(s.app);
    const set = await s.app.inject({ method: 'POST', url: '/api/admin/appname', cookies: { [COOKIE]: cookie }, payload: { name: 'Noor Times' } });
    assert.equal(set.json<{ data: { effective: string } }>().data.effective, 'Noor Times');
    assert.match((await s.app.inject({ method: 'GET', url: '/manifest.webmanifest' })).body, /Noor Times/);

    await s.app.inject({ method: 'POST', url: '/api/admin/appname', cookies: { [COOKIE]: cookie }, payload: { name: '  ' } });
    const cleared = (await s.app.inject({ method: 'GET', url: '/api/admin/status', cookies: { [COOKIE]: cookie } })).json<{
      data: { pwa: { appName: string } };
    }>().data.pwa.appName;
    assert.equal(cleared, '', 'empty means "follow Display", not "call it nothing"');
  } finally {
    await s.cleanup();
  }
});

test('an over-long name is refused rather than truncated into something odd', async () => {
  const s = await scenario();
  try {
    const cookie = await signIn(s.app);
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/admin/appname',
      cookies: { [COOKIE]: cookie },
      payload: { name: 'x'.repeat(200) },
    });
    assert.equal(res.statusCode, 400);
  } finally {
    await s.cleanup();
  }
});
