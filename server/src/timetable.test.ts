// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The timetable client: the schemas, the error mapping, and the calendar arithmetic.
 *
 * This is the boundary where another app's output becomes the prayer times a congregation
 * organises its day by. Every test here is about one of the two ways that can go wrong:
 * accepting something we should not have (a payload in a timezone we cannot resolve), or
 * rejecting something we should have kept (a day whose sunrise field is missing).
 *
 * The service tests run against a REAL fake platform on a real socket, so the broker call, the
 * zod parse and the failure mapping all actually execute.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const MODULES = ['./config', './fabric', './site', './cache', './timetable', './timetableService', './store'];

// ── A well-formed feed, used as the base every test mutates one field of ──────

function feed(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    id: 'tt_main',
    name: 'Main hall',
    masjidName: 'Masjid An-Noor',
    timezone: 'America/New_York',
    language: 'en',
    hourCycle: '12',
    days: [day()],
    ...over,
  };
}

function day(over: Record<string, unknown> = {}) {
  return {
    date: '2026-08-24',
    hijri: { label: '11 Rabīʿ al-Awwal 1448' },
    sunrise: '06:21',
    prayers: {
      fajr: { adhan: '04:58', iqamah: '05:30' },
      dhuhr: { adhan: '12:58', iqamah: '13:30' },
      asr: { adhan: '17:12', iqamah: '17:45' },
      maghrib: { adhan: '19:42', iqamah: '19:47' },
      isha: { adhan: '21:05', iqamah: '21:30' },
    },
    jumuah: [],
    ...over,
  };
}

const load = () => {
  for (const m of MODULES) delete require.cache[require.resolve(m)];
  return {
    timetable: require('./timetable') as typeof import('./timetable'),
    fabric: require('./fabric') as typeof import('./fabric'),
    service: require('./timetableService') as typeof import('./timetableService'),
  };
};

afterEach(() => {
  for (const m of MODULES) delete require.cache[require.resolve(m)];
});

// ── Schemas ───────────────────────────────────────────────────────────────────

test('a well-formed feed parses, with sunrise and the five prayers intact', () => {
  const { timetable } = load();
  const r = timetable.FeedSchema.safeParse(feed());
  assert.ok(r.success, r.success ? '' : JSON.stringify(r.error.issues));
  assert.equal(r.data.days[0].sunrise, '06:21');
  assert.equal(r.data.days[0].prayers.maghrib.adhan, '19:42');
  assert.equal(r.data.timezone, 'America/New_York');
});

test('A TIMEZONE THIS RUNTIME CANNOT RESOLVE IS REFUSED, not quietly ignored', () => {
  // The most consequential silent failure available to this app. An unresolvable zone makes
  // every conversion fall back to the container's clock — UTC — so every prayer time and every
  // notification would be out by the masjid's whole offset, while looking entirely plausible.
  const { timetable } = load();
  for (const tz of ['Mars/Olympus', 'GMT+5', 'EST5EDT_typo', '', 'America/Nowhere']) {
    assert.equal(timetable.FeedSchema.safeParse(feed({ timezone: tz })).success, false, `"${tz}" must be refused`);
  }
  for (const tz of ['UTC', 'America/New_York', 'Asia/Kolkata', 'Europe/London', 'Australia/Sydney']) {
    assert.equal(timetable.FeedSchema.safeParse(feed({ timezone: tz })).success, true, `"${tz}" must be accepted`);
  }
});

test('a missing or odd sunrise costs the sunrise ROW, never the day’s prayer times', () => {
  // An older Display, or one that changes the field, must not take a masjid's whole timetable
  // off the page. Shurūq is a nice row; Maghrib is not optional.
  const { timetable } = load();
  for (const bad of [undefined, null, 'nonsense', 25, '25:00']) {
    const d = day();
    if (bad === undefined) delete (d as Record<string, unknown>).sunrise;
    else (d as Record<string, unknown>).sunrise = bad;
    const r = timetable.FeedSchema.safeParse(feed({ days: [d] }));
    assert.ok(r.success, `sunrise=${String(bad)} should still parse`);
    assert.equal(r.data.days[0].sunrise, null);
    assert.equal(r.data.days[0].prayers.fajr.adhan, '04:58', 'the real times survive');
  }
});

test('a null iqamah is legitimate — an Adhan with no jamā‘ah time set', () => {
  const { timetable } = load();
  const d = day({ prayers: { ...day().prayers, asr: { adhan: '17:12', iqamah: null } } });
  const r = timetable.FeedSchema.safeParse(feed({ days: [d] }));
  assert.ok(r.success);
  assert.equal(r.data.days[0].prayers.asr.iqamah, null);
});

test('a malformed time is refused rather than rendered', () => {
  // "24:00", "7:5" and "19:60" all read as times to a person skimming a page. None of them is
  // one, and a page that printed them would be presenting nonsense as the masjid's own answer.
  const { timetable } = load();
  for (const bad of ['24:00', '7:5', '19:60', '1930', '19:42:00', 'Maghrib']) {
    const d = day({ prayers: { ...day().prayers, maghrib: { adhan: bad, iqamah: '19:47' } } });
    assert.equal(timetable.FeedSchema.safeParse(feed({ days: [d] })).success, false, `"${bad}" must be refused`);
  }
});

test('a broken jumuah list empties that day’s Jumu‘ah rather than the whole feed', () => {
  const { timetable } = load();
  const r = timetable.FeedSchema.safeParse(feed({ days: [day({ jumuah: 'not an array' })] }));
  assert.ok(r.success);
  assert.deepEqual(r.data.days[0].jumuah, []);
});

test('Jumu‘ah parses with the null adhan Display always sends', () => {
  // Divergence 1 in the work order: Display has no per-Jumu'ah Adhan field at all. A schema
  // that required one would reject every Friday.
  const { timetable } = load();
  const r = timetable.FeedSchema.safeParse(
    feed({ days: [day({ jumuah: [{ label: "Jumu'ah", adhan: null, iqamah: '13:30' }] })] }),
  );
  assert.ok(r.success);
  assert.equal(r.data.days[0].jumuah[0].adhan, null);
  assert.equal(r.data.days[0].jumuah[0].iqamah, '13:30');
});

test('the list payload parses', () => {
  const { timetable } = load();
  const r = timetable.ListSchema.safeParse({ v: 1, timetables: [{ id: 'tt_main', name: 'Main hall' }] });
  assert.ok(r.success);
  assert.equal(r.data.timetables[0].name, 'Main hall');
});

// ── Failure mapping ───────────────────────────────────────────────────────────

test('the platform’s own refusals map to the right retryability', () => {
  // Getting `retryable` backwards on any row is either a retry loop against something that can
  // never succeed, or giving up on a blip and serving stale times until a human notices.
  const { fabric } = load();
  const f = (body: unknown, status = 502) => fabric.brokerFailure(status, body);

  assert.equal(f({ fabric_error: { code: 'not_granted' } }).retryable, false, 'a missing grant needs a reinstall, not a retry');
  assert.equal(f({ fabric_error: { code: 'target_not_installed' } }).retryable, false, 'Display is not going to install itself');
  assert.equal(f({ fabric_error: { code: 'target_unreachable' } }).retryable, true, 'it may just be restarting');
  assert.equal(f({ fabric_error: { code: 'timeout' } }).retryable, true);
  assert.equal(f({ fabric_error: { code: 'rate_limited' } }).retryable, true);
});

test('DISPLAY’S SETTLED REFUSALS ARE NOT RETRYABLE, and each names an admin action', () => {
  // The two that matter. A deleted timetable and a Display with no coordinates will fail
  // identically for ever; retrying them is a masjid quietly sitting on stale times while the
  // app looks busy. Both messages have to name the thing to go and do.
  const { fabric } = load();
  const deleted = fabric.brokerFailure(404, { error: 'unknown_timetable' });
  assert.equal(deleted.retryable, false);
  assert.match(deleted.admin, /choose another|no longer exists/i);

  const noLoc = fabric.brokerFailure(409, { error: 'no_location' });
  assert.equal(noLoc.retryable, false);
  assert.match(noLoc.admin, /location/i);
  assert.match(noLoc.admin, /Display/, 'it must say WHERE to set it');
});

test('a transient refusal from Display is retryable', () => {
  const { fabric } = load();
  assert.equal(fabric.brokerFailure(503, { error: 'not_ready' }).retryable, true);
  assert.equal(fabric.brokerFailure(429, { error: 'too_many_requests' }).retryable, true);
});

test('our own bugs are reported as ours, not as the masjid’s problem', () => {
  const { fabric } = load();
  for (const code of ['bad_request', 'method_not_allowed']) {
    const f = fabric.brokerFailure(400, { error: code });
    assert.equal(f.retryable, false);
    assert.match(f.admin, /bug in Companion|not something you did/i);
  }
});

test('an unrecognised body falls back on the status class', () => {
  const { fabric } = load();
  assert.equal(fabric.brokerFailure(500, {}).retryable, true, '5xx is worth another go');
  assert.equal(fabric.brokerFailure(418, {}).retryable, false);
  assert.equal(fabric.brokerFailure(500, null).code, 'http_500');
});

test('an older Display answering 401 is handled — it must NOT be read as a missing timetable', () => {
  // Display measured this and corrected our work order: an unmatched method falls through to
  // their session gate, so an older Display answers 401, not 404. From these methods a 404
  // means the ID was wrong — a different problem, with a different instruction for the admin.
  const { fabric } = load();
  const old = fabric.brokerFailure(401, { error: 'Please sign in.' });
  assert.equal(old.code, 'http_401');
  assert.notEqual(old.code, 'unknown_timetable');
  assert.doesNotMatch(old.admin, /choose another/i, 'it must not send the admin to re-pick a fine timetable');
});

// ── Calendar arithmetic ───────────────────────────────────────────────────────

test('the window is computed in the MASJID’s calendar, not the container’s', () => {
  // At 23:00 in New York the container's UTC date is already tomorrow. A window computed from
  // it starts a day late, and the masjid's actual today falls off the front.
  const { service } = load();
  const lateEvening = new Date('2026-08-25T03:00:00Z'); // 23:00 on the 24th in New York
  assert.equal(service.dateInZone(lateEvening, 'America/New_York'), '2026-08-24');
  assert.equal(service.dateInZone(lateEvening, 'UTC'), '2026-08-25');
  assert.equal(service.dateInZone(lateEvening, 'Asia/Tokyo'), '2026-08-25');
});

test('an unresolvable zone falls back to UTC rather than throwing', () => {
  const { service } = load();
  assert.equal(service.dateInZone(new Date('2026-08-24T12:00:00Z'), 'Nope/Nope'), '2026-08-24');
});

test('shiftDate crosses months, years and DST without drifting', () => {
  // Whole-day arithmetic on a date with no clock attached, so a DST change cannot push it onto
  // the wrong day — the classic bug where "yesterday" is 23 hours ago and lands on today.
  const { service } = load();
  assert.equal(service.shiftDate('2026-08-24', -1), '2026-08-23');
  assert.equal(service.shiftDate('2026-08-24', 35), '2026-09-28');
  assert.equal(service.shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(service.shiftDate('2028-03-01', -1), '2028-02-29', 'leap year');
  assert.equal(service.shiftDate('2026-01-01', -1), '2025-12-31');
  assert.equal(service.shiftDate('2026-03-08', -1), '2026-03-07', 'the US DST change day');
  assert.equal(service.shiftDate('2026-10-25', 1), '2026-10-26', 'the EU DST change day');
});

// ── The service, against a real fake platform ─────────────────────────────────

interface Fake {
  url: string;
  close: () => Promise<void>;
  calls: { method: string; body: Record<string, unknown> }[];
  /** Alerts the platform received. Separate from `calls`: an alert goes to the platform's own
   *  /api/fabric/alert, not through the app-to-app broker. */
  alerts: Record<string, unknown>[];
  reply: { status: number; body: unknown };
}

async function startBroker(): Promise<Fake> {
  const state = { reply: { status: 200, body: feed() as unknown } };
  const calls: Fake['calls'] = [];
  const alerts: Fake['alerts'] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/fabric/alert' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        alerts.push(JSON.parse(body || '{}'));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ delivered: true }));
      });
    }
    const m = /^\/api\/fabric\/app\/display\/timetable\/(\w+)$/.exec(req.url ?? '');
    if (!m) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      calls.push({ method: m[1], body: JSON.parse(raw || '{}') });
      const r = m[1] === 'list' ? { status: 200, body: { v: 1, timetables: [{ id: 'tt_main', name: 'Main hall' }] } } : state.reply;
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    calls,
    alerts,
    get reply() {
      return state.reply;
    },
    set reply(v) {
      state.reply = v;
    },
  };
}

async function withService(fn: (svc: import('./timetableService').TimetableService, fake: Fake, store: import('./store').Store) => Promise<void>) {
  const fake = await startBroker();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-tt-'));
  const saved = { ...process.env };
  process.env.OPENMASJID_BASE_URL = fake.url;
  process.env.OPENMASJID_APP_SECRET = 'secret';
  for (const m of MODULES) delete require.cache[require.resolve(m)];
  const { Store } = require('./store') as typeof import('./store');
  const { TimetableService } = require('./timetableService') as typeof import('./timetableService');
  const store = new Store(path.join(dir, 'data'));
  try {
    await fn(new TimetableService(store), fake, store);
  } finally {
    store.close();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
    process.env = saved;
    for (const m of MODULES) delete require.cache[require.resolve(m)];
  }
}

const T0 = 1_780_000_000_000;

test('with no timetable chosen, nothing is fetched and nothing is claimed', async () => {
  await withService(async (svc, fake) => {
    const s = await svc.get(T0);
    assert.equal(s.feed, null);
    assert.equal(s.id, '');
    assert.equal(s.stale, false, 'never-configured is not stale — it is a different screen');
    assert.deepEqual(fake.calls, [], 'no broker call for an app that has not been set up');
  });
});

test('choosing a timetable fetches a window that starts a day early', async () => {
  await withService(async (svc, fake) => {
    svc.setChosen('tt_main');
    const s = await svc.get(T0);
    assert.equal(s.feed?.masjidName, 'Masjid An-Noor');
    const call = fake.calls.find((c) => c.method === 'get')!;
    assert.equal(call.body.id, 'tt_main');
    assert.ok(Number(call.body.days) <= 45, 'never over Display’s cap');
    assert.ok(Number(call.body.days) >= 30, 'enough runway for the month view');
  });
});

test('AN OUTAGE KEEPS THE TIMES ON SCREEN, and marks them', async () => {
  await withService(async (svc, fake) => {
    svc.setChosen('tt_main');
    await svc.get(T0);
    fake.reply = { status: 503, body: { error: 'not_ready' } };

    const later = await svc.get(T0 + 40 * 60_000);
    assert.equal(later.feed?.masjidName, 'Masjid An-Noor', 'a musalli still sees the times');
    assert.equal(later.stale, true, 'and is told they are out of date');
    assert.equal(later.at, T0, 'the age reported is the age of the DATA');
    assert.equal(later.failure?.code, 'not_ready');
  });
});

test('a deleted timetable is reported as needing the admin, not as a blip', async () => {
  await withService(async (svc, fake) => {
    svc.setChosen('tt_main');
    await svc.get(T0);
    fake.reply = { status: 404, body: { error: 'unknown_timetable' } };
    const s = await svc.get(T0 + 40 * 60_000);
    assert.equal(s.failure?.code, 'unknown_timetable');
    assert.equal(s.failure?.retryable, false);
    assert.equal(s.feed?.masjidName, 'Masjid An-Noor', 'the stale cache is still served meanwhile');
  });
});

test('a feed for the WRONG timetable is refused outright', async () => {
  // Never observed, and never to be trusted: rendering it would put another hall's jamā'ah
  // times under this masjid's name, which is the single worst output this app has.
  await withService(async (svc, fake) => {
    svc.setChosen('tt_main');
    await svc.get(T0);
    fake.reply = { status: 200, body: feed({ id: 'tt_womens', masjidName: 'Somewhere Else' }) };
    const s = await svc.get(T0 + 40 * 60_000);
    assert.equal(s.feed?.masjidName, 'Masjid An-Noor', 'the previous, correct feed is kept');
    assert.equal(s.failure?.code, 'wrong_timetable');
  });
});

test('a payload in an unresolvable timezone is refused, and the old one kept', async () => {
  await withService(async (svc, fake) => {
    svc.setChosen('tt_main');
    await svc.get(T0);
    fake.reply = { status: 200, body: feed({ timezone: 'Mars/Olympus' }) };
    const s = await svc.get(T0 + 40 * 60_000);
    assert.equal(s.failure?.code, 'bad_payload');
    assert.equal(s.feed?.timezone, 'America/New_York');
  });
});

test('switching timetable drops the previous one’s times immediately', async () => {
  // The one moment this app could show a real person a genuinely wrong time: the old hall's
  // jamā'ah still on screen while the new one loads.
  await withService(async (svc, fake) => {
    svc.setChosen('tt_main');
    await svc.get(T0);
    assert.ok(svc.peek(T0).feed);
    fake.reply = { status: 503, body: { error: 'not_ready' } }; // the new one cannot load yet
    svc.setChosen('tt_womens');
    assert.equal(svc.peek(T0).feed, null, 'nothing from the old timetable survives the switch');
  });
});

test('the last good feed survives a restart, dated when it was really fetched', async () => {
  await withService(async (svc, fake, store) => {
    svc.setChosen('tt_main');
    await svc.get(T0);

    const { TimetableService } = require('./timetableService') as typeof import('./timetableService');
    const restarted = new TimetableService(store);
    const s = restarted.peek(T0 + 60_000);
    assert.equal(s.feed?.masjidName, 'Masjid An-Noor', 'a restart must not blank the prayer times');
    assert.equal(s.at, T0, 'and must not claim it just fetched them');
    assert.equal(fake.calls.filter((c) => c.method === 'get').length, 1, 'the restore costs no broker call');
  });
});

test('the sustained-outage alert fires ONCE, and not before six hours', async () => {
  await withService(async (svc, fake) => {
    svc.setChosen('tt_main');
    await svc.get(T0);
    fake.reply = { status: 503, body: { error: 'not_ready' } };

    // Five hours of failing polls: still silent. An alert per failed poll is ninety-six emails
    // a day, which is a way of not being told anything.
    for (const mins of [20, 60, 120, 240, 299]) await svc.get(T0 + mins * 60_000);
    assert.equal(fake.alerts.length, 0, 'nothing before the threshold');

    // Past six hours it fires, with the DECLARED id and wording an admin can act on.
    await svc.get(T0 + 7 * 60 * 60_000);
    assert.equal(fake.alerts.length, 1, 'exactly one alert');
    assert.equal(fake.alerts[0].id, 'timetable-unavailable', 'the id the manifest declares');
    assert.match(String(fake.alerts[0].message), /prayer times/i);
    assert.match(String(fake.alerts[0].message), /out of date|last times/i, 'it must say musallis are seeing stale times');

    // And it does NOT fire again for the same outage, however long it lasts.
    for (const hours of [8, 12, 24, 72]) await svc.get(T0 + hours * 60 * 60_000);
    assert.equal(fake.alerts.length, 1, 'once per outage, not once per poll');

    const s = svc.peek(T0 + 72 * 60 * 60_000);
    assert.equal(s.stale, true, 'and the times are still on screen, still marked');
    assert.equal(s.feed?.masjidName, 'Masjid An-Noor');
  });
});

test('a second outage, after a recovery, alerts again', async () => {
  // "Once per outage" must not become "once, ever". A masjid whose Display broke in Ramadan and
  // again in Shawwal has to be told both times.
  //
  // Note the shape: the FIRST failure only starts the clock. An alert needs a failure that is
  // itself six hours after the outage began, which is why each outage below takes two polls.
  const hour = 60 * 60_000;
  await withService(async (svc, fake) => {
    svc.setChosen('tt_main');
    await svc.get(T0);

    // Outage one: starts at +1h, alerts at +8h.
    fake.reply = { status: 503, body: { error: 'not_ready' } };
    await svc.get(T0 + 1 * hour);
    assert.equal(fake.alerts.length, 0, 'the first failure only starts the clock');
    await svc.get(T0 + 8 * hour);
    assert.equal(fake.alerts.length, 1);

    // Recovered.
    fake.reply = { status: 200, body: feed() };
    const back = await svc.get(T0 + 9 * hour);
    assert.equal(back.stale, false);

    // Outage two: starts at +10h.
    fake.reply = { status: 503, body: { error: 'not_ready' } };
    await svc.get(T0 + 10 * hour);
    await svc.get(T0 + 11 * hour);
    assert.equal(fake.alerts.length, 1, 'the new outage has not lasted six hours yet');
    await svc.get(T0 + 17 * hour);
    assert.equal(fake.alerts.length, 2, 'a fresh outage is a fresh alert');
  });
});

test('an app that has NEVER had a feed does not alert — that is a setup screen, not an outage', async () => {
  // A masjid mid-setup, or one whose Display is not installed yet, is looking at the honest
  // "prayer times aren't set up yet" page. Emailing them about it every six hours would be
  // telling them off for not having finished.
  await withService(async (svc, fake) => {
    fake.reply = { status: 503, body: { error: 'not_ready' } };
    svc.setChosen('tt_main');
    for (const hours of [1, 7, 24]) await svc.get(T0 + hours * 60 * 60_000);
    assert.equal(fake.alerts.length, 0);
    assert.equal(svc.peek(T0).feed, null);
  });
});

test('recovery clears the failure and the staleness', async () => {
  await withService(async (svc, fake) => {
    svc.setChosen('tt_main');
    await svc.get(T0);
    fake.reply = { status: 503, body: { error: 'not_ready' } };
    assert.equal((await svc.get(T0 + 40 * 60_000)).stale, true);

    fake.reply = { status: 200, body: feed() };
    const back = await svc.get(T0 + 80 * 60_000);
    assert.equal(back.stale, false);
    assert.equal(back.failure, null);
    assert.equal(back.at, T0 + 80 * 60_000);
  });
});

test('the picker’s list comes through, and a broker failure is an answer not a crash', async () => {
  await withService(async (svc) => {
    const ok = await svc.list();
    assert.ok(ok.ok);
    assert.equal(ok.data.timetables[0].id, 'tt_main');
  });
});
