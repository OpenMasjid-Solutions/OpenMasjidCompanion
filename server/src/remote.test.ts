// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Opening the admin panel from OUTSIDE the masjid, through the OpenMasjidOS remote dashboard.
 *
 * What the platform does, and what these requests reproduce: "Open" goes to /_omos/open, which
 * sets `omos_session=<an access token for this app alone>; Path=/companion` and sends the browser
 * to /companion/. Every request after that arrives with the prefix still on, `cf-ray` and
 * `x-forwarded-proto: https`, and the token as the only platform cookie. An app that is NOT shared
 * is served this way too, for the admin alone — and the platform leaves its
 * `OPENMASJID_PUBLIC_URL` empty, so the prefix can only be learned from `GET /api/fabric/site`.
 *
 * Driven through the real server with a fake OpenMasjidOS on a real socket, like session.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';

const BASE = '/companion';
const TOKEN = 'a1.h4ndl3-_x.m4c-_y';
const TUNNEL = { 'cf-ray': '8a1b2c3d4e5f-LHR', 'x-forwarded-proto': 'https', cookie: `omos_session=${TOKEN}` };

const MODULES = ['./config', './fabric', './site', './cache', './server', './store', './auth', './basePath', './changelog', './rateLimit'];

/** A stand-in OpenMasjidOS: remote access on, this app private, the token valid. */
async function startPlatform(): Promise<{ url: string; siteAsks: () => number; seen: string[]; close: () => Promise<void> }> {
  let asks = 0;
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/api/fabric/site') {
      asks++;
      return json({ enabled: true, domain: 'omos.example.org', publicUrl: '', basePath: BASE });
    }
    if (req.url === '/api/auth/session') {
      seen.push(String(req.headers.cookie ?? ''));
      const ok = !!req.headers['x-openmasjid-app-secret'] && req.headers.cookie === `omos_session=${TOKEN}`;
      return json(ok ? { authenticated: true, username: 'Hasan' } : { authenticated: false });
    }
    if (req.url === '/api/public/appearance') return json({ v: 1 });
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    siteAsks: () => asks,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** The server as it is straight after a boot in which the site lookup has not answered yet. */
async function coldServer(platformUrl: string): Promise<{ app: FastifyInstance; cleanup: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-remote-'));
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(path.join(publicDir, 'assets'), { recursive: true });
  fs.writeFileSync(
    path.join(publicDir, 'index.html'),
    '<!doctype html><html><head><title>x</title></head><body><script type="module" src="./assets/app.js"></script></body></html>',
  );
  fs.writeFileSync(path.join(publicDir, 'assets', 'app.js'), 'export {};\n');

  const saved = { ...process.env };
  process.env.OPENMASJID_BASE_URL = platformUrl;
  process.env.OPENMASJID_APP_SECRET = 'test-secret';
  process.env.OPENMASJID_APP_ID = 'companion';
  delete process.env.OPENMASJID_PUBLIC_URL; // a private app: the platform leaves it empty
  for (const m of MODULES) delete require.cache[require.resolve(m)];
  const { Store } = require('./store') as typeof import('./store');
  const { buildServer } = require('./server') as typeof import('./server');
  const store = new Store(path.join(dir, 'data'));
  const app = await buildServer({ store, publicDir });
  await app.ready();
  return {
    app,
    cleanup: async () => {
      await app.close();
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
      process.env = saved;
      for (const m of MODULES) delete require.cache[require.resolve(m)];
    },
  };
}

function setCookie(res: { headers: Record<string, unknown> }): string {
  const h = res.headers['set-cookie'];
  return (Array.isArray(h) ? h : [h]).filter(Boolean).join('\n');
}

test('opened from the remote dashboard before the prefix is known: sent back, then the page knows its prefix', async () => {
  const platform = await startPlatform();
  const { app, cleanup } = await coldServer(platform.url);
  try {
    // Before the fix this came back as the app shell with <base href="/">, so every script
    // loaded from the dashboard's /assets: a white screen until the next 5-minute poll.
    const first = await app.inject({ method: 'GET', url: `${BASE}/?x=1`, headers: TUNNEL });
    assert.equal(first.statusCode, 307);
    assert.equal(first.headers.location, `${BASE}/?x=1`, 'the same address, so the #omos= fragment rides along');

    const page = await app.inject({ method: 'GET', url: `${BASE}/?x=1`, headers: TUNNEL });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /<base href="\/companion\/">/);
    assert.match(page.body, /window\.__OMOS_BASE__="\/companion"/);
    assert.equal((await app.inject({ method: 'GET', url: `${BASE}/assets/app.js`, headers: TUNNEL })).statusCode, 200);
  } finally {
    await cleanup();
    await platform.close();
  }
});

test('the first API call can be the one that finds the prefix too', async () => {
  const platform = await startPlatform();
  const { app, cleanup } = await coldServer(platform.url);
  try {
    const first = await app.inject({ method: 'GET', url: `${BASE}/api/session`, headers: TUNNEL });
    assert.equal(first.statusCode, 307, 'not a JSON 404 the panel would show as "Can’t reach this app"');
    assert.equal(first.headers.location, `${BASE}/api/session`);
  } finally {
    await cleanup();
    await platform.close();
  }
});

test('signed in by SSO from outside with no password, and the whole panel works under the prefix', async () => {
  const platform = await startPlatform();
  const { app, cleanup } = await coldServer(platform.url);
  try {
    await app.inject({ method: 'GET', url: `${BASE}/`, headers: TUNNEL }); // learns the prefix

    const s = await app.inject({ method: 'GET', url: `${BASE}/api/session`, headers: TUNNEL });
    assert.equal(s.statusCode, 200);
    const data = s.json<{ data: { authed: boolean; username?: string } }>().data;
    assert.equal(data.authed, true);
    assert.equal(data.username, 'Hasan');
    assert.ok(platform.seen.includes(`omos_session=${TOKEN}`), 'the access token went to the platform, alone');

    const cookie = setCookie(s);
    assert.match(cookie, /^omc_session=/, 'our own cookie — never one named omos_session');
    assert.match(cookie, /Secure/);
    assert.match(cookie, /HttpOnly/);

    const ours = cookie.split(';')[0];
    for (const url of ['/api/admin/status', '/api/admin/push', '/api/admin/campaigns', '/api/admin/contact']) {
      const r = await app.inject({ method: 'GET', url: BASE + url, headers: { ...TUNNEL, cookie: `omos_session=${TOKEN}; ${ours}` } });
      assert.equal(r.statusCode, 200, url);
    }
  } finally {
    await cleanup();
    await platform.close();
  }
});

test('on the LAN nothing changes: no prefix, no redirect', async () => {
  const platform = await startPlatform();
  const { app, cleanup } = await coldServer(platform.url);
  try {
    await app.inject({ method: 'GET', url: `${BASE}/`, headers: TUNNEL }); // the prefix is known
    const s = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: `omos_session=${TOKEN}` } });
    assert.equal(s.statusCode, 200);
    assert.match(setCookie(s), /Path=\/(;|$)/);
    assert.doesNotMatch(setCookie(s), /Secure/);
    assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 200);
  } finally {
    await cleanup();
    await platform.close();
  }
});

test('a forwarded request the platform does not route here is never redirected, and cannot make us ask again and again', async () => {
  const platform = await startPlatform();
  const { app, cleanup } = await coldServer(platform.url);
  try {
    for (let i = 0; i < 20; i++) {
      const r = await app.inject({ method: 'GET', url: '/elsewhere/x', headers: TUNNEL });
      assert.notEqual(r.statusCode, 307);
    }
    assert.equal(platform.siteAsks(), 1, 'once per 10 s at most, however many requests');
  } finally {
    await cleanup();
    await platform.close();
  }
});
