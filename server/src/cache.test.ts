// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The cache sits in front of every upstream this app has, so the ways it can be subtly wrong
 * are the ways the whole app can be subtly wrong:
 *
 *  - Caching a failure as though it were an answer → a masjid's logo vanishes for five minutes
 *    because the core happened to be restarting when the first phone opened the app.
 *  - Advancing the data's timestamp on a failure → a week-old timetable that reports having
 *    been fetched a moment ago, so the staleness marker a musalli relies on never appears.
 *  - No in-flight dedupe → fifty phones at Maghrib become fifty calls to Display.
 *
 * Time is injected rather than slept, so these run instantly and test the real boundaries
 * rather than approximately-the-boundaries.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { Cached, KEEP, loaded } from './cache';

const T0 = 1_760_000_000_000;

test('a fresh value is served without asking again until the TTL is up', async () => {
  let calls = 0;
  const c = new Cached<string>(async () => {
    calls += 1;
    return loaded(`v${calls}`);
  }, 1000);

  assert.equal((await c.get(T0)).value, 'v1');
  assert.equal((await c.get(T0 + 999)).value, 'v1', 'still inside the TTL');
  assert.equal(calls, 1);
  assert.equal((await c.get(T0 + 1000)).value, 'v2', 'the TTL is inclusive at its edge');
  assert.equal(calls, 2);
});

test('concurrent callers on a cold cache produce ONE upstream call', async () => {
  // The stampede this prevents is not hypothetical: every phone in the building opens the app
  // within the same minute at Maghrib, and the core, Display and Donations are all on the same
  // Pi as we are.
  let calls = 0;
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  const c = new Cached<string>(async () => {
    calls += 1;
    await gate;
    return loaded('once');
  }, 1000);

  const all = Promise.all([c.get(T0), c.get(T0), c.get(T0), c.get(T0), c.get(T0)]);
  release!();
  const results = await all;
  assert.equal(calls, 1, 'five concurrent gets must share one load');
  for (const r of results) assert.equal(r.value, 'once');
});

test('KEEP holds the previous value rather than replacing it with nothing', async () => {
  let up: 'ok' | 'down' = 'ok';
  const c = new Cached<string>(async () => (up === 'ok' ? loaded('the times') : KEEP), 1000);

  assert.equal((await c.get(T0)).value, 'the times');
  up = 'down';
  const after = await c.get(T0 + 5000);
  assert.equal(after.value, 'the times', 'an unreachable upstream must never empty the cache');
  assert.equal(after.stale, true, 'and the caller has to be told it is old');
});

test('a failure does NOT advance the data timestamp — the marker reports the age of the DATA', async () => {
  // Get this wrong and every staleness marker in the app silently stops working: the data is a
  // week old, the last attempt was a second ago, and the page cheerfully says "updated just
  // now" over times nobody has confirmed since last Tuesday.
  let up: 'ok' | 'down' = 'ok';
  const c = new Cached<string>(async () => (up === 'ok' ? loaded('x') : KEEP), 1000);

  await c.get(T0);
  assert.equal(c.peek(T0).at, T0);
  up = 'down';
  await c.get(T0 + 60_000);
  assert.equal(c.peek(T0 + 60_000).at, T0, 'at is the last SUCCESS, not the last attempt');
});

test('a failure inside the TTL is not stale — the data it is sitting on is still current', async () => {
  // Marking this stale would put a warning on perfectly good data, and a marker that cries wolf
  // is a marker an admin learns to ignore.
  let up: 'ok' | 'down' = 'ok';
  const c = new Cached<string>(async () => (up === 'ok' ? loaded('x') : KEEP), 10_000, 100);

  await c.get(T0);
  up = 'down';
  const e = await c.get(T0 + 200); // past retryMs, so it really did try and fail
  assert.equal(e.value, 'x');
  assert.equal(e.stale, false, 'a second-old value is not stale just because a refresh failed');
});

test('after a failure it retries on retryMs, not on the full TTL', async () => {
  let calls = 0;
  let up: 'ok' | 'down' = 'down';
  const c = new Cached<string>(async () => {
    calls += 1;
    return up === 'ok' ? loaded('back') : KEEP;
  }, 60_000, 1000);

  await c.get(T0);
  assert.equal(calls, 1);
  await c.get(T0 + 999);
  assert.equal(calls, 1, 'still backing off');
  up = 'ok';
  assert.equal((await c.get(T0 + 1000)).value, 'back', 'retried on the shorter interval');
  assert.equal(calls, 2);
});

test('loaded(null) is an ANSWER and is cached; KEEP is not', async () => {
  // This is the distinction that stops "this masjid has set no logo" and "we could not reach
  // the platform" collapsing into the same thing — they need different retry behaviour, and a
  // bare sentinel value cannot tell them apart.
  let calls = 0;
  const c = new Cached<string | null>(async () => {
    calls += 1;
    return loaded(null);
  }, 1000);

  const e = await c.get(T0);
  assert.equal(e.value, null);
  assert.equal(e.stale, false);
  await c.get(T0 + 500);
  assert.equal(calls, 1, 'null is a real answer and is held for the full TTL');
});

test('never having loaded is reported as undefined, not as a stale value', async () => {
  const c = new Cached<string>(async () => KEEP, 1000);
  const e = await c.get(T0);
  assert.equal(e.value, undefined, 'the caller shows "not set up yet", not "here is old data"');
  assert.equal(e.at, 0);
  assert.equal(e.stale, true);
});

test('a loader that throws is caught and treated as KEEP', async () => {
  // Every fetch in this app is written not to throw. "Written not to" is not "cannot", and a
  // request must not die because an upstream client got it wrong.
  let boom = false;
  const c = new Cached<string>(async () => {
    if (boom) throw new Error('kaboom');
    return loaded('good');
  }, 1000);

  await c.get(T0);
  boom = true;
  const e = await c.get(T0 + 2000);
  assert.equal(e.value, 'good');
  assert.equal(e.stale, true);
});

test('invalidate forces the next get to reload but keeps the value meanwhile', async () => {
  // The admin panel's "check again": the page must not blank out while the refresh is in
  // flight.
  let n = 0;
  const c = new Cached<string>(async () => loaded(`v${++n}`), 60_000);
  await c.get(T0);
  assert.equal(c.peek(T0).value, 'v1');
  c.invalidate();
  assert.equal(c.peek(T0).value, 'v1', 'still there until the reload lands');
  assert.equal((await c.get(T0 + 1)).value, 'v2');
});

test('clear drops the value as well, for a setting that made it meaningless', async () => {
  // Picking a different timetable in the admin panel must not leave the previous masjid hall's
  // times on screen for the rest of the TTL.
  const c = new Cached<string>(async () => loaded('x'), 60_000);
  await c.get(T0);
  c.clear();
  assert.equal(c.peek(T0).value, undefined);
  assert.equal(c.peek(T0).at, 0);
});
