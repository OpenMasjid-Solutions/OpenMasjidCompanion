// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * zoned.ts — putting a masjid's wall-clock time onto a real instant.
 *
 * The push scheduler is the only part of this app that has to answer "when, in absolute
 * terms, is Maghrib?" — the musalli page does the same arithmetic in the browser, where the
 * reader's own clock is at least in the same room as them. Here there is no reader: a
 * container in UTC decides when a phone in another timezone gets a notification, from a
 * timetable written in the masjid's local time.
 *
 * **Date + "HH:mm" + an IANA zone is not a fixed offset.** It moves twice a year in most of
 * the world, and a hand-rolled `+5` is wrong for half the year in the places it is wrong. The
 * failure is silent and it is bad: a "Maghrib in 10 minutes" that arrives an hour early is
 * worse than no notification, because someone acts on it.
 *
 * This is the same two-pass algorithm as `web/src/prayerTimes.ts`, deliberately duplicated
 * rather than shared. The two halves of this app are separate builds with separate tsconfigs,
 * and a shared module would mean a build-time dependency between them for eleven lines of
 * arithmetic. **They are tested against the same real DST transitions** (`zoned.test.ts` and
 * `prayerTimes.test.ts`), which is what actually keeps them honest.
 */

/**
 * How far `timeZone` is from UTC at a given instant, in ms (east positive).
 *
 * Asks Intl what the local wall clock reads at that instant and measures the difference. This
 * is the only correct way to get it: the offset is a property of the INSTANT, not of the zone
 * — New York is −5 in January and −4 in July, and plenty of zones are not whole hours.
 */
export function tzOffsetMs(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  // `hour` can come back as 24 for midnight under hour12:false in some implementations.
  const asIfUtc = Date.UTC(n('year'), n('month') - 1, n('day'), n('hour') % 24, n('minute'), n('second'));
  return asIfUtc - at;
}

/**
 * "2026-08-24" + "19:42" in the masjid's zone → the instant that actually is.
 *
 * Two passes, and the second is not optional. The first guess uses the offset in force at the
 * NAIVE instant; on the two days a year the clocks move, that can be the wrong side of the
 * transition and the answer is an hour out. The second pass re-reads the offset at the
 * corrected instant and applies it.
 *
 * A time inside a spring-forward gap — a wall-clock reading that never happens — has no right
 * answer, and this returns the instant one hour EARLIER (02:30 on a US spring-forward Sunday
 * comes back as 01:30 local), not the one the clock jumps to. That is what the two passes
 * arrive at, and it is written down here because the previous version of this comment claimed
 * the opposite and nothing checked it.
 *
 * It cannot arise from real data: Display computes in the masjid's own zone, so it can only
 * emit wall-clock times that the masjid's wall clock actually showed. What matters, and what
 * the tests assert, is that every existing time is exact and a non-existent one still yields a
 * real instant within the hour rather than NaN or a silent day's error.
 */
export function zonedTimeToEpoch(date: string, hhmm: string, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const naive = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0);
  const first = naive - tzOffsetMs(naive, timeZone);
  return naive - tzOffsetMs(first, timeZone);
}

/** Is this a well-formed "HH:mm"? Cross-app input reaches the scheduler, and `Number('')`
 *  is 0 — an unchecked blank would schedule a notification for midnight. */
export function isHhmm(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

/**
 * The masjid's wall-clock time, formatted for a notification body.
 *
 * Formatted in the MASJID's zone and language, not the container's and not the reader's: the
 * notification says when the jamā'ah is, and that is a fact about the building.
 */
export function formatTimeIn(date: string, hhmm: string, timeZone: string, hourCycle: '12' | '24', language: string): string {
  const at = zonedTimeToEpoch(date, hhmm, timeZone);
  try {
    return new Intl.DateTimeFormat(language || 'en', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: hourCycle === '12',
    }).format(at);
  } catch {
    return hhmm;
  }
}
