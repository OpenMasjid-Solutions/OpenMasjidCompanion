// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The time logic behind the musalli page.
 *
 * The failure this guards against is the worst one this app can have short of inventing a
 * prayer time outright: a countdown, a "current prayer" highlight, or later a push
 * notification, that is silently an hour out for part of the year. Nobody reports it as a bug —
 * it just looks like the masjid's times are wrong.
 *
 * So the DST cases are not decoration. `zonedTimeToEpoch` is exercised either side of real
 * transitions in zones that change on different dates, in a zone that does not change at all,
 * and in zones whose offset is not a whole number of hours.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  type Day,
  changedPrayers,
  formatDate,
  formatMonth,
  formatTime,
  formatUntil,
  iqamahChanges,
  momentsFor,
  monthGrid,
  periodOf,
  positionAt,
  slotTime,
  slotsFor,
  todayInZone,
  tzOffsetMs,
  weekStartsOn,
  weekdayLabels,
  zonedTimeToEpoch,
} from './prayerTimes';

const NY = 'America/New_York';

function day(date: string, over: Partial<Day> = {}): Day {
  return {
    date,
    hijri: { label: '11 Rabīʿ al-Awwal 1448' },
    sunrise: '06:21',
    prayers: {
      fajr: { adhan: '05:01', iqamah: '05:30' },
      dhuhr: { adhan: '13:05', iqamah: '13:30' },
      asr: { adhan: '17:48', iqamah: '18:00' },
      maghrib: { adhan: '19:45', iqamah: '19:50' },
      isha: { adhan: '21:05', iqamah: '21:30' },
    },
    jumuah: [],
    ...over,
  };
}

// ── Offsets ──────────────────────────────────────────────────────────────────

test('the zone offset is read at the INSTANT, not assumed fixed', () => {
  assert.equal(tzOffsetMs(Date.parse('2026-01-15T12:00:00Z'), NY), -5 * 3_600_000, 'EST');
  assert.equal(tzOffsetMs(Date.parse('2026-07-15T12:00:00Z'), NY), -4 * 3_600_000, 'EDT');
  assert.equal(tzOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'Asia/Kolkata'), 5.5 * 3_600_000, 'not a whole hour');
  assert.equal(tzOffsetMs(Date.parse('2026-07-15T12:00:00Z'), 'Asia/Kathmandu'), 5.75 * 3_600_000);
  assert.equal(tzOffsetMs(Date.parse('2026-01-15T12:00:00Z'), 'UTC'), 0);
});

// ── Placing a wall-clock time ────────────────────────────────────────────────

test('a wall-clock time in the masjid’s zone lands on the right instant', () => {
  assert.equal(zonedTimeToEpoch('2026-08-24', '19:45', NY), Date.parse('2026-08-24T23:45:00Z'), 'EDT is UTC-4');
  assert.equal(zonedTimeToEpoch('2026-01-24', '19:45', NY), Date.parse('2026-01-25T00:45:00Z'), 'EST is UTC-5');
  assert.equal(zonedTimeToEpoch('2026-08-24', '13:05', 'UTC'), Date.parse('2026-08-24T13:05:00Z'));
});

test('DST SPRING FORWARD: times either side of the change land correctly', () => {
  // US clocks go 02:00 → 03:00 on 2026-03-08. A single-pass offset lookup gets one side wrong,
  // and every prayer that day is an hour out.
  assert.equal(zonedTimeToEpoch('2026-03-08', '01:30', NY), Date.parse('2026-03-08T06:30:00Z'), 'still EST');
  assert.equal(zonedTimeToEpoch('2026-03-08', '05:01', NY), Date.parse('2026-03-08T09:01:00Z'), 'now EDT');
  assert.equal(zonedTimeToEpoch('2026-03-09', '05:01', NY), Date.parse('2026-03-09T09:01:00Z'), 'the day after');
});

test('DST FALL BACK: the hour that happens twice resolves consistently', () => {
  // US clocks go 02:00 → 01:00 on 2026-11-01, so 01:30 exists twice. Either is defensible; what
  // matters is that it resolves to one of them and never throws or drifts to another day.
  const t = zonedTimeToEpoch('2026-11-01', '01:30', NY);
  const back = new Intl.DateTimeFormat('en-CA', { timeZone: NY, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
  assert.equal(back, '01:30', 'it round-trips to the wall clock we asked for');
  assert.equal(zonedTimeToEpoch('2026-11-01', '05:01', NY), Date.parse('2026-11-01T10:01:00Z'), 'after the change: EST');
  assert.equal(zonedTimeToEpoch('2026-10-31', '05:01', NY), Date.parse('2026-10-31T09:01:00Z'), 'before it: EDT');
});

test('a wall-clock time inside the spring-forward GAP does not throw or move days', () => {
  // 02:30 never happens on 2026-03-08 in New York. Display would not normally emit one, but a
  // page that crashed on it would take the whole timetable down.
  const t = zonedTimeToEpoch('2026-03-08', '02:30', NY);
  assert.ok(Number.isFinite(t));
  assert.equal(todayInZone(t, NY), '2026-03-08', 'still the same day');
});

test('zones that change on OTHER dates, and one that never changes', () => {
  // The UK moves three weeks after the US, so an offset cached from "last time we looked" is
  // wrong for that whole window.
  assert.equal(zonedTimeToEpoch('2026-03-15', '12:00', 'Europe/London'), Date.parse('2026-03-15T12:00:00Z'), 'still GMT');
  assert.equal(zonedTimeToEpoch('2026-04-15', '12:00', 'Europe/London'), Date.parse('2026-04-15T11:00:00Z'), 'BST');
  assert.equal(zonedTimeToEpoch('2026-01-15', '12:00', 'Asia/Riyadh'), Date.parse('2026-01-15T09:00:00Z'));
  assert.equal(zonedTimeToEpoch('2026-07-15', '12:00', 'Asia/Riyadh'), Date.parse('2026-07-15T09:00:00Z'), 'UTC+3 all year');
});

test('half-hour zones, because a great many masjids are in them', () => {
  assert.equal(zonedTimeToEpoch('2026-08-24', '13:05', 'Asia/Kolkata'), Date.parse('2026-08-24T07:35:00Z'));
  assert.equal(zonedTimeToEpoch('2026-08-24', '13:05', 'Asia/Kathmandu'), Date.parse('2026-08-24T07:20:00Z'));
});

test('a wall-clock time round-trips through the zone it came from, all year', () => {
  // The property that actually matters, asserted broadly rather than at hand-picked dates.
  for (const tz of [NY, 'Europe/London', 'Asia/Riyadh', 'Asia/Kolkata', 'Australia/Sydney', 'America/Sao_Paulo']) {
    for (const date of ['2026-01-15', '2026-03-08', '2026-04-01', '2026-07-15', '2026-10-25', '2026-11-01', '2026-12-31']) {
      for (const hhmm of ['05:01', '13:05', '19:45', '23:59']) {
        const t = zonedTimeToEpoch(date, hhmm, tz);
        const wall = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(t);
        assert.equal(wall, hhmm, `${tz} ${date} ${hhmm} did not round-trip`);
      }
    }
  }
});

test('the masjid’s date is the masjid’s, not the reader’s', () => {
  const t = Date.parse('2026-08-25T03:00:00Z'); // 23:00 on the 24th in New York
  assert.equal(todayInZone(t, NY), '2026-08-24');
  assert.equal(todayInZone(t, 'UTC'), '2026-08-25');
  assert.equal(todayInZone(t, 'Asia/Tokyo'), '2026-08-25');
});

// ── Rows ─────────────────────────────────────────────────────────────────────

test('an ordinary day is Fajr, Sunrise, Dhuhr, Asr, Maghrib, Isha', () => {
  assert.deepEqual(
    slotsFor(day('2026-08-24')).map((s) => s.key),
    ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'],
  );
});

test('Shurūq is marked as a sun event and carries no Iqamah', () => {
  const sunrise = slotsFor(day('2026-08-24')).find((s) => s.key === 'sunrise')!;
  assert.equal(sunrise.sunEvent, true);
  assert.equal(sunrise.iqamah, null, 'there is no jamā‘ah for sunrise');
  assert.equal(sunrise.adhan, '06:21');
});

test('a day with no sunrise simply has no sunrise row', () => {
  const keys = slotsFor(day('2026-08-24', { sunrise: null })).map((s) => s.key);
  assert.deepEqual(keys, ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']);
});

test('ON A FRIDAY, JUMU‘AH REPLACES DHUHR rather than sitting beside it', () => {
  // A masjid does not hold both. A row for a Dhuhr jamā'ah on a Friday sends someone to a
  // prayer that is not happening.
  const friday = day('2026-08-28', { jumuah: [{ label: "Jumu'ah", adhan: null, iqamah: '13:30' }] });
  const slots = slotsFor(friday);
  assert.deepEqual(slots.map((s) => s.key), ['fajr', 'sunrise', 'jumuah', 'asr', 'maghrib', 'isha']);
  assert.equal(slots.some((s) => s.key === 'dhuhr'), false);
});

test('Jumu‘ah takes its Adhan from that day’s Dhuhr, because Display always sends null', () => {
  // Work order divergence 1: Display has no per-Jumu'ah Adhan field anywhere in its model.
  // Rendering `jumuah[].adhan` would print an em dash where the Adhan time belongs.
  const friday = day('2026-08-28', { jumuah: [{ label: "Jumu'ah", adhan: null, iqamah: '13:30' }] });
  const j = slotsFor(friday).find((s) => s.key === 'jumuah')!;
  assert.equal(j.adhan, '13:05', "that day's Dhuhr adhan");
  assert.equal(j.iqamah, '13:30');
});

test('more than one Jumu‘ah each gets a row, in order', () => {
  const friday = day('2026-08-28', {
    jumuah: [
      { label: 'First Jumu‘ah', adhan: null, iqamah: '12:45' },
      { label: 'Second Jumu‘ah', adhan: null, iqamah: '14:00' },
    ],
  });
  const js = slotsFor(friday).filter((s) => s.key === 'jumuah');
  assert.equal(js.length, 2);
  assert.deepEqual(js.map((s) => s.iqamah), ['12:45', '14:00']);
  assert.deepEqual(js.map((s) => s.label), ['First Jumu‘ah', 'Second Jumu‘ah']);
});

test('an unlabelled Jumu‘ah is numbered only when there is more than one', () => {
  const one = slotsFor(day('2026-08-28', { jumuah: [{ label: '', adhan: null, iqamah: '13:30' }] }));
  assert.equal(one.find((s) => s.key === 'jumuah')!.label, "Jumu'ah");
  const two = slotsFor(
    day('2026-08-28', { jumuah: [{ label: '', adhan: null, iqamah: '12:45' }, { label: '', adhan: null, iqamah: '14:00' }] }),
  ).filter((s) => s.key === 'jumuah');
  assert.deepEqual(two.map((s) => s.label), ["Jumu'ah 1", "Jumu'ah 2"]);
});

// ── Where we are in the day ──────────────────────────────────────────────────

const week = [day('2026-08-23'), day('2026-08-24'), day('2026-08-25')];

test('mid-afternoon: Asr has come in and Maghrib is next', () => {
  const now = zonedTimeToEpoch('2026-08-24', '18:00', NY);
  const p = positionAt(week, NY, now);
  assert.equal(p.current?.key, 'asr');
  assert.equal(p.next?.key, 'maghrib');
  assert.equal(p.until, 105 * 60_000, '17:48 → 19:45');
  assert.equal(p.label, 'Asr');
});

test('BETWEEN SUNRISE AND DHUHR THE PERIOD IS DUHA, not "Sunrise"', () => {
  // What the reference design shows there, and the correct name for the stretch between Shurūq
  // and Zawāl. It is a label for the gap between two of Display's own times.
  const now = zonedTimeToEpoch('2026-08-24', '12:04', NY);
  const p = positionAt(week, NY, now);
  assert.equal(p.current?.key, 'sunrise');
  assert.equal(p.label, 'Duha');
  assert.equal(p.next?.key, 'dhuhr');
  assert.equal(p.until, 61 * 60_000);
});

test('AFTER ISHA THE NEXT PRAYER IS TOMORROW’S FAJR', () => {
  // The reason the server fetches a window rather than a day: at 23:00 today's rows are all in
  // the past, and a day-at-a-time model shows no "next" at all.
  const now = zonedTimeToEpoch('2026-08-24', '23:00', NY);
  const p = positionAt(week, NY, now);
  assert.equal(p.current?.key, 'isha');
  assert.equal(p.next?.key, 'fajr');
  assert.equal(p.next?.date, '2026-08-25', 'tomorrow');
  assert.equal(p.until, 361 * 60_000, '23:00 → 05:01');
});

test('BEFORE FAJR THE CURRENT PERIOD IS YESTERDAY’S ISHA', () => {
  const now = zonedTimeToEpoch('2026-08-24', '03:00', NY);
  const p = positionAt(week, NY, now);
  assert.equal(p.current?.key, 'isha');
  assert.equal(p.current?.date, '2026-08-23', 'yesterday');
  assert.equal(p.next?.key, 'fajr');
  assert.equal(p.next?.date, '2026-08-24');
});

test('exactly at the Adhan, that prayer is current — not still the one before', () => {
  const now = zonedTimeToEpoch('2026-08-24', '19:45', NY);
  const p = positionAt(week, NY, now);
  assert.equal(p.current?.key, 'maghrib');
  assert.equal(p.next?.key, 'isha');
});

test('THE COUNTDOWN IS RIGHT ACROSS A SPRING-FORWARD NIGHT', () => {
  // The night the clocks jump. From 23:00 on the 7th to Fajr on the 8th is FIVE wall-clock
  // hours but only four real ones. A countdown built on naive date arithmetic says five, and is
  // an hour wrong at exactly the moment someone is setting an alarm for Fajr.
  const days = [day('2026-03-07'), day('2026-03-08'), day('2026-03-09')];
  const now = zonedTimeToEpoch('2026-03-07', '23:00', NY);
  const p = positionAt(days, NY, now);
  assert.equal(p.next?.key, 'fajr');
  assert.equal(p.next?.date, '2026-03-08');
  assert.equal(p.until, 5 * 3_600_000 + 1 * 60_000, 'five real hours, not six');
});

test('the countdown is right across a fall-back night too', () => {
  // The mirror image: 23:00 to 05:01 is six wall-clock hours but seven real ones.
  const days = [day('2026-10-31'), day('2026-11-01')];
  const now = zonedTimeToEpoch('2026-10-31', '23:00', NY);
  const p = positionAt(days, NY, now);
  assert.equal(p.next?.date, '2026-11-01');
  assert.equal(p.until, 7 * 3_600_000 + 1 * 60_000, 'seven real hours');
});

test('a row with no Adhan cannot be current or next, but does not break the sequence', () => {
  const odd = day('2026-08-24');
  odd.prayers.asr = { adhan: null, iqamah: '18:00' };
  const now = zonedTimeToEpoch('2026-08-24', '18:00', NY);
  const p = positionAt([odd], NY, now);
  // Asr has no Adhan, so it cannot be placed on the timeline at all: the most recent prayer
  // that CAN be placed is Dhuhr. The row still appears in the table with an em dash — it just
  // never becomes the highlighted one.
  assert.equal(p.current?.key, 'dhuhr');
  assert.equal(p.next?.key, 'maghrib', 'the sequence continues past the unplaceable row');
  assert.ok(slotsFor(odd).some((s) => s.key === 'asr'), 'and the row is still rendered');
});

test('an empty window produces no answer rather than a wrong one', () => {
  const p = positionAt([], NY, Date.now());
  assert.equal(p.current, null);
  assert.equal(p.next, null);
  assert.equal(p.until, 0);
});

test('moments come out in chronological order across days', () => {
  const ms = momentsFor(week, NY);
  for (let i = 1; i < ms.length; i += 1) assert.ok(ms[i].at >= ms[i - 1].at, 'sorted');
});

// ── Formatting ───────────────────────────────────────────────────────────────

test('times follow the TIMETABLE’s hour cycle, not the reader’s phone', () => {
  // The times on a musalli's screen should read the way they read on the wall inside.
  assert.match(formatTime('19:45', '12'), /7:45/);
  assert.equal(formatTime('19:45', '24'), '19:45');
  assert.match(formatTime('05:01', '12'), /5:01/);
  assert.equal(formatTime('00:30', '24'), '00:30');
  assert.match(formatTime('12:00', '12'), /12:00/);
});

test('a missing time is an em dash, never a zero or a guess', () => {
  assert.equal(formatTime(null, '12'), '—');
  assert.equal(formatTime('', '12'), '—');
  assert.equal(formatTime('nonsense', '12'), '—');
});

test('the countdown reads like a person would say it', () => {
  assert.equal(formatUntil(0), 'less than a minute');
  assert.equal(formatUntil(30_000), 'less than a minute');
  assert.equal(formatUntil(12 * 60_000), '12 min');
  assert.equal(formatUntil(61 * 60_000), '1 hr 1 min');
  assert.equal(formatUntil(120 * 60_000), '2 hr');
  assert.equal(formatUntil(5 * 3_600_000 + 60_000), '5 hr 1 min');
});

test('the date reads as a date, and does not slip a day', () => {
  // Formatted in UTC from a date with no clock, so no zone can move it onto the day before.
  assert.match(formatDate('2026-08-24'), /Monday/);
  assert.match(formatDate('2026-08-24'), /24/);
  assert.match(formatDate('2026-01-01'), /January/);
});

test('TWO JUMU‘AHS DO NOT LAND ON THE SAME INSTANT', () => {
  // They share that day's single Dhuhr Adhan, because Display has no per-Jumu'ah Adhan field.
  // Placing them by it puts both jamā'āt on the same moment: both rows highlight at once, and
  // the countdown skips the first to name the last. They are placed by their jamā'ah time.
  const friday = day('2026-08-28', {
    jumuah: [
      { label: 'First Jumuʿah', adhan: null, iqamah: '13:15' },
      { label: 'Second Jumuʿah', adhan: null, iqamah: '14:15' },
    ],
  });
  const ms = momentsFor([friday], NY).filter((m) => m.key === 'jumuah');
  assert.equal(ms.length, 2);
  assert.notEqual(ms[0].at, ms[1].at, 'two jamāʿāt are two different moments');
  assert.equal(ms[0].at, zonedTimeToEpoch('2026-08-28', '13:15', NY));
  assert.equal(ms[1].at, zonedTimeToEpoch('2026-08-28', '14:15', NY));
});

test('between two Jumu‘ahs, the FIRST is current and the second is next', () => {
  const friday = day('2026-08-28', {
    jumuah: [
      { label: 'First Jumuʿah', adhan: null, iqamah: '13:15' },
      { label: 'Second Jumuʿah', adhan: null, iqamah: '14:15' },
    ],
  });
  const p = positionAt([friday], NY, zonedTimeToEpoch('2026-08-28', '13:30', NY));
  assert.equal(p.label, 'First Jumuʿah', 'the jamāʿah that has already begun');
  assert.equal(p.next?.label, 'Second Jumuʿah');
  assert.equal(p.until, 45 * 60_000);
});

test('slotTime places ordinary prayers by Adhan and Jumu‘ah by jamā‘ah', () => {
  const slots = slotsFor(day('2026-08-28', { jumuah: [{ label: 'J', adhan: null, iqamah: '13:15' }] }));
  assert.equal(slotTime(slots.find((s) => s.key === 'maghrib')!), '19:45', 'Adhan');
  assert.equal(slotTime(slots.find((s) => s.key === 'jumuah')!), '13:15', 'jamāʿah');
  assert.equal(slotTime(slots.find((s) => s.key === 'sunrise')!), '06:21');
});

// ── The period the page themes itself by ─────────────────────────────────────

test('each prayer opens the period named after it, and Jumu‘ah sits inside Dhuhr', () => {
  // The sky at one o'clock on a Friday is the sky at one o'clock. Giving Jumu'ah a period of its
  // own would repaint the whole app once a week for no reason a musalli could name.
  const week = [day('2026-08-24')];
  const at = (hhmm: string) => periodOf(positionAt(week, NY, zonedTimeToEpoch('2026-08-24', hhmm, NY)));
  assert.equal(at('05:30'), 'fajr');
  assert.equal(at('07:00'), 'sunrise', 'Duha');
  assert.equal(at('14:00'), 'dhuhr');
  assert.equal(at('18:00'), 'asr');
  assert.equal(at('20:00'), 'maghrib');
  assert.equal(at('22:00'), 'isha');

  const friday = [day('2026-08-28', { jumuah: [{ label: 'J', adhan: null, iqamah: '13:15' }] })];
  assert.equal(periodOf(positionAt(friday, NY, zonedTimeToEpoch('2026-08-28', '14:00', NY))), 'dhuhr');
});

test('BEFORE ANYTHING HAS COME IN, the period is night', () => {
  // Happens between midnight and Fajr on the window's first day. Night is the truthful answer,
  // and it is also the one that does not flash a white page at somebody at four in the morning.
  assert.equal(periodOf(positionAt([], NY, Date.parse('2026-08-24T09:00:00Z'))), 'isha');
  const today = [day('2026-08-24')];
  assert.equal(periodOf(positionAt(today, NY, zonedTimeToEpoch('2026-08-24', '03:00', NY))), 'isha');
});

// ── Iqamah changes ───────────────────────────────────────────────────────────

const withIqamah = (date: string, fajr: string, dhuhr = '13:30') =>
  day(date, {
    prayers: {
      fajr: { adhan: '05:01', iqamah: fajr },
      dhuhr: { adhan: '13:05', iqamah: dhuhr },
      asr: { adhan: '17:48', iqamah: '18:00' },
      maghrib: { adhan: '19:45', iqamah: '19:50' },
      isha: { adhan: '21:05', iqamah: '21:30' },
    },
  });

test('the day a jamā‘ah time changes is marked, and only that day', () => {
  // The one thing on a month of prayer times somebody actually needs to spot: the day they will
  // otherwise turn up at the wrong time.
  const days = [
    withIqamah('2026-08-23', '05:25'),
    withIqamah('2026-08-24', '05:25'),
    withIqamah('2026-08-25', '05:35'), // changed
    withIqamah('2026-08-26', '05:35'),
    withIqamah('2026-08-27', '05:35', '13:45'), // changed again, a different prayer
  ];
  assert.deepEqual([...iqamahChanges(days)].sort(), ['2026-08-25', '2026-08-27']);
});

test('the first day of the window is never marked — there is nothing before it', () => {
  const days = [withIqamah('2026-08-23', '05:25'), withIqamah('2026-08-24', '05:25')];
  assert.equal(iqamahChanges(days).size, 0);
});

test('A FRIDAY IS NOT A CHANGE just because Jumu‘ah exists that day', () => {
  // Jumu'ah is sent on Fridays and only on Fridays. Folding it into the comparison would mark
  // every Friday (it appeared) and every Saturday (it went away) — fifty-two false marks a year,
  // which makes the whole feature worthless.
  const days = [
    withIqamah('2026-08-27', '05:35'),
    { ...withIqamah('2026-08-28', '05:35'), jumuah: [{ label: 'J', adhan: null, iqamah: '13:15' }] },
    withIqamah('2026-08-29', '05:35'),
  ];
  assert.equal(iqamahChanges(days).size, 0, 'neither the Friday nor the Saturday is a change');
});

test('a day with no jamā‘ah set is compared like any other', () => {
  const none = day('2026-08-24');
  none.prayers.asr = { adhan: '17:48', iqamah: null };
  const days = [withIqamah('2026-08-23', '05:25'), none];
  assert.equal(iqamahChanges(days).has('2026-08-24'), true, 'losing a jamāʿah time is a change too');
});

test('the changed prayers are named, with both times, for the day that changed', () => {
  const days = [withIqamah('2026-08-23', '05:25'), withIqamah('2026-08-24', '05:35')];
  const changed = changedPrayers(days, '2026-08-24', '12');
  assert.equal(changed.length, 1);
  assert.match(changed[0], /Fajr/);
  assert.match(changed[0], /5:25/);
  assert.match(changed[0], /5:35/);
  assert.deepEqual(changedPrayers(days, '2026-08-23', '12'), [], 'nothing to compare the first day to');
});

// ── The month grid ───────────────────────────────────────────────────────────

test('a month grid is whole weeks, padded, with every real day present exactly once', () => {
  const weeks = monthGrid('2026-08-24', 'en');
  assert.ok(weeks.every((w) => w.length === 7), 'every row is a week');
  const real = weeks.flat().filter((c) => c.date);
  assert.equal(real.length, 31, 'August has 31 days');
  assert.equal(real[0].date, '2026-08-01');
  assert.equal(real[30].date, '2026-08-31');
  assert.equal(new Set(real.map((c) => c.date)).size, 31, 'no duplicates');
});

test('the 1st lands in the right column', () => {
  // 2026-08-01 is a Saturday. With a Sunday-start week that is the last column.
  const weeks = monthGrid('2026-08-15', 'en');
  assert.equal(weeks[0][6].date, '2026-08-01');
  for (let i = 0; i < 6; i += 1) assert.equal(weeks[0][i].date, null, 'the days before it are padding');
});

test('the week starts where the reader’s language says it does', () => {
  // A masjid's calendar reading wrong for its own congregation is the kind of small thing that
  // makes an app feel foreign.
  assert.equal(weekStartsOn('en-US'), 0, 'Sunday');
  const gb = weekStartsOn('en-GB');
  assert.ok(gb === 1 || gb === 0, 'Monday where the runtime knows, Sunday where it does not');
  assert.equal(weekdayLabels('en').length, 7);
  assert.equal(new Set(weekdayLabels('en')).size >= 6, true, 'the labels are distinct');
});

test('a Monday-start locale shifts the whole grid by a column, not by a day', () => {
  if (weekStartsOn('en-GB') !== 1) return; // the runtime has no weekInfo — nothing to assert
  const weeks = monthGrid('2026-08-15', 'en-GB');
  assert.equal(weeks[0][5].date, '2026-08-01', 'Saturday is the sixth column when weeks start Monday');
  assert.equal(weeks.flat().filter((c) => c.date).length, 31);
});

test('MONTH BOUNDARIES ARE UTC CALENDAR ARITHMETIC, never a local Date', () => {
  // A local-time Date in a zone behind UTC puts the 1st on the previous day and shifts the whole
  // grid by a column. February in a leap year is the case that catches it.
  assert.equal(monthGrid('2028-02-10').flat().filter((c) => c.date).length, 29, '2028 is a leap year');
  assert.equal(monthGrid('2026-02-10').flat().filter((c) => c.date).length, 28);
  assert.equal(monthGrid('2026-12-31').flat().filter((c) => c.date).pop()!.date, '2026-12-31');
  assert.equal(monthGrid('2026-01-01').flat().filter((c) => c.date)[0].date, '2026-01-01');
});

test('the month is named in the masjid’s own language', () => {
  assert.match(formatMonth('2026-08-24', 'en'), /August/);
  assert.match(formatMonth('2026-08-24', 'en'), /2026/);
  assert.equal(typeof formatMonth('2026-08-24', 'ar'), 'string');
  assert.equal(formatMonth('2026-08-24', 'not-a-language').length > 0, true, 'a bad language must not throw');
});
