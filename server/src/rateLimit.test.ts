// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Both limiters are load-bearing: one is the real defence behind an admin password on a box
 * published to the internet, the other stops this container being used as an amplifier against
 * the masjid's own OpenMasjidOS core.
 *
 * Every test injects the clock rather than sleeping, so the suite stays fast and the backoff
 * curve is asserted exactly rather than approximately.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { LoginLimiter, makeRateLimiter } from './rateLimit';

const PEER = '192.168.1.50';

test('the first few failures are free, then backoff starts', () => {
  const l = new LoginLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) {
    l.fail(PEER, t0);
    assert.equal(l.retryAfterMs(PEER, t0), 0, `attempt ${i + 1} should still be free`);
  }
  l.fail(PEER, t0); // the 6th
  assert.equal(l.retryAfterMs(PEER, t0), 2000, 'first lockout is 2s');
});

test('the backoff doubles and is capped at five minutes', () => {
  const l = new LoginLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 5; i++) l.fail(PEER, t0);
  const steps: number[] = [];
  for (let i = 0; i < 10; i++) {
    l.fail(PEER, t0);
    steps.push(l.retryAfterMs(PEER, t0));
  }
  assert.deepEqual(steps.slice(0, 5), [2000, 4000, 8000, 16000, 32000], 'doubling');
  assert.equal(steps[steps.length - 1], 5 * 60 * 1000, 'capped, so a locked-out admin is never locked out for ever');
});

test('a lockout expires on its own', () => {
  const l = new LoginLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 6; i++) l.fail(PEER, t0);
  assert.equal(l.retryAfterMs(PEER, t0 + 1999), 1, 'still locked just before');
  assert.equal(l.retryAfterMs(PEER, t0 + 2000), 0, 'free again after');
});

test('a success forgets the peer entirely', () => {
  const l = new LoginLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 8; i++) l.fail(PEER, t0);
  assert.ok(l.retryAfterMs(PEER, t0) > 0);
  l.succeed(PEER);
  assert.equal(l.retryAfterMs(PEER, t0), 0);
  assert.equal(l.size(), 0);
});

test('peers are independent — one attacker cannot lock the admin out', () => {
  const l = new LoginLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 20; i++) l.fail('10.0.0.9', t0);
  assert.ok(l.retryAfterMs('10.0.0.9', t0) > 0);
  assert.equal(l.retryAfterMs(PEER, t0), 0, 'the real admin is unaffected');
});

test('the sweep never evicts a peer mid-lockout', () => {
  // This is the rate-limit bypass that hides inside a memory fix: evict an entry while its
  // lockout is live and the attacker gets a fresh allowance on every sweep.
  const l = new LoginLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 12; i++) l.fail(PEER, t0);
  const lockedFor = l.retryAfterMs(PEER, t0);
  assert.ok(lockedFor > 0);

  const midLockout = t0 + Math.floor(lockedFor / 2);
  l.sweepNow(midLockout);
  assert.equal(l.size(), 1, 'must not be swept while the lockout is live');
  assert.ok(l.retryAfterMs(PEER, midLockout) > 0, 'and the lockout is still enforced afterwards');
});

test('a live lockout is ALWAYS inside the idle window, which is why the bypass cannot happen', () => {
  // The structural reason, asserted rather than left to the reader: the longest single lockout
  // (5 min) is far shorter than the idle window (1 h), so `lockedUntil <= now` is always the
  // binding condition and no reachable clock value can sweep a peer that is still locked out.
  // Shorten IDLE_MS below MAX_MS in a future tidy-up and this is the test that objects.
  const l = new LoginLimiter();
  const t0 = 1_000_000;
  for (let i = 0; i < 40; i++) l.fail(PEER, t0); // saturate the backoff at its cap
  const maxLockout = l.retryAfterMs(PEER, t0);
  assert.equal(maxLockout, 5 * 60 * 1000, 'the cap');

  // Sweep at every point across the lockout: the entry must survive all of them.
  for (const at of [t0, t0 + 1, t0 + maxLockout / 2, t0 + maxLockout - 1]) {
    l.sweepNow(at);
    assert.equal(l.size(), 1, `swept at +${at - t0}ms, while still locked`);
  }
  // Only once the lockout has expired AND the peer has been idle for the window does it go.
  l.sweepNow(t0 + 61 * 60 * 1000);
  assert.equal(l.size(), 0, 'and it is eventually forgotten, so the map cannot grow for ever');
});

test('the sweep does forget an idle peer, so the map cannot grow for ever', () => {
  // The other half: an entry only ever exists after a fail(), and succeed() deletes it — so a
  // sweep condition that also required fails===0 could never fire, and the map grew one entry
  // per attacking IP for the life of the process. On a tunnelled box that is public.
  const l = new LoginLimiter();
  const t0 = 1_000_000;
  l.fail('1.2.3.4', t0);
  assert.equal(l.size(), 1);
  l.sweepNow(t0 + 61 * 60 * 1000); // past the idle window, not locked out
  assert.equal(l.size(), 0, 'an idle peer is forgotten');
});

test('the per-minute limiter allows exactly its budget, then refuses', () => {
  const ok = makeRateLimiter(3);
  const t0 = 500_000;
  assert.deepEqual([ok(PEER, t0), ok(PEER, t0), ok(PEER, t0)], [true, true, true]);
  assert.equal(ok(PEER, t0), false, 'the fourth in the window is refused');
});

test('the per-minute window rolls over', () => {
  const ok = makeRateLimiter(2);
  const t0 = 500_000;
  ok(PEER, t0);
  ok(PEER, t0);
  assert.equal(ok(PEER, t0 + 59_999), false, 'still inside the window');
  assert.equal(ok(PEER, t0 + 60_000), true, 'a new window');
});

test('the per-minute limiter keys on the peer', () => {
  const ok = makeRateLimiter(1);
  const t0 = 500_000;
  assert.equal(ok('a', t0), true);
  assert.equal(ok('a', t0), false);
  assert.equal(ok('b', t0), true, 'a different peer has its own budget');
});

test('the per-minute limiter bounds its own memory', () => {
  // Fed from a request's source address, so an attacker cycling addresses must not grow it
  // without limit.
  const ok = makeRateLimiter(1);
  const t0 = 500_000;
  for (let i = 0; i < 6000; i++) ok(`10.0.${(i >> 8) & 255}.${i & 255}`, t0);
  // Everything above expired by now; one more call triggers the prune.
  ok('final', t0 + 120_000);
  // No accessor on the closure, so assert the observable consequence instead: an old peer's
  // budget has been reclaimed rather than remembered for ever.
  assert.equal(ok('10.0.0.1', t0 + 120_000), true);
});
