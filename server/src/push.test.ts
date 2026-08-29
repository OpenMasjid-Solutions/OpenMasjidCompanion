// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Prayer notifications: when they fire, when they must not, and what is remembered.
 *
 * Two of these are non-negotiable (CLAUDE.md §14) and both have the same shape of failure —
 * silent, and acted upon:
 *
 *  - **Timezone / DST.** A reminder computed with a hand-rolled offset is an hour wrong for
 *    half the year. Nobody reports it as a bug; they just arrive late, once.
 *  - **Pruning.** A dead endpoint retried for ever inflates the only number the admin is
 *    shown and wastes a request per tick per dead phone.
 *
 * And one that protects a person rather than a system: **nothing is sent from stale times.**
 * A confident "Maghrib in 10 minutes" from two-day-old data is worse than silence, because
 * somebody leaves the house on it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store';
import { MAX_SUBSCRIPTIONS, type Prefs, type Vapid, PRAYERS, safeEndpoint, sendOne, Subscriptions, vapidKeys } from './push';
import { GRACE_MS, PushScheduler, STALE_LIMIT_MS, dueFor, notificationFor } from './pushScheduler';
import { formatTimeIn, isHhmm, tzOffsetMs, zonedTimeToEpoch } from './zoned';
import type { TimetableFeed } from './timetable';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { COOKIE } from './auth';
import { resetBasePath } from './basePath';
import https from 'node:https';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const NY = 'America/New_York';

// ── Wall clock → instant ─────────────────────────────────────────────────────

test('THE OFFSET IS A PROPERTY OF THE INSTANT, not of the zone', () => {
  // New York is −5 in January and −4 in July. A fixed offset is wrong for half the year, and
  // the whole scheduler is built on this one function being right.
  assert.equal(tzOffsetMs(Date.parse('2026-01-15T12:00:00Z'), NY), -5 * 3600_000);
  assert.equal(tzOffsetMs(Date.parse('2026-07-15T12:00:00Z'), NY), -4 * 3600_000);
});

test('a wall-clock time resolves to the right instant on both sides of a DST change', () => {
  // US spring forward 2026: 2am → 3am on Sunday 8 March.
  assert.equal(zonedTimeToEpoch('2026-03-07', '05:30', NY), Date.parse('2026-03-07T10:30:00Z'), 'EST, −5');
  assert.equal(zonedTimeToEpoch('2026-03-09', '05:30', NY), Date.parse('2026-03-09T09:30:00Z'), 'EDT, −4');
  // Autumn back: 2am → 1am on Sunday 1 November.
  assert.equal(zonedTimeToEpoch('2026-10-31', '05:30', NY), Date.parse('2026-10-31T09:30:00Z'), 'EDT');
  assert.equal(zonedTimeToEpoch('2026-11-02', '05:30', NY), Date.parse('2026-11-02T10:30:00Z'), 'EST');
});

test('A TIME INSIDE THE SPRING-FORWARD GAP still yields a real instant', () => {
  // 02:30 on 8 March 2026 never happens in New York — the clock goes 01:59 → 03:00. There is
  // no right answer, and this documents the one we get rather than asserting a convention we
  // do not implement: the instant an hour earlier, 01:30 EST.
  //
  // It cannot arise from Display, which computes in the masjid's own zone and so can only emit
  // times its wall clock actually showed. What must hold is that the result is a REAL instant
  // near the asked-for time — not NaN, not a day out — so nothing downstream schedules wildly.
  const at = zonedTimeToEpoch('2026-03-08', '02:30', NY);
  assert.ok(Number.isFinite(at));
  assert.equal(at, Date.parse('2026-03-08T06:30:00Z'));
  const reads = new Intl.DateTimeFormat('en-US', { timeZone: NY, hour12: false, hour: '2-digit', minute: '2-digit' }).format(at);
  assert.equal(reads, '01:30', 'an hour before, not the hour after');

  // The times either side of the gap, which DO exist, are exact — that is the property the
  // scheduler actually rests on.
  assert.equal(zonedTimeToEpoch('2026-03-08', '01:30', NY), Date.parse('2026-03-08T06:30:00Z'));
  assert.equal(zonedTimeToEpoch('2026-03-08', '03:30', NY), Date.parse('2026-03-08T07:30:00Z'));
});

test('a half-hour zone is handled like any other', () => {
  // Kolkata is +5:30. A whole-hours assumption anywhere would show up here.
  assert.equal(zonedTimeToEpoch('2026-08-24', '05:15', 'Asia/Kolkata'), Date.parse('2026-08-23T23:45:00Z'));
});

test('a malformed time is refused rather than treated as midnight', () => {
  // `Number('')` is 0, so an unchecked blank would schedule a notification for 00:00.
  for (const bad of ['', '5:30', '25:00', '12:60', 'abc', null, undefined, 12]) {
    assert.equal(isHhmm(bad), false, `${String(bad)} is not a time`);
  }
  assert.equal(isHhmm('05:30'), true);
  assert.equal(isHhmm('23:59'), true);
});

test('the time in a notification is the MASJID’s, in the masjid’s own format', () => {
  // A musalli reading from another country still needs the time on the wall in the building.
  assert.match(formatTimeIn('2026-08-24', '19:42', NY, '12', 'en'), /7:42/);
  assert.match(formatTimeIn('2026-08-24', '19:42', NY, '24', 'en'), /19:42/);
});

// ── What is due ──────────────────────────────────────────────────────────────

const day = (date: string) => ({
  date,
  hijri: { label: '1 Muḥarram 1448' },
  sunrise: '06:21',
  prayers: {
    fajr: { adhan: '05:01', iqamah: '05:30' },
    dhuhr: { adhan: '13:05', iqamah: '13:30' },
    asr: { adhan: '17:48', iqamah: '18:00' },
    maghrib: { adhan: '19:45', iqamah: '19:50' },
    isha: { adhan: '21:05', iqamah: '21:30' },
  },
  jumuah: [],
});

const feed = (over: Partial<TimetableFeed> = {}): TimetableFeed =>
  ({
    id: 'tt_main',
    name: 'Main hall',
    masjidName: 'Masjid An-Noor',
    timezone: NY,
    language: 'en',
    hourCycle: '12',
    days: [day('2026-03-07'), day('2026-03-08'), day('2026-03-09'), day('2026-08-23'), day('2026-08-24')],
    ...over,
  }) as TimetableFeed;

const prefs = (over: Partial<Prefs> = {}): Prefs => ({ prayers: [...PRAYERS], adhan: false, beforeIqamah: 15, ...over });

test('a reminder fires the right number of minutes before the jamāʿah', () => {
  const f = feed();
  // Maghrib jamā'ah 19:50 on 24 Aug, EDT (−4) → 23:50Z. Fifteen minutes before is 23:35Z.
  const at = Date.parse('2026-08-24T23:35:00Z');
  const due = dueFor(f, prefs({ prayers: ['maghrib'] }), at - 1000, at);
  assert.equal(due.length, 1);
  assert.equal(due[0].prayer, 'maghrib');
  assert.equal(due[0].kind, 'iqamah');
  assert.equal(due[0].at, at);
});

test('THE LEAD TIME IS CORRECT ACROSS A DST CHANGE, which a fixed offset would not be', () => {
  const f = feed();
  // Fajr jamā'ah 05:30. On 7 March that is EST (−5) → 10:30Z; on 9 March EDT (−4) → 09:30Z.
  // Fifteen minutes before is 10:15Z and 09:15Z respectively.
  for (const [date, iso] of [
    ['2026-03-07', '2026-03-07T10:15:00Z'],
    ['2026-03-09', '2026-03-09T09:15:00Z'],
  ] as const) {
    const at = Date.parse(iso);
    const due = dueFor(f, prefs({ prayers: ['fajr'] }), at - 1000, at);
    assert.equal(due.length, 1, `${date} should have one reminder due`);
    assert.equal(due[0].date, date);
  }
});

test('at-the-adhan and before-the-jamāʿah are separate choices', () => {
  const f = feed();
  const adhanAt = Date.parse('2026-08-24T23:45:00Z'); // 19:45 EDT
  const both = prefs({ prayers: ['maghrib'], adhan: true, beforeIqamah: 15 });

  assert.equal(dueFor(f, both, adhanAt - 1000, adhanAt).length, 1, 'the adhan alone');
  assert.equal(dueFor(f, prefs({ prayers: ['maghrib'], adhan: false }), adhanAt - 1000, adhanAt).length, 0);

  // Across the whole evening, both fire, and the two are distinguishable.
  const evening = dueFor(f, both, Date.parse('2026-08-24T20:00:00Z'), Date.parse('2026-08-25T02:00:00Z'));
  assert.deepEqual(
    evening.map((d) => d.kind),
    ['iqamah', 'adhan'],
    'the 15-minutes-before comes first, then the adhan five minutes later',
  );
});

test('NOTHING IS DUE FOR A PRAYER THAT WAS NOT CHOSEN', () => {
  const f = feed();
  const at = Date.parse('2026-08-24T23:35:00Z');
  assert.equal(dueFor(f, prefs({ prayers: ['fajr'] }), at - 1000, at).length, 0);
  assert.equal(dueFor(f, prefs({ prayers: [] }), at - 60 * 60_000, at).length, 0, 'an empty list is a valid "none"');
});

test('a day Display never sent is never extrapolated', () => {
  // The rule this app exists under: it may not invent a prayer time. A gap in the feed is a
  // gap in the reminders, not a guess.
  const f = feed({ days: [day('2026-08-24')] });
  const at = Date.parse('2026-08-26T23:35:00Z');
  assert.equal(dueFor(f, prefs(), at - 60 * 60_000, at).length, 0);
});

test('a window that has already been covered yields nothing — the same tick twice is idempotent', () => {
  const f = feed();
  const at = Date.parse('2026-08-24T23:35:00Z');
  const first = dueFor(f, prefs({ prayers: ['maghrib'] }), at - 60_000, at);
  assert.equal(first.length, 1);
  assert.equal(dueFor(f, prefs({ prayers: ['maghrib'] }), at, at).length, 0, 'nothing new since');
});

test('the words on the phone name the prayer, the time and the masjid, and nothing else', () => {
  const f = feed();
  const due = { at: 0, prayer: 'maghrib' as const, date: '2026-08-24', kind: 'iqamah' as const, hhmm: '19:50' };
  const n = notificationFor(due, f, 15, 'https://omos.example.org/companion');
  assert.match(n.title, /Maghrib/);
  assert.match(n.title, /Masjid An-Noor/);
  assert.match(n.body, /15 minutes/);
  assert.match(n.body, /7:50/, 'the masjid’s wall clock, in the masjid’s hour cycle');
  assert.equal(n.tag, '2026-08-24:maghrib:iqamah', 'one tag per prayer per day, so a redelivery replaces');
});

test('an adhan notification says adhan, and a zero lead does not say "in 0 minutes"', () => {
  const f = feed();
  const base = { at: 0, prayer: 'fajr' as const, date: '2026-08-24', kind: 'adhan' as const, hhmm: '05:01' };
  assert.match(notificationFor(base, f, 15, '').body, /Adhan/);
  const atJamaah = notificationFor({ ...base, kind: 'iqamah', hhmm: '05:30' }, f, 0, '');
  assert.doesNotMatch(atJamaah.body, /0 minutes/);
  assert.match(atJamaah.body, /Jamāʿah/);
});

// ── Privacy ──────────────────────────────────────────────────────────────────

test('AN ENDPOINT NEVER APPEARS IN A LOG IN FULL', () => {
  // It is a pseudo-identifier. The host says which push service is failing, which is the only
  // operationally useful part; the hash lets two lines be recognised as the same phone.
  const endpoint = 'https://fcm.googleapis.com/fcm/send/dR4nD0m-t0k3n-that-identifies-one-person';
  const safe = safeEndpoint(endpoint);
  assert.doesNotMatch(safe, /dR4nD0m/);
  assert.match(safe, /^fcm\.googleapis\.com#[0-9a-f]{8}$/);
  assert.equal(safeEndpoint(endpoint), safe, 'stable, so two log lines can be correlated');
  assert.notEqual(safeEndpoint(endpoint + 'x'), safe);
});

// ── The store ────────────────────────────────────────────────────────────────

function tempStore(): { store: Store; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-push-'));
  const store = new Store(path.join(dir, 'data'));
  return { store, cleanup: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

const sub = (endpoint: string, p: Partial<Prefs> = {}) => ({
  subscription: { endpoint, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) } },
  prefs: prefs(p),
});

test('re-subscribing the same phone updates it rather than duplicating it', () => {
  const s = tempStore();
  try {
    const subs = new Subscriptions(s.store);
    subs.put(sub('https://push.example/a'));
    subs.put(sub('https://push.example/a', { prayers: ['fajr'] }));
    assert.equal(subs.count(), 1, 'one phone, one row');
    assert.deepEqual(subs.prefsFor('https://push.example/a')?.prayers, ['fajr'], 'the newer choice wins');
  } finally {
    s.cleanup();
  }
});

test('a new subscription is never sent a backlog of what it "missed"', () => {
  // `sent_through` starts at now. Otherwise someone subscribing at 21:00 would immediately be
  // told about Fajr, Dhuhr, Asr and Maghrib.
  const s = tempStore();
  try {
    const subs = new Subscriptions(s.store);
    const now = Date.parse('2026-08-24T23:00:00Z');
    subs.put(sub('https://push.example/a'), now);
    assert.equal(subs.all()[0].sentThrough, now);
  } finally {
    s.cleanup();
  }
});

test('the VAPID keypair is generated once and then kept', () => {
  // Regenerating it silently invalidates every subscription in the masjid — every phone goes
  // quiet with nothing on any screen to explain it.
  const s = tempStore();
  try {
    const first = vapidKeys(s.store);
    assert.ok(first.publicKey.length > 20 && first.privateKey.length > 20);
    assert.deepEqual(vapidKeys(s.store), first, 'the same keys on the next boot');
  } finally {
    s.cleanup();
  }
});

test('the subscription table has a ceiling, and refusing is reported rather than silent', () => {
  const s = tempStore();
  try {
    const subs = new Subscriptions(s.store);
    // Fill it directly; putting five thousand through the API would be a slow way to test one
    // comparison.
    const insert = s.store.db.prepare(
      `INSERT INTO push_subs (endpoint, p256dh, auth, prefs, created_at, sent_through) VALUES (?, 'p', 'a', '{}', 0, 0)`,
    );
    const many = s.store.db.transaction(() => {
      for (let i = 0; i < MAX_SUBSCRIPTIONS; i += 1) insert.run(`https://push.example/${i}`);
    });
    many();
    assert.deepEqual(subs.put(sub('https://push.example/one-too-many')), { ok: false, reason: 'full' });
    // An EXISTING one still updates: a musalli already signed up must be able to change their
    // mind even when the masjid is at its ceiling.
    assert.deepEqual(subs.put(sub('https://push.example/1')), { ok: true });
  } finally {
    s.cleanup();
  }
});

test('a row whose preferences no longer parse is skipped, not thrown away', () => {
  // A build that renamed a field should go quiet for that phone, not delete somebody's
  // subscription on upgrade.
  const s = tempStore();
  try {
    const subs = new Subscriptions(s.store);
    subs.put(sub('https://push.example/good'));
    s.store.db
      .prepare(`INSERT INTO push_subs (endpoint, p256dh, auth, prefs, created_at, sent_through) VALUES (?, 'p', 'a', '{"nope":1}', 0, 0)`)
      .run('https://push.example/odd');
    assert.equal(subs.all().length, 1, 'only the readable one is scheduled');
    assert.equal(subs.count(), 2, 'but the row is still there');
  } finally {
    s.cleanup();
  }
});

// ── The scheduler ────────────────────────────────────────────────────────────

interface Sent { endpoint: string; tag: string }

function scenario(opts: { at?: number; outcome?: (endpoint: string) => 'sent' | 'gone' | 'failed' } = {}) {
  const s = tempStore();
  const subs = new Subscriptions(s.store);
  const sent: Sent[] = [];
  const vapid: Vapid = { publicKey: 'pub', privateKey: 'priv' };
  const scheduler = new PushScheduler(
    subs,
    vapid,
    () => ({ feed: feed(), at: opts.at ?? Date.parse('2026-08-24T22:00:00Z') }),
    () => 'https://omos.example.org/companion',
    async (_v, row, payload) => {
      const outcome = opts.outcome ? opts.outcome(row.endpoint) : 'sent';
      if (outcome === 'sent') sent.push({ endpoint: row.endpoint, tag: payload.tag });
      return outcome;
    },
    async () => undefined, // no jitter in a test
  );
  return { ...s, subs, scheduler, sent };
}

test('a tick sends what is due and nothing else', async () => {
  const s = scenario();
  try {
    const now = Date.parse('2026-08-24T23:35:00Z'); // 15 min before the Maghrib jamā'ah
    s.subs.put(sub('https://push.example/a', { prayers: ['maghrib'] }), now - 60_000);
    const r = await s.scheduler.tick(now);
    assert.equal(r.sent, 1);
    assert.equal(s.sent[0].tag, '2026-08-24:maghrib:iqamah');

    // The same tick again sends nothing: sent_through has moved past it.
    assert.equal((await s.scheduler.tick(now)).sent, 0);
  } finally {
    s.cleanup();
  }
});

test('NOTHING IS SENT FROM STALE TIMES', async () => {
  // The one refusal here that protects a person rather than a system. A confident "Maghrib in
  // 10 minutes" from two-day-old times is worse than silence — somebody leaves the house.
  const now = Date.parse('2026-08-24T23:35:00Z');
  const s = scenario({ at: now - STALE_LIMIT_MS - 60_000 });
  try {
    s.subs.put(sub('https://push.example/a', { prayers: ['maghrib'] }), now - 60_000);
    const r = await s.scheduler.tick(now);
    assert.equal(r.skipped, 'stale');
    assert.equal(r.sent, 0);
    assert.equal(s.sent.length, 0);
  } finally {
    s.cleanup();
  }
});

test('a container that was off for hours does not deliver a backlog when it returns', async () => {
  // A reminder about a prayer that has been and gone is misinformation, not a courtesy.
  const s = scenario();
  try {
    const now = Date.parse('2026-08-25T02:00:00Z');
    // Subscribed this morning; the box has been off since.
    s.subs.put(sub('https://push.example/a'), Date.parse('2026-08-24T10:00:00Z'));
    const r = await s.scheduler.tick(now);
    assert.equal(r.sent, 0, 'everything older than the grace window is dropped, not queued');
  } finally {
    s.cleanup();
  }
});

test('something due within the grace window is still sent', async () => {
  // The other side of the same rule: a tick that ran a minute late must not silently skip.
  const s = scenario();
  try {
    const at = Date.parse('2026-08-24T23:35:00Z');
    const now = at + GRACE_MS - 30_000;
    s.subs.put(sub('https://push.example/a', { prayers: ['maghrib'] }), at - 60 * 60_000);
    assert.equal((await s.scheduler.tick(now)).sent, 1);
  } finally {
    s.cleanup();
  }
});

test('A DEAD SUBSCRIPTION IS PRUNED IMMEDIATELY', async () => {
  // 404/410 means the phone is gone. Retrying it for ever wastes a request per tick and
  // inflates the only number the admin is shown.
  const s = scenario({ outcome: (e) => (e.endsWith('/dead') ? 'gone' : 'sent') });
  try {
    const now = Date.parse('2026-08-24T23:35:00Z');
    s.subs.put(sub('https://push.example/dead', { prayers: ['maghrib'] }), now - 60_000);
    s.subs.put(sub('https://push.example/live', { prayers: ['maghrib'] }), now - 60_000);
    const r = await s.scheduler.tick(now);
    assert.equal(r.pruned, 1);
    assert.equal(r.sent, 1);
    assert.equal(s.subs.count(), 1, 'only the live one is left');
    assert.equal(s.subs.all()[0].endpoint, 'https://push.example/live');
  } finally {
    s.cleanup();
  }
});

test('a transient failure keeps the subscription', async () => {
  // A push service having a bad ten minutes must not empty a masjid's subscriber list.
  const s = scenario({ outcome: () => 'failed' });
  try {
    const now = Date.parse('2026-08-24T23:35:00Z');
    s.subs.put(sub('https://push.example/a', { prayers: ['maghrib'] }), now - 60_000);
    const r = await s.scheduler.tick(now);
    assert.equal(r.failed, 1);
    assert.equal(r.pruned, 0);
    assert.equal(s.subs.count(), 1);
  } finally {
    s.cleanup();
  }
});

test('with no subscribers, a tick says so rather than pretending to work', async () => {
  const s = scenario();
  try {
    assert.equal((await s.scheduler.tick(Date.parse('2026-08-24T23:35:00Z'))).skipped, 'no-subscribers');
  } finally {
    s.cleanup();
  }
});

// ── The routes ───────────────────────────────────────────────────────────────
//
// `POST /api/public/push/*` are the ONLY unauthenticated writes in this app, so they get
// tested as such: what an anonymous caller can send, and what they can read back.

const MODULES = ['./config', './fabric', './site', './cache', './server', './store', './auth', './basePath', './changelog', './rateLimit', './timetable', './timetableService', './icons', './webmanifest', './png', './push', './pushScheduler', './campaigns'];

async function routeScenario(): Promise<{ app: FastifyInstance; cleanup: () => Promise<void> }> {
  const platform = http.createServer((req, res) => {
    if (req.url === '/api/auth/session') {
      const ok = !!req.headers['x-openmasjid-app-secret'] && /omos_session=/.test(req.headers.cookie ?? '');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(ok ? { authenticated: true, username: 'Hasan' } : { authenticated: false }));
    }
    if (req.url === '/api/fabric/site') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(
        JSON.stringify({ enabled: true, domain: 'omos.example.org', publicUrl: 'https://omos.example.org/companion', basePath: '' }),
      );
    }
    res.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((r) => platform.listen(0, '127.0.0.1', r));
  const { port } = platform.address() as AddressInfo;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-pushroute-'));
  const saved = { ...process.env };
  process.env.OPENMASJID_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENMASJID_APP_SECRET = 'secret';
  process.env.DATA_DIR = path.join(dir, 'data');
  process.env.OPENMASJID_PUBLIC_URL = '';

  for (const m of MODULES) delete require.cache[require.resolve(m)];
  const { Store: S } = require('./store') as typeof import('./store');
  const { buildServer } = require('./server') as typeof import('./server');
  const store = new S(path.join(dir, 'data'));
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

const body = (endpoint: string) => ({
  subscription: { endpoint, keys: { p256dh: 'p'.repeat(20), auth: 'a'.repeat(16) } },
  prefs: { prayers: ['fajr', 'maghrib'], adhan: false, beforeIqamah: 15 },
});

test('the public key is served, and it is only ever the PUBLIC half', async () => {
  const s = await routeScenario();
  try {
    const res = await s.app.inject({ method: 'GET', url: '/api/public/push/key' });
    assert.equal(res.statusCode, 200);
    const data = res.json<{ data: { key: string } }>().data;
    assert.ok(data.key.length > 20);
    // The private key must not be in that response under any field name.
    assert.doesNotMatch(res.body, /privateKey/i);
  } finally {
    await s.cleanup();
  }
});

test('a phone can subscribe, read its own settings back, and unsubscribe', async () => {
  const s = await routeScenario();
  try {
    const e = 'https://push.example/device-a';
    assert.equal((await s.app.inject({ method: 'POST', url: '/api/public/push/subscribe', payload: body(e) })).statusCode, 200);

    const got = await s.app.inject({ method: 'POST', url: '/api/public/push/prefs', payload: { endpoint: e } });
    assert.deepEqual(got.json<{ data: { prefs: Prefs } }>().data.prefs.prayers, ['fajr', 'maghrib']);

    assert.equal((await s.app.inject({ method: 'POST', url: '/api/public/push/unsubscribe', payload: { endpoint: e } })).statusCode, 200);
    const after = await s.app.inject({ method: 'POST', url: '/api/public/push/prefs', payload: { endpoint: e } });
    assert.equal(after.json<{ data: { prefs: Prefs | null } }>().data.prefs, null, 'unknown is an answer, not a 404');
  } finally {
    await s.cleanup();
  }
});

test('A NONSENSE SUBSCRIPTION IS REFUSED rather than stored', async () => {
  const s = await routeScenario();
  try {
    const bads: unknown[] = [
      {},
      { subscription: { endpoint: 'not-a-url', keys: { p256dh: 'p', auth: 'a' } }, prefs: { prayers: [], adhan: false, beforeIqamah: null } },
      { subscription: { endpoint: 'https://push.example/x' }, prefs: { prayers: [], adhan: false, beforeIqamah: null } },
      // A lead time outside the offered range: a "reminder" hours early is not a reminder.
      { ...body('https://push.example/y'), prefs: { prayers: ['fajr'], adhan: false, beforeIqamah: 9999 } },
      { ...body('https://push.example/z'), prefs: { prayers: ['tahajjud'], adhan: false, beforeIqamah: 5 } },
    ];
    for (const bad of bads) {
      const res = await s.app.inject({ method: 'POST', url: '/api/public/push/subscribe', payload: bad as object });
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad).slice(0, 60)} should be refused`);
    }
  } finally {
    await s.cleanup();
  }
});

test('THE ADMIN IS SHOWN A COUNT AND NEVER A LIST', async () => {
  // The privacy promise, enforced where it can actually be checked: the response body must
  // not contain an endpoint, whatever shape a future field takes.
  const s = await routeScenario();
  try {
    const e = 'https://push.example/somebodys-phone-token';
    await s.app.inject({ method: 'POST', url: '/api/public/push/subscribe', payload: body(e) });

    const anon = await s.app.inject({ method: 'GET', url: '/api/admin/push' });
    assert.equal(anon.statusCode, 401, 'and not to just anyone');

    const sess = await s.app.inject({ method: 'GET', url: '/api/session', headers: { cookie: 'omos_session=x' } });
    const token = sess.cookies.find((c) => c.name === COOKIE)!.value;
    const res = await s.app.inject({ method: 'GET', url: '/api/admin/push', headers: { cookie: `${COOKIE}=${token}` } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json<{ data: { subscribers: number } }>().data.subscribers, 1);
    assert.doesNotMatch(res.body, /somebodys-phone-token/, 'no endpoint reaches the admin, ever');
    assert.doesNotMatch(res.body, /push\.example/);
  } finally {
    await s.cleanup();
  }
});

test('a musalli cannot send a test notification', async () => {
  const s = await routeScenario();
  try {
    const res = await s.app.inject({ method: 'POST', url: '/api/admin/push/test', payload: body('https://push.example/a').subscription });
    assert.equal(res.statusCode, 401);
  } finally {
    await s.cleanup();
  }
});

// ── The wire ─────────────────────────────────────────────────────────────────
//
// Everything above stubs the send. This does not: it stands up a real HTTPS listener, lets
// `web-push` do the VAPID signing and the AES-GCM encryption for real, and inspects what
// actually leaves the process. It is the difference between "our wiring is right" and "a push
// service would accept this", and it is the one part of the chain we did not write ourselves.
//
// Needs a certificate, so it needs `openssl`. Skipped rather than failed where there is none —
// a developer without it should not be blocked, and CI's ubuntu image has it.

function haveOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** A throwaway self-signed cert for 127.0.0.1, generated per run and never written to the repo. */
function selfSigned(dir: string): { key: Buffer; cert: Buffer } {
  const key = path.join(dir, 'k.pem');
  const cert = path.join(dir, 'c.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert, '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
    { stdio: 'ignore' },
  );
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

test('A REAL PUSH IS SIGNED, ENCRYPTED, AND CARRIES NO PLAINTEXT', { skip: haveOpenssl() ? false : 'openssl is not on PATH' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-wire-'));
  const tls = selfSigned(dir);
  const store = new Store(path.join(dir, 'data'));

  // Our own certificate is not in any trust store. Turned off for this test only and restored
  // in `finally` — the alternative is threading an https.Agent through production code for the
  // sole benefit of a test.
  const savedTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  let seen: { url?: string; headers: http.IncomingHttpHeaders; body: Buffer } | null = null;
  const service = https.createServer(tls, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      seen = { url: req.url, headers: req.headers, body: Buffer.concat(chunks) };
      res.writeHead(201).end();
    });
  });
  const dead = https.createServer(tls, (req, res) => { req.resume(); res.writeHead(410).end(); });
  const wobbly = https.createServer(tls, (req, res) => { req.resume(); res.writeHead(503).end(); });

  try {
    for (const s of [service, dead, wobbly]) await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const vapid = vapidKeys(store);
    // Real ECDH keys, as a browser hands them over.
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
    const port = (s: https.Server) => (s.address() as AddressInfo).port;

    const outcome = await sendOne(
      vapid,
      { endpoint: `https://127.0.0.1:${port(service)}/push/abc`, ...keys },
      { title: 'Maghrib — Masjid An-Noor', body: 'Jamāʿah in 15 minutes — 7:50 PM', tag: '2026-08-24:maghrib:iqamah', url: 'https://omos.example.org/companion' },
      'https://omos.example.org',
    );

    assert.equal(outcome, 'sent');
    assert.ok(seen, 'the push service received a request');
    const got = seen as unknown as { url: string; headers: http.IncomingHttpHeaders; body: Buffer };
    assert.equal(got.url, '/push/abc');
    assert.equal(got.headers['content-encoding'], 'aes128gcm', 'the standard content encoding, not a legacy one');
    assert.equal(got.headers.ttl, '600');
    // `vapid t=<jwt>, k=<public key>` — note the space after the comma, which web-push emits
    // and a tighter pattern here rejected.
    assert.match(String(got.headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+,\s*k=[\w-]+$/, 'a VAPID token and the public key');

    // The whole point of the encryption: nothing readable leaves this box. If this ever fails,
    // a masjid's prayer reminders are legible to every hop between here and the phone.
    const wire = got.body.toString('latin1') + JSON.stringify(got.headers);
    assert.doesNotMatch(wire, /Maghrib/, 'no plaintext title on the wire');
    assert.doesNotMatch(wire, /Jamā/, 'no plaintext body on the wire');
    assert.ok(!wire.includes(vapid.privateKey), 'THE PRIVATE KEY NEVER LEAVES THIS PROCESS');
    assert.ok(got.body.length > 100, 'and something was actually sent');

    // The two statuses the scheduler acts on differently, from a real HTTP response.
    assert.equal(await sendOne(vapid, { endpoint: `https://127.0.0.1:${port(dead)}/x`, ...keys }, { title: 't', body: 'b', tag: 'g', url: '/' }, 'https://x.example'), 'gone');
    assert.equal(await sendOne(vapid, { endpoint: `https://127.0.0.1:${port(wobbly)}/x`, ...keys }, { title: 't', body: 'b', tag: 'g', url: '/' }, 'https://x.example'), 'failed');
  } finally {
    if (savedTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = savedTls;
    store.close();
    for (const s of [service, dead, wobbly]) await new Promise<void>((r) => s.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
