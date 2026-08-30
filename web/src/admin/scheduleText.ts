// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Saying out loud what a schedule will do.
 *
 * The whole safety of standing announcements rests on one sentence being right. An admin ticks
 * some boxes, presses a button, and then never looks at this screen again — so "Every Friday at
 * 11:00 am" is the only chance anybody has to notice that they meant Thursday. A schedule that
 * fires on the wrong day is not discovered by the masjid; it is discovered by four hundred
 * phones.
 *
 * Pure, and its own module, because that sentence is worth testing and a React component is not
 * a thing you can assert on cheaply.
 */

export type Repeat = 'once' | 'daily' | 'weekly';

export interface ScheduleLike {
  repeat: Repeat;
  /** "HH:mm", the MASJID's wall clock. */
  time: string;
  /** 0 = Sunday. */
  days: number[];
  /** "YYYY-MM-DD", the masjid's calendar. */
  date: string;
}

/**
 * "20:00" → "8:00 pm", in the reader's own locale.
 *
 * **No timezone conversion happens here, and that is the point.** The stored value is already
 * the masjid's wall clock; putting it through a zone would shift it by the difference between
 * the masjid and whoever is looking at the panel, which is exactly the bug this app is careful
 * about everywhere else. Formatting through UTC is how you ask Intl for "render these digits
 * the way this locale renders a time" and nothing more.
 */
export function prettyTime(hhmm: string, locale?: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return hhmm;
  const at = Date.UTC(2026, 0, 1, h, m);
  try {
    // The padding follows the CLOCK, and neither answer is right for both. A 12-hour locale
    // wants "8:00 PM" and reads "08:00 PM" as something a machine printed; a 24-hour one wants
    // "00:05", where the unpadded "0:05" looks like a fragment. So it is asked, rather than
    // picked — `hour12` is what the locale itself says about its own clock.
    const twelve = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hour12;
    return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', hour: twelve ? 'numeric' : '2-digit', minute: '2-digit' }).format(at);
  } catch {
    return hhmm;
  }
}

/** The day names, in the reader's language. Built from a known week rather than hard-coded, so
 *  a masjid running the panel in Arabic or Urdu gets its own. */
export function weekdayNames(locale?: string, width: 'long' | 'short' = 'long'): string[] {
  // 2026-01-04 was a Sunday. Read as UTC so the index and the name cannot disagree.
  return Array.from({ length: 7 }, (_, i) => {
    const at = Date.UTC(2026, 0, 4 + i);
    try {
      return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: width }).format(at);
    } catch {
      return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i];
    }
  });
}

/** "2026-08-30" → "Sunday 30 August", in the reader's locale and with no zone applied. */
export function prettyDate(date: string, locale?: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  const at = Date.UTC(y, m - 1, d);
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' }).format(at);
  } catch {
    return date;
  }
}

/** "Friday and Sunday" — an Intl list, so the conjunction is the reader's own word for "and". */
export function joinList(items: string[], locale?: string): string {
  if (items.length === 0) return '';
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

/**
 * The one sentence.
 *
 * Days are sorted before they are named, because the picker stores them in the order they were
 * ticked and "Every Sunday and Wednesday" for a Wednesday-and-Sunday schedule is the kind of
 * small wrongness that makes somebody stop trusting the rest of the screen.
 */
export function describeSchedule(s: ScheduleLike, locale?: string): string {
  const at = prettyTime(s.time, locale);
  if (s.repeat === 'daily') return `Every day at ${at}`;
  if (s.repeat === 'once') return s.date ? `Once, on ${prettyDate(s.date, locale)} at ${at}` : `Once, at ${at}`;
  const names = weekdayNames(locale);
  const chosen = [...new Set(s.days)].sort((a, b) => a - b).map((d) => names[d]).filter(Boolean);
  if (chosen.length === 0) return `Every week at ${at}`;
  if (chosen.length === 7) return `Every day at ${at}`;
  return `Every ${joinList(chosen, locale)} at ${at}`;
}

/**
 * "Next: Friday, 11:00 am" — or a plain sentence when there will not be a next one.
 *
 * Formatted in the MASJID's zone, which the server sends alongside the schedules. A volunteer
 * checking the panel from another country must be shown when the notice will land on the
 * congregation's phones, not when it will land on theirs.
 */
export function describeNext(nextAt: number | null, timeZone: string, enabled: boolean, locale?: string): string {
  if (!enabled) return 'Paused';
  if (nextAt === null) return 'Nothing more to send';
  try {
    const when = new Intl.DateTimeFormat(locale, {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    }).format(nextAt);
    return `Next: ${when}`;
  } catch {
    return 'Next: soon';
  }
}
