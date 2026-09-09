// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * What a date looks like, pinned.
 *
 * A date line is read at a glance and acted on — somebody swiping to Friday to check Jumuʿah is
 * deciding when to leave the house. The failure mode is silent: 09/06 and 06/09 look equally
 * plausible, so a wrong field order is not noticed, it is simply believed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatClock, formatDay, formatDayLong, formatStamp } from './dates';

test('A DATE IS MONTH FIRST, zero-padded, with the year', () => {
  assert.equal(formatDay('2026-09-09'), '09/09/2026');
  // The decisive case: a day and month that cannot be confused for each other.
  assert.equal(formatDay('2026-08-30'), '08/30/2026');
  assert.equal(formatDay('2026-01-01'), '01/01/2026');
  assert.equal(formatDay('2026-12-25'), '12/25/2026');
});

test('the order does NOT follow the reader’s phone', () => {
  // The whole point. Intl would order these by locale, so the same masjid's timetable would read
  // 09/06 on one phone and 06/09 on another, with nothing on either saying which.
  assert.equal(formatDay('2026-06-09'), '06/09/2026', 'June the 9th, not the 6th of September');
});

test('the weekday survives, because Jumuʿah is a weekday', () => {
  const s = formatDayLong('2026-09-11', 'en');
  assert.match(s, /^Friday, /, 'somebody swiping to Jumuʿah must see they landed on Friday');
  assert.match(s, /09\/11\/2026$/);
});

test('the weekday NAME still follows the masjid’s language — only the numbers are pinned', () => {
  // A word cannot be misread as a different date, so there is no reason to force English here.
  const fr = formatDayLong('2026-09-11', 'fr');
  assert.match(fr, /09\/11\/2026$/, 'the numbers do not move');
  assert.ok(!fr.startsWith('Friday'), `expected a localised weekday, got "${fr}"`);
});

test('A DATE FROM DISPLAY IS NEVER SHIFTED BY THE PHONE’S TIMEZONE', () => {
  // The string is already the masjid's own calendar date. Building a local Date from it and
  // formatting it back can land a day either side — the one bug a timetable's date line cannot
  // afford. Midnight-adjacent dates are where that would show.
  assert.equal(formatDay('2026-01-01'), '01/01/2026');
  assert.equal(formatDay('2026-12-31'), '12/31/2026');
});

test('rubbish in is returned untouched rather than printed as a wrong date', () => {
  assert.equal(formatDay('nonsense'), 'nonsense');
  assert.equal(formatDay(''), '');
  assert.equal(formatDayLong('nonsense', 'en'), 'nonsense');
});

// ── moments in time ──────────────────────────────────────────────────────────

test('a "last checked" stamp is the same order, with the time after it', () => {
  const at = new Date(2026, 8, 6, 18, 4).getTime(); // 6 Sept 2026, local
  const s = formatStamp(at, 'en-US');
  assert.match(s, /^09\/06\/2026 at /);
  assert.match(s, /6:04/);
});

test('nothing ever prints as a date when there is no date', () => {
  assert.equal(formatStamp(0), 'never');
});

test('the clock is the reader’s own convention — a time is not ambiguous the way a date is', () => {
  const at = new Date(2026, 0, 2, 13, 5).getTime();
  assert.match(formatClock(at, 'en-US'), /1:05/, '12-hour for a US reader');
  assert.match(formatClock(at, 'en-GB'), /13:05/, '24-hour for a British one');
});
