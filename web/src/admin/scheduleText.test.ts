// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The sentence a standing announcement is confirmed by.
 *
 * This is the whole safety of the feature. An admin ticks some boxes, reads one line, presses a
 * button and never opens the screen again — so "Every Friday at 11:00 am" is the only chance
 * anybody has to notice they meant Thursday. If that line is wrong, the masjid does not find
 * out; four hundred phones do.
 *
 * The locale is pinned in every case. Without it these assertions would pass or fail depending
 * on the machine running them, which is a test that reports the developer's settings rather
 * than the code.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeNext, describeSchedule, joinList, prettyDate, prettyTime, weekdayNames } from './scheduleText';

const EN = 'en-GB';

test('a stored time is FORMATTED, never converted', () => {
  // The value is already the masjid's wall clock. Putting it through a timezone would shift it
  // by the difference between the masjid and whoever happens to be reading the panel — the
  // exact bug this app is careful about everywhere else.
  assert.equal(prettyTime('20:00', 'en-US'), '8:00 PM');
  assert.equal(prettyTime('00:05', 'en-US'), '12:05 AM');
  // A 24-hour locale pads, because "0:05" reads as a fragment rather than as five past midnight.
  assert.equal(prettyTime('00:05', 'en-GB'), '00:05');
  assert.equal(prettyTime('06:00', 'en-GB'), '06:00');
  assert.equal(prettyTime('06:00', 'en-US'), '6:00 AM', 'and a 12-hour one does not');
  assert.equal(prettyTime('11:00', 'en-GB'), '11:00');
  assert.equal(prettyTime('13:45', 'en-GB'), '13:45');
});

test('a time that is not a time comes back unchanged rather than as midnight', () => {
  // `Number('')` is 0, so an unguarded version of this would render a broken value as "12:00 AM"
  // — a plausible-looking time nobody chose.
  assert.equal(prettyTime(''), '');
  assert.equal(prettyTime('nonsense'), 'nonsense');
});

test('the weekday names are the READER’S, and index 0 is Sunday', () => {
  const en = weekdayNames(EN);
  assert.equal(en.length, 7);
  assert.equal(en[0], 'Sunday', 'the picker stores 0 for Sunday, and the server reads it the same way');
  assert.equal(en[5], 'Friday');
  // Built from a real week rather than hard-coded, so a panel in Arabic gets Arabic.
  assert.notEqual(weekdayNames('ar')[5], 'Friday');
});

test('DAYS ARE NAMED IN WEEK ORDER, NOT IN THE ORDER THEY WERE TICKED', () => {
  // The picker appends. Somebody who taps Sunday after Wednesday would otherwise be shown
  // "Every Sunday and Wednesday" for a Wednesday-and-Sunday schedule — small, and exactly the
  // kind of wrongness that makes a reader stop trusting the rest of the screen.
  const s = { repeat: 'weekly' as const, time: '19:30', days: [3, 0], date: '' };
  assert.equal(describeSchedule(s, EN), 'Every Sunday and Wednesday at 19:30');
});

test('the three kinds each read as themselves', () => {
  assert.equal(describeSchedule({ repeat: 'daily', time: '20:00', days: [], date: '' }, EN), 'Every day at 20:00');
  assert.equal(describeSchedule({ repeat: 'weekly', time: '11:00', days: [5], date: '' }, EN), 'Every Friday at 11:00');
  assert.equal(
    describeSchedule({ repeat: 'once', time: '08:00', days: [], date: '2026-08-30' }, EN),
    'Once, on Sunday 30 August at 08:00',
  );
});

test('all seven days is "every day", because that is what it is', () => {
  const s = { repeat: 'weekly' as const, time: '06:00', days: [0, 1, 2, 3, 4, 5, 6], date: '' };
  assert.equal(describeSchedule(s, EN), 'Every day at 06:00');
});

test('a weekly schedule with no days does not claim to send on any', () => {
  // The form and the server both refuse this shape, so it should be unreachable — but a
  // sentence that invented a day for it would be worse than a vague one.
  const s = { repeat: 'weekly' as const, time: '06:00', days: [], date: '' };
  assert.equal(describeSchedule(s, EN), 'Every week at 06:00');
});

test('a date is read as a bare calendar date, with no zone applied', () => {
  // "2026-08-30" is a Sunday. Parsing it as local midnight and formatting it back through a
  // zone is how a date silently becomes the day before west of Greenwich.
  assert.equal(prettyDate('2026-08-30', EN), 'Sunday 30 August');
  assert.equal(prettyDate('2026-01-01', EN), 'Thursday 1 January');
  assert.equal(prettyDate('nonsense', EN), 'nonsense');
});

test('the conjunction is the reader’s own word for "and"', () => {
  assert.equal(joinList(['Friday', 'Sunday'], EN), 'Friday and Sunday');
  assert.equal(joinList(['Monday'], EN), 'Monday');
  assert.equal(joinList([], EN), '');
});

test('THE NEXT SEND IS SHOWN ON THE MASJID’S CLOCK', () => {
  // A volunteer checking the panel from another country must be told when the notice lands on
  // the congregation's phones, not when it lands on theirs. 15:00Z is 11:00 in New York.
  const at = Date.parse('2026-08-28T15:00:00Z');
  const ny = describeNext(at, 'America/New_York', true, EN);
  assert.match(ny, /11:00/, `expected the masjid's hour, got "${ny}"`);
  assert.match(ny, /Fri/);
  // The same instant on a different masjid's clock is a different hour, which is the point.
  assert.match(describeNext(at, 'Asia/Karachi', true, EN), /20:00/);
});

test('paused and finished are different sentences, and neither is a time', () => {
  const at = Date.parse('2026-08-28T15:00:00Z');
  assert.equal(describeNext(at, 'America/New_York', false, EN), 'Paused');
  assert.equal(describeNext(null, 'America/New_York', true, EN), 'Nothing more to send');
});
