// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * What the month view marks, and how that setting reaches a phone.
 *
 * The setting is one boolean, and every interesting thing about it is on the way out:
 *
 *  - It is the MASJID's, not the reader's. A mark says "this masjid changed its jamāʿah on this
 *    day", so it has to be the same on every phone, which is why it travels in the public
 *    timetable payload rather than living in anyone's localStorage.
 *  - **It has to move the ETag.** That payload is cached for a minute and validated with an
 *    ETag, and the service worker holds it longer. An ETag that only covers the days would let
 *    a phone answer 304 with the old setting baked in — a switch that visibly does nothing,
 *    which is the worst kind of settings bug because the admin flips it back and forth and
 *    concludes the app is broken.
 *
 * The rule that decides a change from the times themselves is pure, and is tested where it
 * lives: web/src/prayerTimes.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { COOKIE } from './auth';
import { resetBasePath } from './basePath';

const MODULES = ['./config', './fabric', './site', './cache', './server', './store', './auth', './basePath', './changelog', './rateLimit', './timetable', './timetableService', './icons', './webmanifest', './png'];

async function scenario(): Promise<{ app: FastifyInstance; cleanup: () => Promise<void> }> {
  // Enough of a platform to sign in against. Nothing here asks the broker for times: the
  // setting is about how days are marked, not about what the days are.
  const platform = http.createServer((req, res) => {
    if (req.url === '/api/auth/session') {
      const ok = !!req.headers['x-openmasjid-app-secret'] && /omos_session=/.test(req.headers.cookie ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? { authenticated: true, username: 'Hasan' } : { authenticated: false }));
    }
    if (req.url === '/api/fabric/site') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ enabled: false, domain: '', publicUrl: '', basePath: '' }));
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((r) => platform.listen(0, '127.0.0.1', r));
  const { port } = platform.address() as AddressInfo;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-marks-'));
  const saved = { ...process.env };
  process.env.OPENMASJID_BASE_URL = `http://127.0.0.1:${port}`;
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
    cleanup: async () => {
      await app.close();
      store.close();
      await new Promise<void>((r) => platform.close(() => r()));
      fs.rmSync(dir, { recursive: true, force: true });
      process.env = saved;
      resetBasePath();
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

const marksOf = (app: FastifyInstance) =>
  app.inject({ method: 'GET', url: '/api/public/timetable' }).then((r) => r.json<{ data: { marks: { maghrib: boolean } } }>().data.marks);

test('MAGHRIB IS OFF UNTIL A MASJID SAYS OTHERWISE', async () => {
  // Most masjids hold Maghrib a set few minutes after the adhan, so its printed time moves
  // every single day on its own. On by default would mark every day, which is the same
  // information as marking none.
  const s = await scenario();
  try {
    assert.deepEqual(await marksOf(s.app), { maghrib: false });
  } finally {
    await s.cleanup();
  }
});

test('the setting reaches the public payload, and survives a restart', async () => {
  const s = await scenario();
  try {
    const token = await signIn(s.app);
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/admin/month-marks',
      headers: { cookie: `${COOKIE}=${token}` },
      payload: { maghrib: true },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await marksOf(s.app), { maghrib: true }, 'a musalli’s phone sees the masjid’s choice');

    const off = await s.app.inject({
      method: 'POST',
      url: '/api/admin/month-marks',
      headers: { cookie: `${COOKIE}=${token}` },
      payload: { maghrib: false },
    });
    assert.equal(off.statusCode, 200);
    assert.deepEqual(await marksOf(s.app), { maghrib: false });
  } finally {
    await s.cleanup();
  }
});

test('THE ETAG MOVES WITH THE SETTING, or the switch appears to do nothing', async () => {
  // The failure this prevents: the admin turns Maghrib on, every phone that already has the
  // payload revalidates, gets a 304 because the days did not change, and keeps marking the old
  // days until its cache expires.
  const s = await scenario();
  try {
    const before = await s.app.inject({ method: 'GET', url: '/api/public/timetable' });
    const tag = String(before.headers.etag);
    assert.ok(tag, 'the payload is validated with an ETag');

    const same = await s.app.inject({ method: 'GET', url: '/api/public/timetable', headers: { 'if-none-match': tag } });
    assert.equal(same.statusCode, 304, 'unchanged content still revalidates cheaply');

    const token = await signIn(s.app);
    await s.app.inject({
      method: 'POST',
      url: '/api/admin/month-marks',
      headers: { cookie: `${COOKIE}=${token}` },
      payload: { maghrib: true },
    });

    const after = await s.app.inject({ method: 'GET', url: '/api/public/timetable', headers: { 'if-none-match': tag } });
    assert.equal(after.statusCode, 200, 'the old validator must no longer match');
    assert.notEqual(String(after.headers.etag), tag);
  } finally {
    await s.cleanup();
  }
});

test('a musalli cannot set what every other musalli sees', async () => {
  const s = await scenario();
  try {
    const res = await s.app.inject({ method: 'POST', url: '/api/admin/month-marks', payload: { maghrib: true } });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(await marksOf(s.app), { maghrib: false }, 'and nothing changed');
  } finally {
    await s.cleanup();
  }
});

test('a nonsense body is refused rather than coerced', async () => {
  const s = await scenario();
  try {
    const token = await signIn(s.app);
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/admin/month-marks',
      headers: { cookie: `${COOKIE}=${token}` },
      payload: { maghrib: 'yes' },
    });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(await marksOf(s.app), { maghrib: false });
  } finally {
    await s.cleanup();
  }
});
