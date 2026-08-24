// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The appearance and logo relays, driven through the real server against a real fake platform
 * on a real socket — so the `fetch` in fabric.ts genuinely runs.
 *
 * WHY THESE ARE RELAYED AT ALL is the thing worth remembering: our page is HTTPS behind the
 * tunnel and the platform is plain HTTP on the LAN, so a direct browser fetch is mixed content.
 * It would work in dev, work on the LAN, and be blocked in the one place a musalli ever opens
 * the app — the exact shape of bug that gets shipped.
 *
 * The security case here is the SVG one. We re-serve these bytes from our own origin, and an
 * SVG is a script container.
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

const MODULES = ['./config', './fabric', './site', './cache', './server', './store', './auth', './basePath', './changelog', './rateLimit'];

/** A stand-in OpenMasjidOS core whose answers a test can change mid-flight. */
interface Fake {
  url: string;
  close: () => Promise<void>;
  hits: string[];
  appearance: unknown;
  /** What /api/public/logo does: an image, a 404 (no logo set), or a 500 (core unwell). */
  logo: { status: number; type?: string; body?: Buffer };
  site: unknown;
  alerts: unknown[];
  alertReply: unknown;
}

function startPlatform(): Promise<Fake> {
  const state = {
    appearance: { theme: 'light', wallpaper: 'ocean', accent: 'teal', lang: 'en' } as unknown,
    logo: { status: 404 } as Fake['logo'],
    site: { enabled: true, domain: 'omos.example.org', publicUrl: 'https://omos.example.org/companion', basePath: '/companion' } as unknown,
    alertReply: { delivered: true } as unknown,
  };
  const hits: string[] = [];
  const alerts: unknown[] = [];

  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const url = req.url ?? '';

    if (url === '/api/public/appearance') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state.appearance));
    }
    if (url === '/api/public/logo') {
      const l = state.logo;
      if (l.status !== 200 || !l.body) {
        res.writeHead(l.status, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': l.type ?? 'image/png', 'content-length': String(l.body.length) });
      return res.end(l.body);
    }
    if (url === '/api/fabric/site') {
      if (!req.headers['x-openmasjid-app-secret']) {
        res.writeHead(403, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(state.site));
    }
    if (url === '/api/auth/session') {
      const ok = !!req.headers['x-openmasjid-app-secret'] && /omos_session=/.test(req.headers.cookie ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? { authenticated: true, username: 'Hasan' } : { authenticated: false }));
    }
    if (url === '/api/fabric/alert' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        alerts.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(state.alertReply));
      });
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
        hits,
        alerts,
        get appearance() {
          return state.appearance;
        },
        set appearance(v) {
          state.appearance = v;
        },
        get logo() {
          return state.logo;
        },
        set logo(v) {
          state.logo = v;
        },
        get site() {
          return state.site;
        },
        set site(v) {
          state.site = v;
        },
        get alertReply() {
          return state.alertReply;
        },
        set alertReply(v) {
          state.alertReply = v;
        },
      });
    });
  });
}

interface Scenario {
  app: FastifyInstance;
  platform: Fake;
  cleanup: () => Promise<void>;
}

/** A server wired to a fake platform. `embedded: false` gives a standalone install with no
 *  Fabric at all, which is a legitimate deployment and must not look like a broken one. */
async function scenario(opts: { embedded?: boolean } = {}): Promise<Scenario> {
  const embedded = opts.embedded !== false;
  const platform = await startPlatform();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-relay-'));
  const saved = { ...process.env };

  process.env.OPENMASJID_BASE_URL = embedded ? platform.url : '';
  process.env.OPENMASJID_APP_SECRET = embedded ? 'app-secret' : '';
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

/** Sign in the way the dashboard does, so the admin routes can be exercised while the platform
 *  is present (a local password is refused in that state, by design). */
async function signIn(s: Scenario): Promise<string> {
  const res = await s.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: 'omos_session=whatever' } });
  const cookie = res.cookies.find((c) => c.name === COOKIE);
  assert.ok(cookie, 'SSO should have minted a local session');
  return cookie!.value;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(256, 7)]);

afterEach(() => resetBasePath());

// ── Appearance ────────────────────────────────────────────────────────────────

test('the appearance relay serves what the dashboard says', async () => {
  const s = await scenario();
  try {
    const res = await s.app.inject({ method: 'GET', url: '/api/public/appearance' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json<{ data: unknown }>().data, { theme: 'light', wallpaper: 'ocean', accent: 'teal', lang: 'en' });
  } finally {
    await s.cleanup();
  }
});

test('the appearance relay passes ONLY the keys it understands', async () => {
  // This feeds a page's CSS variables. An allowlist rather than a pass-through means a field
  // added upstream cannot arrive somewhere it was never designed to be rendered.
  const s = await scenario();
  try {
    s.platform.appearance = { theme: 'dark', accent: 'gold', evil: '<script>', session: 'secret-looking', nested: { a: 1 } };
    const data = (await s.app.inject({ method: 'GET', url: '/api/public/appearance' })).json<{ data: Record<string, unknown> }>().data;
    assert.deepEqual(Object.keys(data).sort(), ['accent', 'theme']);
    assert.equal('evil' in data, false);
    assert.equal('session' in data, false);
  } finally {
    await s.cleanup();
  }
});

test('appearance values are length-capped so nothing unbounded reaches a style attribute', async () => {
  const s = await scenario();
  try {
    s.platform.appearance = { accent: 'x'.repeat(500), wallpaperImage: 'y'.repeat(9000) };
    const data = (await s.app.inject({ method: 'GET', url: '/api/public/appearance' })).json<{ data: Record<string, string> }>().data;
    assert.equal(data.accent.length, 64);
    assert.equal(data.wallpaperImage.length, 4096, 'a data: URI is legitimately long, but not unbounded');
  } finally {
    await s.cleanup();
  }
});

test('an unreachable dashboard is a 503, not a 500 and not a lie', async () => {
  const s = await scenario();
  try {
    await s.platform.close(); // the core goes away before we ever cached anything
    const res = await s.app.inject({ method: 'GET', url: '/api/public/appearance' });
    assert.equal(res.statusCode, 503);
    assert.match(res.json<{ error: string }>().error, /not reachable/i);
  } finally {
    await s.cleanup();
  }
});

// ── Logo ──────────────────────────────────────────────────────────────────────

test('the masjid logo is relayed with its own content type', async () => {
  const s = await scenario();
  try {
    s.platform.logo = { status: 200, type: 'image/png', body: PNG };
    const res = await s.app.inject({ method: 'GET', url: '/api/public/logo' });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['content-type'] as string, /^image\/png/);
    assert.equal(res.rawPayload.length, PNG.length);
    assert.ok(res.headers.etag, 'the largest asset on the page needs an ETag');
  } finally {
    await s.cleanup();
  }
});

test('a returning phone gets a 304 rather than the image again', async () => {
  const s = await scenario();
  try {
    s.platform.logo = { status: 200, type: 'image/png', body: PNG };
    const first = await s.app.inject({ method: 'GET', url: '/api/public/logo' });
    const etag = first.headers.etag as string;
    const second = await s.app.inject({ method: 'GET', url: '/api/public/logo', headers: { 'if-none-match': etag } });
    assert.equal(second.statusCode, 304);
    assert.equal(second.rawPayload.length, 0);
  } finally {
    await s.cleanup();
  }
});

test('AN SVG LOGO IS REFUSED — we re-serve these bytes from our own origin', async () => {
  // An <svg> with an onload, fetched from our own path, is same-origin script in the admin's
  // browser. The platform is not hostile, but "the upstream would never" is not a security
  // property, and the entire cost of the rule is a masjid saving their logo as a PNG.
  const s = await scenario();
  try {
    s.platform.logo = { status: 200, type: 'image/svg+xml', body: Buffer.from('<svg onload="alert(1)"/>') };
    const res = await s.app.inject({ method: 'GET', url: '/api/public/logo' });
    assert.equal(res.statusCode, 404, 'refused, and reported as "no logo" — the page has a fallback');
    assert.equal(res.headers['content-type']?.toString().includes('image/svg'), false);
  } finally {
    await s.cleanup();
  }
});

test('an oversized logo is refused rather than held in a Pi’s memory', async () => {
  const s = await scenario();
  try {
    s.platform.logo = { status: 200, type: 'image/png', body: Buffer.alloc(2_000_000, 1) };
    assert.equal((await s.app.inject({ method: 'GET', url: '/api/public/logo' })).statusCode, 404);
  } finally {
    await s.cleanup();
  }
});

test('no logo set is a plain 404 the page is built to handle', async () => {
  const s = await scenario();
  try {
    s.platform.logo = { status: 404 };
    const res = await s.app.inject({ method: 'GET', url: '/api/public/logo' });
    assert.equal(res.statusCode, 404);
    assert.match(res.json<{ error: string }>().error, /has not set a logo/i);
  } finally {
    await s.cleanup();
  }
});

test('"no logo" and "the core is down" are distinguished, or an outage hides the logo for the whole TTL', async () => {
  // Both look like "no image" at the route. They must not look the same to the CACHE: a 404 is
  // a settled answer worth holding for five minutes, while a 500 during a core restart must not
  // pin the fallback mark on every phone for the next five minutes.
  const s = await scenario();
  try {
    // AFTER scenario(), which reloads the module graph under the fake platform's environment.
    // Requiring it earlier would test a fabric.ts that has no base URL configured.
    const { fetchLogo } = require('./fabric') as typeof import('./fabric');
    s.platform.logo = { status: 404 };
    assert.equal(await fetchLogo(), 'none', 'a 404 is a settled answer');
    s.platform.logo = { status: 500 };
    assert.equal(await fetchLogo(), 'unavailable', 'a 5xx is the core having a problem');
    s.platform.logo = { status: 200, type: 'image/svg+xml', body: Buffer.from('<svg/>') };
    assert.equal(await fetchLogo(), 'none', 'a refused type will be refused again — do not retry it');
  } finally {
    await s.cleanup();
  }
});

// ── The admin's view of all this ──────────────────────────────────────────────

test('the status and relay-refresh routes are behind the admin session', async () => {
  const s = await scenario();
  try {
    for (const [method, url] of [
      ['GET', '/api/admin/status'],
      ['POST', '/api/admin/site/refresh'],
      ['POST', '/api/admin/alert/test'],
    ] as const) {
      const res = await s.app.inject({ method, url });
      assert.equal(res.statusCode, 401, `${method} ${url} must require a session`);
    }
  } finally {
    await s.cleanup();
  }
});

test('the admin status reports remote access as the platform describes it', async () => {
  const s = await scenario();
  try {
    const cookie = await signIn(s);
    await s.app.inject({ method: 'POST', url: '/api/admin/site/refresh', cookies: { [COOKIE]: cookie } });
    const remote = (await s.app.inject({ method: 'GET', url: '/api/admin/status', cookies: { [COOKIE]: cookie } })).json<{
      data: { remote: Record<string, unknown> };
    }>().data.remote;

    assert.equal(remote.configured, true);
    assert.equal(remote.enabled, true);
    assert.equal(remote.publicUrl, 'https://omos.example.org/companion');
    assert.equal(remote.basePath, '/companion');
    assert.equal(remote.reachable, true);
  } finally {
    await s.cleanup();
  }
});

test('remote access off is reported as off, and separately from being unreachable', async () => {
  // Two different problems with two different fixes. Telling an admin "turn on Remote access"
  // when the truth is "we could not ask" sends them to change a setting that was already right.
  const s = await scenario();
  try {
    const cookie = await signIn(s);
    s.platform.site = { enabled: false, domain: '', publicUrl: '', basePath: '/companion' };
    const off = (await s.app.inject({ method: 'POST', url: '/api/admin/site/refresh', cookies: { [COOKIE]: cookie } })).json<{
      data: Record<string, unknown>;
    }>().data;
    assert.equal(off.enabled, false);
    assert.equal(off.reachable, true, 'we reached it — it said no');

    await s.platform.close();
    const down = (await s.app.inject({ method: 'POST', url: '/api/admin/site/refresh', cookies: { [COOKIE]: cookie } })).json<{
      data: Record<string, unknown>;
    }>().data;
    assert.equal(down.reachable, false, 'now we could not ask at all');
  } finally {
    await s.cleanup();
  }
});

test('a standalone install is "not configured", which is not a fault to fix', async () => {
  const s = await scenario({ embedded: false });
  try {
    const set = await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'a good long one' } });
    const cookie = set.cookies.find((c) => c.name === COOKIE)!.value;
    const remote = (await s.app.inject({ method: 'GET', url: '/api/admin/status', cookies: { [COOKIE]: cookie } })).json<{
      data: { remote: Record<string, unknown> };
    }>().data.remote;
    assert.equal(remote.configured, false);
    assert.equal(remote.enabled, false);
  } finally {
    await s.cleanup();
  }
});

// ── Alerts ────────────────────────────────────────────────────────────────────

test('the test alert reaches the platform with a DECLARED id', async () => {
  const s = await scenario();
  try {
    const cookie = await signIn(s);
    const res = await s.app.inject({ method: 'POST', url: '/api/admin/alert/test', cookies: { [COOKIE]: cookie } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json<{ data: { result: string } }>().data.result, 'sent');
    assert.deepEqual(s.platform.alerts, [{ id: 'test', message: 'Test alert from OpenMasjid Companion.' }]);
  } finally {
    await s.cleanup();
  }
});

test('"the admin switched this alert off" is a normal answer, not a failure', async () => {
  // We cannot read the admin's routing choice, so the only correct response to being told they
  // do not want this alert is to carry on quietly — not to retry, and not to log a warning about
  // their own preference every time.
  const s = await scenario();
  try {
    const cookie = await signIn(s);
    s.platform.alertReply = { delivered: false, reason: 'disabled_by_admin' };
    const res = await s.app.inject({ method: 'POST', url: '/api/admin/alert/test', cookies: { [COOKIE]: cookie } });
    assert.equal(res.statusCode, 200, 'a 200 — this is not an error');
    assert.equal(res.json<{ data: { result: string } }>().data.result, 'disabled_by_admin');
  } finally {
    await s.cleanup();
  }
});

test('an undeclared alert id is refused by us before it is refused by the platform', async () => {
  // The platform drops an undeclared id silently, so a typo here would mean an alert a masjid
  // was relying on simply never arrives, with nothing anywhere saying why.
  const s = await scenario();
  try {
    const { raiseAlert } = require('./fabric') as typeof import('./fabric');
    const result = await raiseAlert('made-up-id' as never);
    assert.equal(result, 'unavailable');
    assert.deepEqual(s.platform.alerts, [], 'it never left this process');
  } finally {
    await s.cleanup();
  }
});
