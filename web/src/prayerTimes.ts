// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Turning Display's timetable into what a musalli sees: which prayer is on now, which is next,
 * and how long there is.
 *
 * **Nothing here calculates a prayer time** (CLAUDE.md §2). Every clock time in this file
 * arrives from Display as "HH:mm" and is only ever placed on a timeline, formatted, or
 * compared. What is derived is *which of Display's times is next*, which is arithmetic on
 * values it gave us.
 *
 * The one genuinely hard part is placing a wall-clock time in the masjid's zone onto a real
 * instant. Date + "HH:mm" + an IANA zone is NOT a fixed offset: it moves twice a year in most
 * of the world, and the app is used by people in one zone reading a masjid's times in another.
 * Everything below goes through `zonedTimeToEpoch`, and it is tested against real DST
 * transitions — CLAUDE.md §14 makes that non-negotiable, and the failure mode is a countdown
 * that is silently an hour out for half the year.
 */

export type SlotKey = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha' | 'jumuah';

export interface Prayer {
  adhan: string | null;
  iqamah: string | null;
}

export interface Jumuah {
  label: string;
  adhan: string | null;
  iqamah: string;
}

export interface Day {
  date: string;
  hijri: { label: string };
  sunrise: string | null;
  prayers: Record<'fajr' | 'dhuhr' | 'asr' | 'maghrib' | 'isha', Prayer>;
  jumuah: Jumuah[];
}

export interface Masjid {
  name: string;
  timezone: string;
  language: string;
  hourCycle: '12' | '24';
}

/** One row on the timetable. */
export interface Slot {
  key: SlotKey;
  label: string;
  adhan: string | null;
  iqamah: string | null;
  /** Shurūq is a sun event, not a jamā'ah: no Iqamah, and shown differently. */
  sunEvent?: true;
}

// ── Placing a wall-clock time on the timeline ────────────────────────────────

/**
 * How far `timeZone` is from UTC at a given instant, in ms (east positive).
 *
 * Asks Intl what the local wall clock reads at that instant and measures the difference. This
 * is the only way to get it right: the offset is a property of the INSTANT, not of the zone —
 * New York is −5 in January and −4 in July, and a great many places are not whole hours.
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
 * *naive* instant; on the two days a year the clocks move, that can be the wrong side of the
 * transition, and the result is out by an hour. The second pass re-reads the offset at the
 * corrected instant and applies it.
 *
 * Times inside a spring-forward gap (a wall clock reading that never happens) resolve to the
 * instant the clock jumps to, which is the only sensible answer and matches what every calendar
 * does. Display would not normally emit one — its own engine computes in the same zone.
 */
export function zonedTimeToEpoch(date: string, hhmm: string, timeZone: string): number {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const naive = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0);
  const first = naive - tzOffsetMs(naive, timeZone);
  const second = naive - tzOffsetMs(first, timeZone);
  return second;
}

/** The date, YYYY-MM-DD, as it reads in the masjid's zone right now. Never the device's date:
 *  at 23:00 in New York a phone in Sydney is already two days ahead. */
export function todayInZone(now: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// ── The rows ─────────────────────────────────────────────────────────────────

const NAMES: Record<Exclude<SlotKey, 'jumuah'>, string> = {
  fajr: 'Fajr',
  sunrise: 'Sunrise',
  dhuhr: 'Dhuhr',
  asr: 'Asr',
  maghrib: 'Maghrib',
  isha: 'Isha',
};

/**
 * The rows for one day, in the order they happen.
 *
 * **On a Friday, Jumu'ah takes Dhuhr's place** rather than sitting beside it: a masjid does not
 * hold both, and a timetable listing a Dhuhr jamā'ah on a Friday would send someone to a prayer
 * that is not happening. Its Adhan comes from that day's `prayers.dhuhr.adhan`, because Display
 * has no per-Jumu'ah Adhan field at all and always sends null (work order divergence 1). More
 * than one Jumu'ah is normal in a busy masjid and each gets its own row.
 *
 * `jumuah` is `[]` on every non-Friday and is never carried forward — asserting a jamā'ah on a
 * Tuesday would be worse than showing nothing.
 */
export function slotsFor(day: Day): Slot[] {
  const p = day.prayers;
  const out: Slot[] = [{ key: 'fajr', label: NAMES.fajr, ...p.fajr }];

  if (day.sunrise) out.push({ key: 'sunrise', label: NAMES.sunrise, adhan: day.sunrise, iqamah: null, sunEvent: true });

  if (day.jumuah.length > 0) {
    day.jumuah.forEach((j, i) => {
      out.push({
        key: 'jumuah',
        // Display's own label, which the masjid may have set to "1st Jumu'ah" etc. Numbered
        // only when there is more than one and the masjid did not already distinguish them.
        label: j.label || (day.jumuah.length > 1 ? `Jumu'ah ${i + 1}` : "Jumu'ah"),
        adhan: p.dhuhr.adhan,
        iqamah: j.iqamah,
      });
    });
  } else {
    out.push({ key: 'dhuhr', label: NAMES.dhuhr, ...p.dhuhr });
  }

  out.push({ key: 'asr', label: NAMES.asr, ...p.asr });
  out.push({ key: 'maghrib', label: NAMES.maghrib, ...p.maghrib });
  out.push({ key: 'isha', label: NAMES.isha, ...p.isha });
  return out;
}

// ── Where we are in the day ──────────────────────────────────────────────────

/**
 * The time a row actually OCCUPIES on the timeline.
 *
 * For the five daily prayers that is the Adhan: the prayer comes in, and the jamā'ah follows.
 * For **Jumu'ah it is the jamā'ah time**, and it has to be — Display has no per-Jumu'ah Adhan
 * field at all, so every Jumu'ah on a Friday borrows that day's single Dhuhr Adhan. Placing
 * them by that shared value puts two or three jamā'āt on the same instant: they highlight
 * together, and the countdown skips straight past the first one to name the last. A musalli
 * looking at a masjid with a 1:15 and a 2:15 jamā'ah needs to know which one is next.
 *
 * Exported so the row renderer places a row exactly where the timeline does — two functions
 * disagreeing about this is precisely how a highlight lands on the wrong line.
 */
export function slotTime(slot: Slot): string | null {
  return slot.key === 'jumuah' ? (slot.iqamah ?? slot.adhan) : slot.adhan;
}

export interface Moment {
  key: SlotKey;
  label: string;
  /** The instant its Adhan (or, for Shurūq, the sun event) occurs. */
  at: number;
  slot: Slot;
  /** Which day's row this came from, so the view can tell today from tomorrow. */
  date: string;
}

/** Every row across the given days, as instants, in order. Rows with no Adhan time are skipped:
 *  a row we cannot place on the timeline cannot be "current" or "next", though it is still
 *  rendered in the table. */
export function momentsFor(days: Day[], timeZone: string): Moment[] {
  const out: Moment[] = [];
  for (const day of days) {
    for (const slot of slotsFor(day)) {
      const hhmm = slotTime(slot);
      if (!hhmm) continue;
      out.push({ key: slot.key, label: slot.label, at: zonedTimeToEpoch(day.date, hhmm, timeZone), slot, date: day.date });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

export interface Position {
  /** The prayer that has most recently come in, or null before the first of the window. */
  current: Moment | null;
  /** The next one due, or null if the window runs out. */
  next: Moment | null;
  /** ms until `next`, never negative. */
  until: number;
  /**
   * What to call the period we are in.
   *
   * "Duha" is the stretch between Shurūq and Zawāl and is what the reference design shows
   * there — naming it is a label for the gap between two of DISPLAY's own times, not a
   * computation of anything.
   */
  label: string;
}

/**
 * Where we are right now.
 *
 * Needs more than today's rows: after Isha the next prayer is tomorrow's Fajr, and before
 * Fajr the current period is yesterday's Isha. That is exactly why the server fetches a window
 * starting a day early and running a month ahead rather than a single day.
 */
export function positionAt(days: Day[], timeZone: string, now: number): Position {
  const moments = momentsFor(days, timeZone);
  let current: Moment | null = null;
  let next: Moment | null = null;
  for (const m of moments) {
    if (m.at <= now) current = m;
    else {
      next = m;
      break;
    }
  }
  return {
    current,
    next,
    until: next ? Math.max(0, next.at - now) : 0,
    label: current ? (current.key === 'sunrise' ? 'Duha' : current.label) : (next?.label ?? ''),
  };
}

// ── Formatting ───────────────────────────────────────────────────────────────

/**
 * "19:42" → "7:42 pm" or "19:42", following the TIMETABLE's own hourCycle.
 *
 * The masjid's setting, not the phone's: the times on a musalli's screen should read the way
 * they read on the wall inside the building. Formatted from a fixed reference date so no
 * timezone or DST can move it — this is presentation of a wall-clock string, not a conversion.
 */
export function formatTime(hhmm: string | null, hourCycle: '12' | '24', language = 'en'): string {
  if (!hhmm) return '—';
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return '—';
  const d = new Date(Date.UTC(2000, 0, 1, h, m));
  try {
    return new Intl.DateTimeFormat(language || 'en', {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: '2-digit',
      hourCycle: hourCycle === '24' ? 'h23' : 'h12',
    }).format(d);
  } catch {
    return hhmm;
  }
}

/** "1 hr 1 min", "12 min", "<1 min" — the calm line under the current prayer. Deliberately not
 *  seconds: a countdown ticking every second on a prayer times page is agitating, and to the
 *  minute is what anyone actually needs. */
export function formatUntil(ms: number): string {
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'less than a minute';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} hr`;
  return `${h} hr ${m} min`;
}

/** "Monday 24 August", in the masjid's own language. */
export function formatDate(date: string, language = 'en'): string {
  const [y, m, d] = date.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(language || 'en', {
      timeZone: 'UTC',
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(Date.UTC(y, m - 1, d)));
  } catch {
    return date;
  }
}

// ── Which part of the day we are in ──────────────────────────────────────────

/**
 * The six periods the page themes itself by.
 *
 * A PERIOD is not a prayer: it is the stretch of day that a prayer opens. `sunrise` is the
 * stretch between Shurūq and Zawāl, which the page calls Duha, and `isha` runs through the night
 * to Fajr. Jumu'ah sits inside the dhuhr period rather than being one of its own — the sky at
 * one o'clock on a Friday is the sky at one o'clock.
 */
export type PeriodKey = 'fajr' | 'sunrise' | 'dhuhr' | 'asr' | 'maghrib' | 'isha';

const PERIOD_OF: Record<SlotKey, PeriodKey> = {
  fajr: 'fajr',
  sunrise: 'sunrise',
  dhuhr: 'dhuhr',
  jumuah: 'dhuhr',
  asr: 'asr',
  maghrib: 'maghrib',
  isha: 'isha',
};

/**
 * The period a moment belongs to, or `isha` when nothing has come in yet.
 *
 * The fallback matters more than it looks. Before the first prayer in the window there is no
 * "current" moment at all — which happens on a fresh install between midnight and Fajr, and any
 * time the window's first day is today. Night is the truthful answer then, and it is also the
 * one that does not flash a bright white page at somebody at four in the morning.
 */
export function periodOf(position: Position): PeriodKey {
  return position.current ? PERIOD_OF[position.current.key] : 'isha';
}

// ── Iqamah changes ───────────────────────────────────────────────────────────

/**
 * Only the five daily jamā'āt, deliberately.
 *
 * Jumu'ah is sent on Fridays and only on Fridays, so folding it in would make every Friday a
 * change (it appeared) and every Saturday a change (it went away) — fifty-two false marks a
 * year, which would make the whole feature worthless.
 */
function iqamahSignature(day: Day): string {
  return (['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const).map((k) => day.prayers[k].iqamah ?? '').join('|');
}

/**
 * The days on which the masjid's jamā'ah times change.
 *
 * Adhan times move a minute or two every single day because they are astronomical; jamā'ah times
 * do not. A committee sets them, they hold for a week or two, and then they are revised — and
 * the day they are revised is the one thing on a month of prayer times that somebody actually
 * needs to spot, because it is the day they will otherwise turn up at the wrong time.
 *
 * The first day of the window is never marked: there is nothing before it to have changed from.
 */
export function iqamahChanges(days: Day[]): Set<string> {
  const out = new Set<string>();
  let previous: string | null = null;
  for (const day of days) {
    const signature = iqamahSignature(day);
    if (previous !== null && signature !== previous) out.add(day.date);
    previous = signature;
  }
  return out;
}

/** Which prayers changed on a given day, for the tooltip on a marked date. */
export function changedPrayers(days: Day[], date: string, hourCycle: '12' | '24', language = 'en'): string[] {
  const i = days.findIndex((d) => d.date === date);
  if (i <= 0) return [];
  const before = days[i - 1].prayers;
  const after = days[i].prayers;
  const names: Record<string, string> = { fajr: 'Fajr', dhuhr: 'Dhuhr', asr: 'Asr', maghrib: 'Maghrib', isha: 'Isha' };
  return (['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'] as const)
    .filter((k) => (before[k].iqamah ?? '') !== (after[k].iqamah ?? ''))
    .map((k) => `${names[k]} ${formatTime(before[k].iqamah, hourCycle, language)} → ${formatTime(after[k].iqamah, hourCycle, language)}`);
}

// ── The month grid ───────────────────────────────────────────────────────────

/** One cell of the calendar. `date` is null for the padding before the 1st and after the last. */
export interface MonthCell {
  date: string | null;
  dayOfMonth: number;
}

/**
 * Which weekday a week starts on, for a given language.
 *
 * Sunday in the United States, Monday across most of Europe, Saturday in much of the Arab world
 * — and a masjid's calendar reading wrong for its own congregation is the kind of small thing
 * that makes an app feel foreign. `Intl.Locale.weekInfo` knows; where it is unavailable this
 * falls back to Sunday rather than guessing.
 *
 * Returns 0-6 with 0 = Sunday, which is what `Date.getUTCDay()` speaks.
 */
export function weekStartsOn(language: string): number {
  try {
    const info = (new Intl.Locale(language || 'en') as unknown as { weekInfo?: { firstDay?: number } }).weekInfo;
    // weekInfo counts 1 = Monday … 7 = Sunday.
    if (info && typeof info.firstDay === 'number') return info.firstDay % 7;
  } catch {
    /* an unknown language, or a runtime without weekInfo */
  }
  return 0;
}

/** Days in a month, without constructing a local-time Date (which could land on the wrong day
 *  in a zone behind UTC). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * A calendar grid for the month containing `date`, padded to whole weeks.
 *
 * Built from plain UTC calendar arithmetic and formatted as YYYY-MM-DD strings — never from a
 * local-time `Date`, which in a zone behind UTC can put the 1st of the month on the previous
 * day and shift the entire grid by one column.
 */
export function monthGrid(date: string, language = 'en'): MonthCell[][] {
  const [year, month] = date.split('-').map(Number);
  const m = month - 1;
  const first = new Date(Date.UTC(year, m, 1)).getUTCDay();
  const start = weekStartsOn(language);
  const lead = (first - start + 7) % 7;
  const total = daysInMonth(year, m);

  const cells: MonthCell[] = [];
  for (let i = 0; i < lead; i += 1) cells.push({ date: null, dayOfMonth: 0 });
  for (let d = 1; d <= total; d += 1) {
    cells.push({ date: `${year}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, dayOfMonth: d });
  }
  while (cells.length % 7 !== 0) cells.push({ date: null, dayOfMonth: 0 });

  const weeks: MonthCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Short weekday initials in the right order for a locale, for the grid's header row. */
export function weekdayLabels(language = 'en'): string[] {
  const start = weekStartsOn(language);
  const fmt = new Intl.DateTimeFormat(language || 'en', { timeZone: 'UTC', weekday: 'short' });
  return Array.from({ length: 7 }, (_, i) => {
    // 2024-01-07 was a Sunday, so this walks a real week from a known Sunday.
    const d = new Date(Date.UTC(2024, 0, 7 + ((start + i) % 7)));
    return fmt.format(d).slice(0, 2);
  });
}

/** "August 2026", in the masjid's own language. */
export function formatMonth(date: string, language = 'en'): string {
  const [y, m] = date.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat(language || 'en', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(
      new Date(Date.UTC(y, m - 1, 1)),
    );
  } catch {
    return date.slice(0, 7);
  }
}
