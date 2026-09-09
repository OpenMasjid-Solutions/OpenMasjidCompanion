// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * dates.ts — one place that decides what a date looks like.
 *
 * Asked for by Hasan on 2026-09-09: dates read **MM/DD/YYYY**. Before this the app had five
 * separate formatters, each calling `Intl` with its own options, so "what does a date look like"
 * had five answers and changing it meant finding all five. It has one now.
 *
 * WHY THE LOCALE IS PINNED. Everywhere else this app follows the masjid's own `language` from
 * Display, and for the numeric date it deliberately does not: `Intl` would order the numbers by
 * the reader's locale, so the same masjid's timetable would read 09/06 on one phone and 06/09 on
 * another, and neither phone would say which it was. A numeric date is only unambiguous if
 * everyone agrees on the order, so the order is fixed rather than negotiated. **This is a
 * deliberate override, not an oversight** — the day and month names elsewhere still follow the
 * masjid's language, because a word cannot be misread as a different date.
 *
 * If a masjid outside the US ever needs DD/MM/YYYY, this is a one-line change here (and the
 * honest fix is an admin setting, not a locale guess — see the note on `ORDER`).
 */

/**
 * The fixed field order. `en-CA` would give ISO, `en-GB` day-first; `en-US` is month-first, which
 * is what was asked for. Named rather than inlined so the day this becomes a masjid setting,
 * there is exactly one value to make configurable.
 */
const ORDER = 'en-US';

/** A `YYYY-MM-DD` from Display, split without going near a Date constructor's timezone rules. */
function parts(date: string): { y: number; m: number; d: number } | null {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

/**
 * `09/09/2026` — a calendar date from Display's `YYYY-MM-DD`.
 *
 * Fixed to UTC on purpose. The string is already the masjid's own calendar date, so building a
 * local `Date` from it and formatting it back could land a day either side depending on where the
 * phone is — the one bug a prayer timetable cannot afford to have in its date line.
 */
export function formatDay(date: string): string {
  const p = parts(date);
  if (!p) return date;
  try {
    return new Intl.DateTimeFormat(ORDER, {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(Date.UTC(p.y, p.m - 1, p.d)));
  } catch {
    return date;
  }
}

/**
 * `Sunday, 09/09/2026`.
 *
 * The weekday survives the change to numerals and is not decoration: this is a prayer timetable,
 * Jumuʿah is a weekday, and somebody swiping through days needs to see which one they have landed
 * on without doing arithmetic. Its NAME still follows the masjid's language — only the numbers
 * are pinned (see the file comment).
 */
export function formatDayLong(date: string, language = 'en'): string {
  const p = parts(date);
  if (!p) return date;
  try {
    const weekday = new Intl.DateTimeFormat(language || 'en', {
      timeZone: 'UTC',
      weekday: 'long',
    }).format(new Date(Date.UTC(p.y, p.m - 1, p.d)));
    return `${weekday}, ${formatDay(date)}`;
  } catch {
    return formatDay(date);
  }
}

/** `6:04 pm`, in the reader's own clock convention — a time is not ambiguous the way a date is. */
export function formatClock(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/**
 * `09/06/2026 at 6:04 pm` — a moment in time, for "last checked" and "last sent" lines.
 *
 * A wall-clock instant rather than a calendar date, so this one IS rendered in the phone's own
 * zone: it answers "how long ago was that for me", and converting it to the masjid's zone would
 * make a reader subtract two numbers to find out.
 */
export function formatStamp(at: number, locale?: string): string {
  if (!at) return 'never';
  const d = new Date(at);
  const day = new Intl.DateTimeFormat(ORDER, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return `${day} at ${formatClock(at, locale)}`;
}
