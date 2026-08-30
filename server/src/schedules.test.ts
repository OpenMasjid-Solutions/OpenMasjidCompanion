// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * When a standing announcement fires — which is the half of this feature that is silently wrong
 * when it is wrong.
 *
 * A schedule that goes off an hour early, or twice, or three days late, all look identical from
 * inside the code that sends it: a notification arrived. The only place the difference is
 * visible is here.
 *
 * The zone is real and its DST transitions are real. `America/New_York` moves on the second
 * Sunday in March and the first in November; `Australia/Lord_Howe` moves by THIRTY MINUTES,
 * which is the case a hand-rolled "add an hour" gets wrong in a way nobody notices for a year.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from './store';
import {
  MAX_SCHEDULES,
  NewScheduleSchema,
  SCHEDULE_GRACE_MS,
  Schedules,
  dueAction,
  localDateIn,
  nextRun,
  previousRun,
  shiftDate,
  weekdayOf,
} from './schedules';

const NY = 'America/New_York';
const daily = (time: string, firedThrough = 0) => ({ repeat: 'daily' as const, days: [], date: '', time, firedThrough });
const weekly = (days: number[], time: string, firedThrough = 0) => ({ repeat: 'weekly' as const, days, date: '', time, firedThrough });
const once = (date: string, time: string, firedThrough = 0) => ({ repeat: 'once' as const, days: [], date, time, firedThrough });

function freshStore(): Store {
  return new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'omc-sched-')));
}

// ── The calendar helpers ─────────────────────────────────────────────────────

test('the masjid’s own calendar date, not the container’s', () => {
  // 03:30 UTC on the 30th is still the 29th in New York. A container in UTC deciding that
  // "today" is the 30th would run a Saturday schedule on a Friday night.
  assert.equal(localDateIn(Date.parse('2026-08-30T03:30:00Z'), NY), '2026-08-29');
  assert.equal(localDateIn(Date.parse('2026-08-30T12:00:00Z'), NY), '2026-08-30');
  assert.equal(localDateIn(Date.parse('2026-08-30T03:30:00Z'), 'Asia/Karachi'), '2026-08-30');
});

test('weekday and date arithmetic are bare-calendar, with no zone in them', () => {
  assert.equal(weekdayOf('2026-08-30'), 0, 'a Sunday');
  assert.equal(weekdayOf('2026-08-28'), 5, 'a Friday');
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
  assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
  // The one that matters: shifting across a DST boundary must move exactly one calendar day.
  assert.equal(shiftDate('2026-11-01', -1), '2026-10-31');
});

// ── Daily ────────────────────────────────────────────────────────────────────

test('a daily schedule finds today’s occurrence, then yesterday’s', () => {
  const s = daily('20:00');
  // 21:00 New York on the 29th — 20:00 has been.
  const at = Date.parse('2026-08-30T01:00:00Z');
  assert.equal(previousRun(s, at, NY), Date.parse('2026-08-30T00:00:00Z'), '20:00 EDT = 00:00Z next day');
  // 19:00 New York — today's has not come yet, so the previous one is yesterday's.
  const before = Date.parse('2026-08-29T23:00:00Z');
  assert.equal(previousRun(s, before, NY), Date.parse('2026-08-29T00:00:00Z'));
  assert.equal(nextRun(s, before, NY), Date.parse('2026-08-30T00:00:00Z'));
});

test('AT 20:00 EVERY DAY MEANS 20:00 ON BOTH SIDES OF A CLOCK CHANGE', () => {
  // New York falls back at 02:00 on 2026-11-01. 20:00 local is 00:00Z on the 1st (EDT, −4) and
  // 01:00Z on the 2nd (EST, −5). A scheduler that added 86,400,000 ms would fire the second one
  // an hour early, for ever, and nobody would report it as anything but "the app is odd".
  const s = daily('20:00');
  const saturday = previousRun(s, Date.parse('2026-11-01T02:00:00Z'), NY);
  assert.equal(saturday, Date.parse('2026-11-01T00:00:00Z'));
  const sunday = previousRun(s, Date.parse('2026-11-02T03:00:00Z'), NY);
  assert.equal(sunday, Date.parse('2026-11-02T01:00:00Z'));
  assert.equal(sunday! - saturday!, 25 * 3_600_000, 'the day the clocks went back was 25 hours long');
});

test('a half-hour zone is not a special case, because nothing here assumes hours', () => {
  // Lord Howe Island shifts by 30 minutes. It exists in this test only to prove the arithmetic
  // never touches an offset directly — it asks Intl what the wall clock reads, twice.
  const s = daily('09:00');
  const at = previousRun(s, Date.parse('2026-08-30T06:00:00Z'), 'Australia/Lord_Howe');
  assert.ok(at !== null);
  const back = new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Lord_Howe', hour: '2-digit', minute: '2-digit', hour12: false }).format(at!);
  assert.equal(back, '09:00');
});

// ── Weekly ───────────────────────────────────────────────────────────────────

test('a weekly schedule only fires on its own days', () => {
  const s = weekly([5], '11:00'); // Fridays
  const friday = Date.parse('2026-08-28T15:30:00Z'); // 11:30 EDT on a Friday
  assert.equal(previousRun(s, friday, NY), Date.parse('2026-08-28T15:00:00Z'));

  // The following Tuesday: the previous occurrence is still that Friday, and the next is the
  // Friday after. Walking back a whole week is what this is for.
  const tuesday = Date.parse('2026-09-01T15:30:00Z');
  assert.equal(previousRun(s, tuesday, NY), Date.parse('2026-08-28T15:00:00Z'));
  assert.equal(nextRun(s, tuesday, NY), Date.parse('2026-09-04T15:00:00Z'));
});

test('several days a week, in whatever order they were ticked', () => {
  const s = weekly([3, 0], '19:30'); // Wednesday and Sunday, listed backwards
  const thursday = Date.parse('2026-08-27T18:00:00Z'); // 14:00 EDT Thursday
  assert.equal(previousRun(s, thursday, NY), Date.parse('2026-08-26T23:30:00Z'), 'Wednesday');
  assert.equal(nextRun(s, thursday, NY), Date.parse('2026-08-30T23:30:00Z'), 'Sunday');
});

// ── One-off ──────────────────────────────────────────────────────────────────

test('a one-off has exactly one occurrence, and then none', () => {
  const s = once('2026-08-30', '08:00');
  const after = Date.parse('2026-08-30T12:30:00Z'); // 08:30 EDT
  assert.equal(previousRun(s, after, NY), Date.parse('2026-08-30T12:00:00Z'));
  assert.equal(nextRun(s, after, NY), null, 'nothing is ever scheduled again');
  const before = Date.parse('2026-08-29T12:00:00Z');
  assert.equal(previousRun(s, before, NY), null, 'and nothing has happened yet');
});

// ── What a tick actually does ────────────────────────────────────────────────

test('nothing is sent twice, however often the tick runs', () => {
  const at = Date.parse('2026-08-30T00:01:00Z'); // a minute past 20:00 EDT
  const first = dueAction(daily('20:00'), at, NY);
  assert.deepEqual(first, { action: 'send', at: Date.parse('2026-08-30T00:00:00Z') });
  // Having fired it, the next thirty ticks find nothing.
  const after = daily('20:00', first!.at);
  assert.equal(dueAction(after, at + 30_000, NY), null);
  assert.equal(dueAction(after, at + 8 * 3_600_000, NY), null);
});

test('A WEEKEND OFF DOES NOT BECOME A BACKLOG', () => {
  // The box was off from Thursday. It comes back on Sunday morning, and Friday's 11:00 reminder
  // must not arrive then — it is about a jamāʿah that has been and gone.
  const fired = Date.parse('2026-08-27T00:00:00Z');
  const s = weekly([5], '11:00', fired);
  const sunday = Date.parse('2026-08-30T14:00:00Z');
  const out = dueAction(s, sunday, NY);
  assert.equal(out?.action, 'skip', 'marked as dealt with, not delivered');
  assert.equal(out?.at, Date.parse('2026-08-28T15:00:00Z'), 'and it is Friday’s that is being written off');
});

test('a few minutes late is still worth sending', () => {
  const occurrence = Date.parse('2026-08-30T00:00:00Z');
  const s = daily('20:00');
  assert.equal(dueAction(s, occurrence + SCHEDULE_GRACE_MS - 1000, NY)?.action, 'send');
  assert.equal(dueAction(s, occurrence + SCHEDULE_GRACE_MS + 1000, NY)?.action, 'skip');
});

test('nothing has come round yet is a different answer from nothing to send', () => {
  // 19:00 New York, with today's 20:00 still ahead and yesterday's already dealt with.
  const s = daily('20:00', Date.parse('2026-08-29T00:00:00Z'));
  assert.equal(dueAction(s, Date.parse('2026-08-29T23:00:00Z'), NY), null);
});

// ── The schema refuses the shapes that could never fire ──────────────────────

test('A SCHEDULE THAT COULD NEVER FIRE IS REFUSED, not stored', () => {
  // Both of these would sit in the admin's list looking armed and do nothing for ever, which is
  // worse than an error message: the masjid believes the notice went out.
  assert.equal(NewScheduleSchema.safeParse({ text: 'x', repeat: 'weekly', time: '11:00', days: [] }).success, false, 'weekly with no days');
  assert.equal(NewScheduleSchema.safeParse({ text: 'x', repeat: 'once', time: '11:00', date: '' }).success, false, 'a one-off with no date');
  assert.equal(NewScheduleSchema.safeParse({ text: 'x', repeat: 'daily', time: '25:00' }).success, false, 'not a time');
  assert.equal(NewScheduleSchema.safeParse({ text: '', repeat: 'daily', time: '11:00' }).success, false, 'nothing to say');
  assert.equal(NewScheduleSchema.safeParse({ text: 'x', repeat: 'daily', time: '11:00' }).success, true);
});

// ── The store ────────────────────────────────────────────────────────────────

test('A NEW SCHEDULE DOES NOT FIRE THE MOMENT IT IS CREATED', () => {
  // Somebody setting "every day at 08:00" at nine in the morning must not be told that this
  // morning's eight o'clock has just come round. `firedThrough` starting at `now` is the whole
  // of the mechanism, and it is the kind of thing that is obvious only after it has happened.
  const store = freshStore();
  const sched = new Schedules(store);
  const now = Date.parse('2026-08-30T13:00:00Z'); // 09:00 EDT
  const added = sched.add({ text: 'Halaqa tonight', repeat: 'daily', time: '08:00', days: [], date: '' }, now);
  assert.ok(added.ok);
  assert.equal(added.schedule.firedThrough, now);
  assert.equal(dueAction(added.schedule, now + 60_000, NY), null);
  store.close();
});

test('resuming a paused schedule does not deliver what it missed', () => {
  const store = freshStore();
  const sched = new Schedules(store);
  const created = Date.parse('2026-08-20T12:00:00Z');
  const added = sched.add({ text: 'Weekly notice', repeat: 'daily', time: '08:00', days: [], date: '' }, created);
  assert.ok(added.ok);
  sched.setEnabled(added.schedule.id, false);
  const later = Date.parse('2026-08-30T13:00:00Z');
  sched.setEnabled(added.schedule.id, true, later);
  const back = sched.all()[0];
  assert.equal(back.enabled, true);
  assert.equal(back.firedThrough, later, 'the pause is not a queue');
  store.close();
});

test('firing is recorded as the OCCURRENCE, never as when we noticed', () => {
  const store = freshStore();
  const sched = new Schedules(store);
  const added = sched.add({ text: 'x', repeat: 'daily', time: '08:00', days: [], date: '' }, 1000);
  assert.ok(added.ok);
  const occurrence = Date.parse('2026-08-30T12:00:00Z');
  sched.markFired(added.schedule.id, occurrence, true);
  const row = sched.all()[0];
  assert.equal(row.firedThrough, occurrence, 'storing "now" instead would drift the window forward every tick');
  assert.equal(row.sentCount, 1);
  store.close();
});

test('a one-off is switched off once it has gone, not deleted', () => {
  // The admin should be able to see that it went and when. A row that vanishes looks like one
  // that was never saved.
  const store = freshStore();
  const sched = new Schedules(store);
  const added = sched.add({ text: 'Eid prayer is at 8', repeat: 'once', time: '19:00', days: [], date: '2026-08-30' }, 1000);
  assert.ok(added.ok);
  sched.markFired(added.schedule.id, 2000, true);
  sched.finishOnce(added.schedule.id);
  const row = sched.all()[0];
  assert.equal(row.enabled, false);
  assert.equal(row.sentCount, 1);
  assert.equal(row.text, 'Eid prayer is at 8');
  store.close();
});

test('the list is capped, and says so rather than silently dropping one', () => {
  const store = freshStore();
  const sched = new Schedules(store);
  for (let i = 0; i < MAX_SCHEDULES; i += 1) {
    assert.ok(sched.add({ text: `notice ${i}`, repeat: 'daily', time: '08:00', days: [], date: '' }).ok);
  }
  const over = sched.add({ text: 'one too many', repeat: 'daily', time: '08:00', days: [], date: '' });
  assert.deepEqual(over, { ok: false, reason: 'full' });
  store.close();
});

test('whitespace is collapsed on the way in, like an immediate announcement', () => {
  const store = freshStore();
  const sched = new Schedules(store);
  const added = sched.add({ text: '  Jumuʿah   is at\n11:00  ', repeat: 'weekly', time: '09:00', days: [5], date: '' });
  assert.ok(added.ok);
  assert.equal(added.schedule.text, 'Jumuʿah is at 11:00');
  store.close();
});
