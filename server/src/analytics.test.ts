// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The visit counters — and, more importantly, the things they must never become.
 *
 * CLAUDE.md §4 kept analytics out of v1 to stop this app growing a visitor log. The feature
 * arrived on 2026-08-29 and the reason did not go away, so the constraint is asserted here
 * rather than left as an intention in a comment: the schema is checked, by name, for the
 * columns it is allowed to have. A future column called `ip` or `session` fails this file
 * before it reaches anybody's masjid.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store';
import { Analytics, BROWSERS, DEVICES, KEEP_DAYS, MODES, VisitSchema, WINDOW_DAYS, dayOf, type Visit } from './analytics';

function freshStore(): Store {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'omc-analytics-')));
}

const DAY = 86_400_000;
const visit = (over: Partial<Visit> = {}): Visit => ({ device: 'ios', browser: 'safari', mode: 'browser', ...over });

// ── The privacy constraint, as a test rather than a promise ──────────────────

test('THE TABLE CAN HOLD NOTHING BUT COUNTERS', () => {
  const store = freshStore();
  new Analytics(store);
  const cols = (store.db.prepare('PRAGMA table_info(visits)').all() as { name: string }[]).map((c) => c.name).sort();
  // Exhaustive on purpose. Not "does not contain an ip column" — an allowlist, so that ANY new
  // column has to be argued for here first. There is no timestamp finer than `day`, no id, and
  // nothing that could be joined against a push subscription or anything else on the volume.
  assert.deepEqual(cols, ['browser', 'day', 'device', 'mode', 'n']);
  store.close();
});

test('the wire format has no free text in it anywhere', () => {
  // The endpoint behind this is unauthenticated, and the values are rendered in an admin panel.
  // Three closed enums is what makes "somebody could write anything into it" untrue by
  // construction rather than by escaping.
  assert.equal(VisitSchema.safeParse(visit()).success, true);
  assert.equal(VisitSchema.safeParse({ ...visit(), device: 'blackberry' }).success, false);
  assert.equal(VisitSchema.safeParse({ ...visit(), browser: '<script>' }).success, false);
  assert.equal(VisitSchema.safeParse({ ...visit(), mode: 'kiosk' }).success, false);
  assert.equal(VisitSchema.safeParse({ ...visit(), extra: 'hello' }).success, true, 'unknown keys are dropped, not stored');
  const parsed = VisitSchema.parse({ ...visit(), extra: 'hello' });
  assert.deepEqual(Object.keys(parsed).sort(), ['browser', 'device', 'mode']);
});

test('the enums match the browser half exactly', () => {
  // Two lists in two languages that must agree: `web/src/platform.ts` decides what is sent and
  // this decides what is accepted. A value only one of them knows is silently dropped at the
  // 400 — a whole category of phone missing from the figures, with nothing anywhere saying so.
  const web = fs.readFileSync(path.resolve(__dirname, '..', '..', 'web', 'src', 'platform.ts'), 'utf8');
  const listOf = (name: string): string[] => {
    const m = web.match(new RegExp(`export type ${name} =([^;]+);`));
    assert.ok(m, `web/src/platform.ts no longer declares ${name}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
  };
  assert.deepEqual(listOf('Device'), [...DEVICES].sort(), 'device lists have drifted');
  assert.deepEqual(listOf('BrowserId'), [...BROWSERS].sort(), 'browser lists have drifted');
  assert.deepEqual(listOf('Mode'), [...MODES].sort(), 'mode lists have drifted');
});

// ── Counting ─────────────────────────────────────────────────────────────────

test('the same combination increments rather than duplicating', () => {
  const store = freshStore();
  const a = new Analytics(store);
  const at = Date.parse('2026-08-29T10:00:00Z');
  a.record(visit(), at);
  a.record(visit(), at + 3_600_000); // later the same day
  const rows = store.db.prepare('SELECT * FROM visits').all() as { n: number }[];
  assert.equal(rows.length, 1, 'one row per day per combination');
  assert.equal(rows[0].n, 2);
  store.close();
});

test('the breakdown adds up, and the biggest is first', () => {
  const store = freshStore();
  const a = new Analytics(store);
  const at = Date.parse('2026-08-29T10:00:00Z');
  for (let i = 0; i < 5; i += 1) a.record(visit({ device: 'ios' }), at);
  for (let i = 0; i < 2; i += 1) a.record(visit({ device: 'android', browser: 'chrome' }), at);
  a.record(visit({ device: 'ios', mode: 'standalone' }), at);

  const b = a.breakdown(at);
  assert.equal(b.total, 8);
  assert.deepEqual(b.devices, [
    { key: 'ios', count: 6 },
    { key: 'android', count: 2 },
  ]);
  assert.equal(b.modes.find((m) => m.key === 'standalone')?.count, 1, 'the number the poster was for');
  assert.equal(b.days, 1);
  store.close();
});

test('THE WINDOW IS A WINDOW — older days are not counted in it', () => {
  const store = freshStore();
  const a = new Analytics(store);
  const now = Date.parse('2026-08-29T10:00:00Z');
  a.record(visit(), now);
  a.record(visit(), now - (WINDOW_DAYS - 1) * DAY); // the oldest day still inside
  a.record(visit(), now - WINDOW_DAYS * DAY); // one day too old
  assert.equal(a.breakdown(now).total, 2);
  store.close();
});

test('nothing is kept past the retention window, and pruning is not optional', () => {
  const store = freshStore();
  const a = new Analytics(store);
  const now = Date.parse('2026-08-29T10:00:00Z');
  // Written directly, because `record` would prune it on the way in — which is the point being
  // tested: retention is a property of WRITING, not of somebody remembering to run a job.
  store.db.prepare('INSERT INTO visits (day, device, browser, mode, n) VALUES (?, ?, ?, ?, 9)').run(dayOf(now - (KEEP_DAYS + 5) * DAY), 'ios', 'safari', 'browser');
  assert.equal((store.db.prepare('SELECT COUNT(*) AS c FROM visits').get() as { c: number }).c, 1);
  a.record(visit(), now);
  const days = (store.db.prepare('SELECT day FROM visits ORDER BY day').all() as { day: string }[]).map((r) => r.day);
  assert.deepEqual(days, [dayOf(now)], 'the old day is gone');
  store.close();
});

test('an empty store answers with zeroes rather than failing', () => {
  // A fresh install, and the first thing the admin panel does is ask. There is no "no data yet"
  // error path here — an empty breakdown is an answer.
  const store = freshStore();
  const b = new Analytics(store).breakdown();
  assert.equal(b.total, 0);
  assert.equal(b.days, 0);
  assert.deepEqual(b.devices, []);
  store.close();
});
