// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * When a musalli is told they are looking at a saved copy.
 *
 * This is the test for the failure the whole file exists to prevent: the masjid moves Iqamah, a
 * phone opens the app days later with no signal, and the old time is drawn with exactly the same
 * confidence as a live one. Every branch below is a case where getting it wrong is invisible on
 * screen — the times look identical either way — which is precisely why it is pinned here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeWhen, noticeFor, type FeedMeta } from './freshness';

const meta = (over: Partial<FeedMeta> = {}): FeedMeta => ({ fromCache: false, cachedAt: 0, ...over });

test('times that came from the masjid just now carry NO caveat', () => {
  // The ordinary case, and it must stay quiet. A permanent warning is a warning nobody reads.
  assert.equal(noticeFor(meta(), 1_700_000_000_000, true), null);
  assert.equal(noticeFor(meta(), 1_700_000_000_000, false), null);
});

test('NO metadata at all is treated as live, not as cached', () => {
  // On the LAN over plain http there is no service worker, so nothing marks the response. That
  // request went straight to the server, so it IS live — inventing a warning there would train
  // readers to ignore the one that matters.
  assert.equal(noticeFor(null, 1_700_000_000_000, true), null);
});

test('A SAVED COPY IS ALWAYS DECLARED, however recent', () => {
  // There is no age below which showing an unlabelled copy becomes honest: the reader cannot
  // see how old it is unless we say so. Two minutes old is not alarming because the timestamp
  // says two minutes, not because the notice was suppressed.
  const fresh = noticeFor(meta({ fromCache: true, cachedAt: 1_700_000_000_000 }), 0, false);
  assert.ok(fresh, 'a two-minute-old copy is still a copy');
  assert.equal(fresh.at, 1_700_000_000_000);
});

test('the two causes are told apart, because they need different words', () => {
  // "You are offline" is actionable and familiar — and wrong, and quietly confusing, when the
  // phone has four bars and it is the masjid's box that is off.
  const off = noticeFor(meta({ fromCache: true, cachedAt: 5 }), 0, false);
  const on = noticeFor(meta({ fromCache: true, cachedAt: 5 }), 0, true);
  assert.equal(off?.kind, 'offline');
  assert.equal(on?.kind, 'unreachable');
});

test('THE PHONE’S OWN STAMP WINS over the server’s', () => {
  // The decisive case. `serverAt` is when the SERVER last read Display; on a cached body it is
  // frozen at whatever it was when the copy was taken. Showing it would answer a question the
  // reader did not ask. What they need is "how old is the thing in front of me".
  const n = noticeFor(meta({ fromCache: true, cachedAt: 2_000 }), 9_999, false);
  assert.equal(n?.at, 2_000);
});

test('an entry stored before the phone stamped them falls back to the server’s time', () => {
  // A cache written by an older build has no stamp. The server's time is close enough to be
  // worth showing, and far better than no date at all next to a claim that times may have moved.
  const n = noticeFor(meta({ fromCache: true, cachedAt: 0 }), 4_242, false);
  assert.equal(n?.at, 4_242);
});

// ── the words next to it ─────────────────────────────────────────────────────

test('the age is an absolute date, not a relative one', () => {
  const now = new Date(2026, 8, 9, 18, 30).getTime();

  // Same day is the one case that reads better without a date: the reader is judging an age, and
  // three numbers to compare against today's tell them nothing they did not already know.
  const earlier = new Date(2026, 8, 9, 6, 4).getTime();
  assert.match(describeWhen(earlier, now, 'en-GB'), /^today at /);

  // Anything older gets the real date, in the same MM/DD/YYYY order as everywhere else — not
  // "3 days ago", which reads as an app being chatty about itself rather than a fact to weigh
  // against "did the committee change Iqamah this week?".
  const daysAgo = new Date(2026, 8, 6, 6, 4).getTime();
  assert.match(describeWhen(daysAgo, now, 'en-GB'), /^on 09\/06\/2026 at /);
});

test('a missing or impossible timestamp never prints a wrong date', () => {
  const now = 1_700_000_000_000;
  assert.equal(describeWhen(0, now), 'a while ago');
  // A phone with a clock set into the future must not claim the copy is from next year.
  assert.equal(describeWhen(now + 86_400_000, now), 'a while ago');
});
