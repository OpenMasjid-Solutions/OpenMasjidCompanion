// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * dates.ts — one place that decides what a date looks like.
 *
 * Before this the app had five separate formatters, each calling `Intl` with its own options, so
 * "what does a date look like" had five answers and changing it meant finding all five.
 *
 * TWO SHAPES, and which one is used is a deliberate choice each time (Hasan, 2026-09-09):
 *
 *  - **Worded — "September 9, 2026" — is the default**, and is what a musalli reads on the day
 *    view, what the admin sees on a scheduled announcement, and what every "last checked" line
 *    uses. A month name cannot be misread; `09/11` versus `11/09` can.
 *  - **Numeric — "09/11/2026" — is for the offline banner only.** It sits inside a sentence that
 *    is already doing work ("you are offline, so these are the times saved on this phone …"), and
 *    a short date keeps that sentence readable.
 *
 * WHY THE NUMERIC ORDER IS PINNED. `Intl` orders the fields by the READER's locale, so the same
 * masjid's timetable would read 09/11 on one phone and 11/09 on another and neither would say
 * which. A numeric date is only unambiguous if everyone agrees on the order, so the order is
 * fixed rather than negotiated. Month and weekday NAMES still follow the masjid's own language,
 * because a word cannot be misread as a different date.
 */

/**
 * The fixed field order for the numeric form. `en-CA` would give ISO, `en-GB` day-first; `en-US`
 * is month-first, which is what was asked for. Named rather than inlined so the day this becomes
 * a masjid setting, there is exactly one value to make configurable.
 */
const ORDER = 'en-US';

/** A `YYYY-MM-DD` from Display, split without going near a Date constructor's timezone rules. */
function parts(date: string): { y: number; m: number; d: number } | null {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

/**
 * Fixed to UTC on purpose. The string is already the masjid's own calendar date, so building a
 * local `Date` from it and formatting it back could land a day either side depending on where the
 * phone is — the one bug a prayer timetable cannot afford in its date line.
 */
function atUtc(p: { y: number; m: number; d: number }): Date {
  return new Date(Date.UTC(p.y, p.m - 1, p.d));
}

/** `09/11/2026`. The offline banner, and nothing else — see the file comment. */
export function formatDayNumeric(date: string): string {
  const p = parts(date);
  if (!p) return date;
  try {
    return new Intl.DateTimeFormat(ORDER, { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(atUtc(p));
  } catch {
    return date;
  }
}

/**
 * `September 9, 2026` — the ordinary way this app writes a date.
 *
 * ASSEMBLED rather than handed whole to `Intl`, and that is the point. Given a locale, `Intl`
 * picks the field ORDER as well as the words: `en-GB` returns "9 September 2026" and others put
 * the year first. Only the month NAME is a translation; the order was asked for. So the name is
 * localised and the arrangement is ours — the same split the numeric form makes.
 */
export function formatDayWorded(date: string, language = 'en'): string {
  const p = parts(date);
  if (!p) return date;
  try {
    const month = new Intl.DateTimeFormat(language || 'en', { timeZone: 'UTC', month: 'long' }).format(atUtc(p));
    return `${month} ${p.d}, ${p.y}`;
  } catch {
    return date;
  }
}

/**
 * `Friday, September 11, 2026`.
 *
 * The weekday is not decoration: this is a prayer timetable, Jumuʿah is a weekday, and somebody
 * swiping through days needs to see which one they landed on without doing arithmetic.
 */
export function formatDayLong(date: string, language = 'en'): string {
  const p = parts(date);
  if (!p) return date;
  try {
    const weekday = new Intl.DateTimeFormat(language || 'en', { timeZone: 'UTC', weekday: 'long' }).format(atUtc(p));
    return `${weekday}, ${formatDayWorded(date, language)}`;
  } catch {
    return formatDayWorded(date, language);
  }
}

/** `6:04 pm`, in the reader's own clock convention — a time is not ambiguous the way a date is. */
export function formatClock(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** The calendar date of a moment, in the phone's own zone rather than the masjid's — these
 *  answer "how long ago was that for me", and converting would make a reader subtract. */
function dayOfMoment(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** `September 6, 2026 at 6:04 pm` — "last checked", "last read", "last sent". */
export function formatStamp(at: number, locale?: string): string {
  if (!at) return 'never';
  return `${formatDayWorded(dayOfMoment(at), locale)} at ${formatClock(at, locale)}`;
}

/** `09/06/2026 at 6:04 pm` — the offline banner only. */
export function formatStampNumeric(at: number, locale?: string): string {
  if (!at) return 'never';
  return `${formatDayNumeric(dayOfMoment(at))} at ${formatClock(at, locale)}`;
}
