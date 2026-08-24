// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The admin-auth slice, driven through the real server with a FAKE OpenMasjidOS on a real
 * socket — so the `fetch` in fabric.ts actually runs, including its timeout and
 * `redirect: 'error'` posture.
 *
 * The behaviour under test is the one that has bricked sibling apps: the difference between
 * "you are not signed in" and "OpenMasjidOS is unreachable". Those need different screens and
 * different offers, and `/api/setup` opens or closes on exactly that distinction. A mock that
 * stubbed `probePlatform` would assert the routes agree with a stub; this asserts they agree
 * with a platform.
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

/** A stand-in OpenMasjidOS core. `mode` decides what it says about the session cookie. */
interface FakePlatform {
  url: string;
  close: () => Promise<void>;
  /** Requests it received, so a test can assert what we did and did NOT send. */
  seen: { url: string; cookie?: string; secret?: string }[];
  mode: 'signed-in' | 'signed-out';
  username: string;
}

async function startPlatform(mode: FakePlatform['mode'] = 'signed-in'): Promise<FakePlatform> {
  const state = { mode, username: 'Hasan' };
  const seen: FakePlatform['seen'] = [];
  const server = http.createServer((req, res) => {
    seen.push({
      url: req.url ?? '',
      cookie: req.headers.cookie as string | undefined,
      secret: req.headers['x-openmasjid-app-secret'] as string | undefined,
    });
    if (req.url === '/api/public/appearance') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ v: 1, theme: 'dark', wallpaper: 'aurora', accent: 'cyan' }));
    }
    if (req.url === '/api/auth/session') {
      // The platform is identity-bound: without our app secret it fails CLOSED.
      if (!req.headers['x-openmasjid-app-secret']) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ authenticated: false }));
      }
      const signedIn = state.mode === 'signed-in' && /omos_session=/.test(req.headers.cookie ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(signedIn ? { authenticated: true, username: state.username } : { authenticated: false }));
    }
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    seen,
    get mode() {
      return state.mode;
    },
    set mode(m: FakePlatform['mode']) {
      state.mode = m;
    },
    get username() {
      return state.username;
    },
    set username(u: string) {
      state.username = u;
    },
  };
}

/** Build a server with the environment a given scenario needs. config.ts reads env ONCE at
 *  import, so the module cache is dropped per scenario — which is also a faithful reproduction
 *  of how the real process picks these up: at start, never later. */
async function scenario(env: Record<string, string | undefined>): Promise<{
  app: FastifyInstance;
  store: import('./store').Store;
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-session-'));
  const saved = { ...process.env };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const m of ['./config', './fabric', './server', './store', './auth', './basePath', './changelog', './rateLimit']) {
    delete require.cache[require.resolve(m)];
  }
  const { Store: S } = require('./store') as typeof import('./store');
  const { buildServer: build } = require('./server') as typeof import('./server');
  const store = new S(path.join(dir, 'data'));
  const app = await build({ store, publicDir: path.join(dir, 'nope') });
  await app.ready();
  return {
    app,
    store,
    dir,
    cleanup: async () => {
      await app.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      process.env = saved;
      for (const m of ['./config', './fabric', './server', './store', './auth', './basePath', './changelog', './rateLimit']) {
        delete require.cache[require.resolve(m)];
      }
    },
  };
}

afterEach(() => resetBasePath());

// ── Standalone: no Fabric at all ──────────────────────────────────────────────

test('standalone: the panel asks for a password to be set, and setting one signs you in', async () => {
  const s = await scenario({ OPENMASJID_BASE_URL: '', OPENMASJID_APP_SECRET: '' });
  try {
    const before = (await s.app.inject({ method: 'GET', url: '/api/session' })).json<{ data: Record<string, unknown> }>().data;
    assert.equal(before.authed, false);
    assert.equal(before.needsSetup, true, 'no platform and no password → choose one');
    assert.deepEqual(before.sso, { enabled: false, reachable: true });

    const set = await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'a good long one' } });
    assert.equal(set.statusCode, 200);
    const cookie = set.cookies.find((c) => c.name === COOKIE);
    assert.ok(cookie, 'setup mints a session');
    assert.equal(cookie!.httpOnly, true);
    assert.equal(cookie!.path, '/');

    const after = (await s.app.inject({ method: 'GET', url: '/api/session', cookies: { [COOKIE]: cookie!.value } })).json<{ data: Record<string, unknown> }>().data;
    assert.equal(after.authed, true);
    assert.equal(after.hasPassword, true);
    assert.equal(after.needsSetup, false);
  } finally {
    await s.cleanup();
  }
});

test('standalone: setup can only be run once', async () => {
  const s = await scenario({ OPENMASJID_BASE_URL: '', OPENMASJID_APP_SECRET: '' });
  try {
    await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'first password' } });
    const again = await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'second password' } });
    assert.equal(again.statusCode, 409, 'a passer-by must not be able to replace the admin password');
  } finally {
    await s.cleanup();
  }
});

test('standalone: a short password is refused', async () => {
  const s = await scenario({ OPENMASJID_BASE_URL: '', OPENMASJID_APP_SECRET: '' });
  try {
    const res = await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'short' } });
    assert.equal(res.statusCode, 400);
    assert.match(res.json<{ error: string }>().error, /8 characters/);
  } finally {
    await s.cleanup();
  }
});

test('login: right password in, wrong password out, and backoff after repeated failures', async () => {
  const s = await scenario({ OPENMASJID_BASE_URL: '', OPENMASJID_APP_SECRET: '' });
  try {
    await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'the real password' } });
    const good = await s.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'the real password' } });
    assert.equal(good.statusCode, 200);
    assert.ok(good.cookies.find((c) => c.name === COOKIE));

    const bad = await s.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } });
    assert.equal(bad.statusCode, 401);
    assert.equal(bad.json<{ error: string }>().error, 'Incorrect password.');

    // Enough failures to trip the limiter. inject() has no real socket address, so every
    // attempt shares one key — which is exactly the "same attacker" case.
    let last = bad;
    for (let i = 0; i < 8; i++) last = await s.app.inject({ method: 'POST', url: '/api/login', payload: { password: 'nope' } });
    assert.equal(last.statusCode, 429, 'brute force is throttled');
    assert.match(last.json<{ error: string }>().error, /Try again in/);
  } finally {
    await s.cleanup();
  }
});

// ── Under OpenMasjidOS ────────────────────────────────────────────────────────

test('SSO: pressing Open in the dashboard signs the admin straight in', async () => {
  const platform = await startPlatform('signed-in');
  const s = await scenario({ OPENMASJID_BASE_URL: platform.url, OPENMASJID_APP_SECRET: 'app-secret-123' });
  try {
    const res = await s.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: 'omos_session=platform-token-abc' } });
    const data = res.json<{ data: Record<string, unknown> }>().data;
    assert.equal(data.authed, true, 'the platform said yes');
    assert.equal(data.username, 'Hasan');
    assert.deepEqual(data.sso, { enabled: true, reachable: true });

    const cookie = res.cookies.find((c) => c.name === COOKIE);
    assert.ok(cookie, 'a local session is minted from the platform answer');
    // An SSO session is CAPPED SHORT — the platform's yes is a snapshot.
    assert.ok(cookie!.maxAge! <= 3600, `SSO session should be ~1h, got ${cookie!.maxAge}s`);

    // We presented our identity, and forwarded the cookie unchanged.
    const call = platform.seen.find((r) => r.url === '/api/auth/session');
    assert.ok(call, 'the platform was actually asked');
    assert.equal(call!.secret, 'app-secret-123', 'identity-bound: our own secret is presented');
    assert.equal(call!.cookie, 'omos_session=platform-token-abc');
  } finally {
    await s.cleanup();
    await platform.close();
  }
});

test('SSO: a visitor with no platform cookie is simply not signed in — and the platform is still reachable', async () => {
  const platform = await startPlatform('signed-in');
  const s = await scenario({ OPENMASJID_BASE_URL: platform.url, OPENMASJID_APP_SECRET: 'app-secret-123' });
  try {
    const data = (await s.app.inject({ method: 'GET', url: '/api/session' })).json<{ data: Record<string, unknown> }>().data;
    assert.equal(data.authed, false);
    assert.deepEqual(data.sso, { enabled: true, reachable: true }, 'reachable, just not signed in — "press Open in your dashboard"');
  } finally {
    await s.cleanup();
    await platform.close();
  }
});

test('THE GUARD: while the platform is reachable, an anonymous local-admin claim is refused', async () => {
  // The window this closes: `hasAdmin()` is false for the entire life of a normal SSO install,
  // so without this anyone who can reach the box on the LAN — or over the tunnel — could claim
  // the admin password before the real admin ever thinks to.
  const platform = await startPlatform('signed-out');
  const s = await scenario({ OPENMASJID_BASE_URL: platform.url, OPENMASJID_APP_SECRET: 'app-secret-123' });
  try {
    const res = await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'passer-by password' } });
    assert.equal(res.statusCode, 403);
    assert.match(res.json<{ error: string }>().error, /OpenMasjidOS dashboard/);
    assert.equal(s.store.hasAdmin(), false, 'nothing was written');
  } finally {
    await s.cleanup();
    await platform.close();
  }
});

test('THE RECOVERY: when the platform is UNREACHABLE, setup is allowed again', async () => {
  // The mirror of the guard, and the reason reachability is reported separately from identity.
  // A masjid restoring a backup onto a new box, or whose core is down, must not be locked out
  // of their own app. Pointed at a port with nothing on it — a real connection failure.
  const s = await scenario({ OPENMASJID_BASE_URL: 'http://127.0.0.1:1', OPENMASJID_APP_SECRET: 'app-secret-123' });
  try {
    const session = (await s.app.inject({ method: 'GET', url: '/api/session' })).json<{ data: { sso: Record<string, unknown> } }>().data;
    assert.deepEqual(session.sso, { enabled: true, reachable: false }, 'the panel must offer the local password, not a dead loop');

    const res = await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'recovery password' } });
    assert.equal(res.statusCode, 200, 'recovery must work exactly when the front door does not');
    assert.equal(s.store.hasAdmin(), true);
  } finally {
    await s.cleanup();
  }
});

test('the guard is about REACHABILITY, not about being signed in', async () => {
  // A signed-OUT visitor at a reachable platform is refused (above). This asserts the same
  // route allows recovery the moment the platform stops answering — same install, same
  // absence of a session, different network.
  const platform = await startPlatform('signed-out');
  const s = await scenario({ OPENMASJID_BASE_URL: platform.url, OPENMASJID_APP_SECRET: 'app-secret-123' });
  try {
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'x'.repeat(10) } })).statusCode, 403);
    await platform.close();
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'x'.repeat(10) } })).statusCode, 200);
  } finally {
    await s.cleanup();
  }
});

// ── Protected routes ──────────────────────────────────────────────────────────

test('an admin-only route refuses an anonymous request', async () => {
  const s = await scenario({ OPENMASJID_BASE_URL: '', OPENMASJID_APP_SECRET: '' });
  try {
    const res = await s.app.inject({ method: 'GET', url: '/api/changelog' });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(res.json(), { error: 'Please sign in.' });
  } finally {
    await s.cleanup();
  }
});

test('an admin-only route refuses a FORGED cookie', async () => {
  const s = await scenario({ OPENMASJID_BASE_URL: '', OPENMASJID_APP_SECRET: '' });
  try {
    const forged = Buffer.from(JSON.stringify({ exp: Date.now() + 1e9, aud: 'admin' })).toString('base64url');
    for (const value of ['garbage', `${forged}.`, `${forged}.aaaa`]) {
      assert.equal((await s.app.inject({ method: 'GET', url: '/api/changelog', cookies: { [COOKIE]: value } })).statusCode, 401, value);
    }
  } finally {
    await s.cleanup();
  }
});

test('What\'s new is served to a signed-in admin, parsed from the shipped changelog', async () => {
  const s = await scenario({ OPENMASJID_BASE_URL: '', OPENMASJID_APP_SECRET: '' });
  try {
    const set = await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'a good long one' } });
    const cookie = set.cookies.find((c) => c.name === COOKIE)!.value;
    const res = await s.app.inject({ method: 'GET', url: '/api/changelog', cookies: { [COOKIE]: cookie } });
    assert.equal(res.statusCode, 200);
    const { version, releases } = res.json<{ data: { version: string; releases: { version: string; items: string[] }[] } }>().data;
    assert.ok(version, 'the build says which version it is');
    assert.ok(releases.length > 0, 'the real CHANGELOG.md parsed to at least one section');
    assert.ok(releases[0].items.length > 0);
    assert.equal(res.headers['cache-control'], undefined, 'not an /admin path — the no-store hook is scoped to those');
  } finally {
    await s.cleanup();
  }
});

test('logging out clears the cookie', async () => {
  const s = await scenario({ OPENMASJID_BASE_URL: '', OPENMASJID_APP_SECRET: '' });
  try {
    const set = await s.app.inject({ method: 'POST', url: '/api/setup', payload: { password: 'a good long one' } });
    const cookie = set.cookies.find((c) => c.name === COOKIE)!.value;
    const out = await s.app.inject({ method: 'POST', url: '/api/logout', cookies: { [COOKIE]: cookie } });
    assert.equal(out.statusCode, 200);
    const cleared = out.cookies.find((c) => c.name === COOKIE);
    assert.ok(cleared && cleared.value === '', 'the cookie is expired on the way out');
  } finally {
    await s.cleanup();
  }
});

test('the admin panel is never cached', async () => {
  const s = await scenario({ OPENMASJID_BASE_URL: '', OPENMASJID_APP_SECRET: '' });
  try {
    const res = await s.app.inject({ method: 'GET', url: '/admin' });
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally {
    await s.cleanup();
  }
});

test('SSO auth works identically behind the tunnel prefix', async () => {
  // Every auth route has to work in both URL shapes, like everything else in this app.
  const platform = await startPlatform('signed-in');
  const s = await scenario({ OPENMASJID_BASE_URL: platform.url, OPENMASJID_APP_SECRET: 'app-secret-123' });
  try {
    const { setBasePath } = require('./basePath') as typeof import('./basePath');
    setBasePath('/companion');
    const res = await s.app.inject({ method: 'GET', url: '/companion/api/session', headers: { cookie: 'omos_session=platform-token-abc' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json<{ data: { authed: boolean } }>().data.authed, true);
    const cookie = res.cookies.find((c) => c.name === COOKIE);
    assert.equal(cookie!.path, '/', 'the cookie is scoped to the origin, not the prefix — the same browser may also reach us on the LAN');
  } finally {
    await s.cleanup();
    await platform.close();
  }
});
