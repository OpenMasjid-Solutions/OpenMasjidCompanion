// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * schedules.ts — announcements the masjid sets once and forgets.
 *
 * An announcement is already the only thing in this app that reaches a musalli unbidden. A
 * SCHEDULED one does it again every week without anybody deciding to, which makes every guard
 * here load-bearing rather than defensive:
 *
 *  - **The masjid's clock, never the container's.** A schedule is "every Friday at 11:00" in the
 *    masjid's own wall time. The container runs in UTC; a masjid in New York that got a 6am
 *    notification because nobody converted the zone would not report it as a bug, they would
 *    turn notifications off. The IANA zone comes from Display's payload (CLAUDE.md §7) and there
 *    is deliberately no fallback: with no timetable there is no timezone, and a schedule that
 *    cannot know the hour does not fire and says so.
 *  - **Never a backlog.** A box that was off from Thursday to Sunday must not deliver three
 *    days of "reminder: halaqa tonight" the moment it comes back. A missed occurrence is
 *    skipped and marked as passed — the same rule the prayer scheduler follows, for the same
 *    reason: a reminder about something that has already happened is misinformation.
 *  - **Idempotent by construction.** `firedThrough` holds the last occurrence INSTANT that has
 *    been dealt with, so a restart mid-send re-sends at most the current one, and a tick that
 *    runs twice in the same minute sends nothing twice.
 *
 * Note on what is stored: the message TEXT lives on the data volume, which is a first for this
 * app. It is the masjid's own notice to its congregation, not anything about a musalli — no
 * row here refers to a subscription, and the send path reads the audience the same way the
 * manual one does.
 */
import { z } from 'zod';
import { isHhmm, zonedTimeToEpoch } from './zoned';
import { ANNOUNCE_MAX_CHARS } from './push';
import type { Store } from './store';

/**
 * How often.
 *
 * `once` earns its place rather than being a freebie: "Eid prayer is at 8, tell everyone on
 * Thursday evening" is the announcement a masjid most wants to set in advance, and it is the
 * only shape that cannot be approximated by remembering to press a button.
 */
export const REPEATS = ['once', 'daily', 'weekly'] as const;
export type Repeat = (typeof REPEATS)[number];

/** Far more than any masjid needs, and low enough that the list stays a list. */
export const MAX_SCHEDULES = 20;

/**
 * How late an occurrence may be and still be sent.
 *
 * Wider than the prayer scheduler's five minutes, and for a reason: a prayer reminder is about a
 * moment that has now passed, so five minutes late makes it wrong. An announcement is about a
 * fact — the masjid is closed on Saturday — which is just as true twenty minutes later. The cap
 * exists to stop a backlog, not to keep the text accurate.
 */
export const SCHEDULE_GRACE_MS = 20 * 60_000;

export interface Schedule {
  id: number;
  text: string;
  repeat: Repeat;
  /** "HH:mm" in the MASJID's zone. */
  time: string;
  /** For `weekly`: which days, 0 = Sunday. Empty for the other kinds. */
  days: number[];
  /** For `once`: "YYYY-MM-DD" in the masjid's zone. Empty for the other kinds. */
  date: string;
  enabled: boolean;
  createdAt: number;
  lastSentAt: number;
  sentCount: number;
  /** The last occurrence instant already dealt with — sent, or deliberately skipped as too
   *  late. Never "now": a tick at 11:03 that handles the 11:00 occurrence stores 11:00, so the
   *  arithmetic stays about occurrences rather than about when the box happened to wake. */
  firedThrough: number;
}

export const NewScheduleSchema = z
  .object({
    text: z.string().min(1).max(ANNOUNCE_MAX_CHARS * 2),
    repeat: z.enum(REPEATS),
    time: z.string().refine(isHhmm, 'a time must be HH:mm'),
    days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .or(z.literal(''))
      .default(''),
  })
  // Checked here rather than in the route, so the shapes that cannot fire are impossible to
  // store rather than merely unlikely: a weekly schedule with no days chosen and a one-off with
  // no date are both rows that would sit in the list looking armed and never send anything.
  .refine((v) => v.repeat !== 'weekly' || v.days.length > 0, { message: 'a weekly announcement needs at least one day' })
  .refine((v) => v.repeat !== 'once' || v.date !== '', { message: 'a one-off announcement needs a date' });

export type NewSchedule = z.infer<typeof NewScheduleSchema>;

// ── Occurrence arithmetic ────────────────────────────────────────────────────

/** The masjid's calendar date at an instant — "YYYY-MM-DD" as its own wall clock reads it. */
export function localDateIn(at: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '01';
  return `${g('year')}-${g('month')}-${g('day')}`;
}

/** 0 = Sunday. From the DATE STRING, not from a Date in some zone — a calendar date has exactly
 *  one weekday and reading it through a timezone is how that stops being true. */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1)).getUTCDay();
}

/** `date` shifted by whole calendar days. UTC arithmetic on a bare date, which has no DST. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, (m || 1) - 1, d || 1) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Does this schedule fire on this calendar date at all? */
function fallsOn(s: Pick<Schedule, 'repeat' | 'days' | 'date'>, date: string): boolean {
  if (s.repeat === 'once') return s.date === date;
  if (s.repeat === 'daily') return true;
  return s.days.includes(weekdayOf(date));
}

/**
 * The most recent occurrence at or before `now`, or null.
 *
 * Walks back through the masjid's own calendar days rather than doing modular arithmetic on
 * instants, because a day is not always 86,400,000 ms: on the two days a year the clocks move,
 * "every day at 20:00" is 23 or 25 hours after the last one. Eight days back is enough to reach
 * the previous occurrence of any weekly schedule and cheap enough not to think about.
 */
export function previousRun(s: Pick<Schedule, 'repeat' | 'days' | 'date' | 'time'>, now: number, timeZone: string): number | null {
  let date = localDateIn(now, timeZone);
  for (let i = 0; i <= 8; i += 1) {
    if (fallsOn(s, date)) {
      const at = zonedTimeToEpoch(date, s.time, timeZone);
      if (at <= now) return at;
    }
    date = shiftDate(date, -1);
  }
  return null;
}

/** The next occurrence strictly after `now`, or null when there will never be one — a one-off
 *  whose moment has passed. What the admin panel prints as "next". */
export function nextRun(s: Pick<Schedule, 'repeat' | 'days' | 'date' | 'time'>, now: number, timeZone: string): number | null {
  let date = localDateIn(now, timeZone);
  for (let i = 0; i <= 8; i += 1) {
    if (fallsOn(s, date)) {
      const at = zonedTimeToEpoch(date, s.time, timeZone);
      if (at > now) return at;
    }
    date = shiftDate(date, 1);
  }
  return null;
}

/**
 * What this tick should do with one schedule.
 *
 *  - `send`  — an occurrence has come round and is recent enough to be worth delivering.
 *  - `skip`  — one came round while the box was off, or between ticks that were too far apart.
 *              It is marked as dealt with so it never fires late, and never fires at all.
 *  - `null`  — nothing has come round since the last time we looked.
 *
 * Pure, and separate from the sending, because this is the half that is silently wrong when it
 * is wrong: a schedule that fires twice, or an hour early, or three days late, all look like
 * "the notification arrived" from inside the code that sends it.
 */
export function dueAction(
  s: Pick<Schedule, 'repeat' | 'days' | 'date' | 'time' | 'firedThrough'>,
  now: number,
  timeZone: string,
): { action: 'send' | 'skip'; at: number } | null {
  const at = previousRun(s, now, timeZone);
  if (at === null || at <= s.firedThrough) return null;
  return { action: now - at <= SCHEDULE_GRACE_MS ? 'send' : 'skip', at };
}

// ── Storage ──────────────────────────────────────────────────────────────────

interface Row {
  id: number;
  text: string;
  repeat: string;
  time: string;
  days: string;
  date: string;
  enabled: number;
  created_at: number;
  last_sent_at: number;
  sent_count: number;
  fired_through: number;
}

function toSchedule(r: Row): Schedule {
  return {
    id: r.id,
    text: r.text,
    repeat: (REPEATS as readonly string[]).includes(r.repeat) ? (r.repeat as Repeat) : 'once',
    time: r.time,
    // Stored as JSON in one column rather than a join table. Seven booleans about one row is
    // not a relationship, and a `schedule_days` table would be more machinery than the whole
    // feature.
    days: (() => {
      try {
        const v = JSON.parse(r.days) as unknown;
        return Array.isArray(v) ? v.filter((n): n is number => typeof n === 'number') : [];
      } catch {
        return [];
      }
    })(),
    date: r.date,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastSentAt: r.last_sent_at,
    sentCount: r.sent_count,
    firedThrough: r.fired_through,
  };
}

export class Schedules {
  constructor(private readonly store: Store) {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS announce_schedules (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        text          TEXT    NOT NULL,
        repeat        TEXT    NOT NULL,
        time          TEXT    NOT NULL,
        days          TEXT    NOT NULL DEFAULT '[]',
        date          TEXT    NOT NULL DEFAULT '',
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        last_sent_at  INTEGER NOT NULL DEFAULT 0,
        sent_count    INTEGER NOT NULL DEFAULT 0,
        fired_through INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  all(): Schedule[] {
    const rows = this.store.db.prepare('SELECT * FROM announce_schedules ORDER BY id').all() as Row[];
    return rows.map(toSchedule);
  }

  count(): number {
    return (this.store.db.prepare('SELECT COUNT(*) AS c FROM announce_schedules').get() as { c: number }).c;
  }

  /**
   * Add one.
   *
   * `firedThrough` starts at `now`, which is the whole of what stops a new schedule firing the
   * instant it is created: an admin setting "every day at 08:00" at nine in the morning must not
   * be told that this morning's eight o'clock has just come round.
   */
  add(input: NewSchedule, now = Date.now()): { ok: true; schedule: Schedule } | { ok: false; reason: 'full' } {
    if (this.count() >= MAX_SCHEDULES) return { ok: false, reason: 'full' };
    const text = input.text.replace(/\s+/g, ' ').trim();
    const info = this.store.db
      .prepare(
        `INSERT INTO announce_schedules (text, repeat, time, days, date, enabled, created_at, fired_through)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(text, input.repeat, input.time, JSON.stringify(input.days), input.date, now, now);
    const row = this.store.db.prepare('SELECT * FROM announce_schedules WHERE id = ?').get(info.lastInsertRowid) as Row;
    return { ok: true, schedule: toSchedule(row) };
  }

  remove(id: number): void {
    this.store.db.prepare('DELETE FROM announce_schedules WHERE id = ?').run(id);
  }

  /**
   * Pause or resume.
   *
   * Resuming moves `firedThrough` forward to now, for the same reason creating does: coming back
   * from a pause must not deliver whatever came round while it was paused.
   */
  setEnabled(id: number, enabled: boolean, now = Date.now()): void {
    if (enabled) this.store.db.prepare('UPDATE announce_schedules SET enabled = 1, fired_through = ? WHERE id = ?').run(now, id);
    else this.store.db.prepare('UPDATE announce_schedules SET enabled = 0 WHERE id = ?').run(id);
  }

  /** Mark an occurrence as dealt with — whether it was sent or deliberately skipped. */
  markFired(id: number, at: number, sent: boolean): void {
    if (sent) {
      this.store.db
        .prepare('UPDATE announce_schedules SET fired_through = ?, last_sent_at = ?, sent_count = sent_count + 1 WHERE id = ?')
        .run(at, at, id);
    } else {
      this.store.db.prepare('UPDATE announce_schedules SET fired_through = ? WHERE id = ?').run(at, id);
    }
  }

  /** A one-off has nothing left to do once it has been. Disabled rather than deleted, so the
   *  admin can see it went out and when. */
  finishOnce(id: number): void {
    this.store.db.prepare("UPDATE announce_schedules SET enabled = 0 WHERE id = ? AND repeat = 'once'").run(id);
  }
}
