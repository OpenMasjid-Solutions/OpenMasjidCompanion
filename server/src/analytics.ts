// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * analytics.ts — how many phones, of what kind. Never whose.
 *
 * CLAUDE.md §4 put "analytics beyond a plain count of push subscriptions" out of scope for v1,
 * and Hasan asked for this on 2026-08-29. The line was there to stop this app growing a visitor
 * log, and that reason has not gone away — so what is built is the shape that answers a masjid's
 * question without one ever existing.
 *
 * **THE ENTIRE SCHEMA IS A COUNTER.** One row per (day, device, browser, mode), holding a
 * number. There is no row per visit, no session, no id, no IP, no user agent, no path, and no
 * timestamp finer than the date — so there is nothing in this table that could be joined against
 * anything, by us or by whoever ends up holding a backup of the volume. "How many iPhones opened
 * this in September" is answerable. "Did Yusuf open it" is not, and cannot be made to be without
 * adding a column, which is a thing a reviewer can see.
 *
 * The three values are ENUMS, checked against fixed lists that are duplicated in
 * `web/src/platform.ts` and asserted equal by `analytics.test.ts`. That matters more than it
 * looks: an open TEXT column reachable from an unauthenticated endpoint is a place to write
 * whatever you like, and this one is rendered in an admin panel.
 */
import { z } from 'zod';
import type { Store } from './store';

/**
 * The coarse device split a masjid actually cares about — is our congregation on iPhones or on
 * Android, and does anybody use this on a computer.
 *
 * Kept deliberately coarse. "Windows vs macOS vs Linux" changes nothing a masjid would do,
 * where "iPhone vs Android" decides which half of the poster's instructions matter.
 */
export const DEVICES = ['ios', 'android', 'desktop', 'other'] as const;
export type Device = (typeof DEVICES)[number];

export const BROWSERS = ['safari', 'chrome', 'edge', 'firefox', 'samsung', 'opera', 'inapp', 'other'] as const;
export type Browser = (typeof BROWSERS)[number];

/** Installed on the home screen, or read in a browser tab. The single most useful number on the
 *  admin's screen: it is whether the poster worked. */
export const MODES = ['standalone', 'browser'] as const;
export type Mode = (typeof MODES)[number];

export const VisitSchema = z.object({
  device: z.enum(DEVICES),
  browser: z.enum(BROWSERS),
  mode: z.enum(MODES),
});
export type Visit = z.infer<typeof VisitSchema>;

/**
 * How long a day's counters are kept.
 *
 * A year would let a masjid see last Ramadan, and it would also be a year of retained data for
 * a question nobody asks twice. Ninety days covers "since we put the poster up" and a season,
 * and then it is gone — which for something collected without asking anybody is the right
 * default. The pruning is unconditional and happens on writes, so it cannot be forgotten.
 */
export const KEEP_DAYS = 90;

/** The window the admin panel reports on. Long enough that a masjid's quiet week does not read
 *  as a collapse; short enough that it describes now rather than the spring. */
export const WINDOW_DAYS = 30;

/** A UTC date stamp. The counters are buckets, not prayer times — a masjid's own timezone would
 *  buy nothing here and would silently change meaning if Display's timezone changed. */
export function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

export interface Breakdown {
  /** Rows are `{ key, count }`, biggest first, so the panel renders bars without sorting. */
  devices: { key: Device; count: number }[];
  browsers: { key: Browser; count: number }[];
  /** Installed vs in a browser tab, over the same window. */
  modes: { key: Mode; count: number }[];
  /** Every count in the window, so a percentage can be worked out without re-summing. */
  total: number;
  /** How many days of counters exist at all, so the panel can say "we have only just started
   *  counting" rather than presenting two days as a trend. */
  days: number;
  windowDays: number;
}

export class Analytics {
  constructor(private readonly store: Store) {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS visits (
        day     TEXT    NOT NULL,
        device  TEXT    NOT NULL,
        browser TEXT    NOT NULL,
        mode    TEXT    NOT NULL,
        n       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, device, browser, mode)
      ) WITHOUT ROWID;
    `);
  }

  /**
   * Add one.
   *
   * The client only reports a browser once a day (web/src/telemetry.ts), so a count is roughly
   * "browsers that opened the app", not "page loads". Roughly is the honest word and the admin
   * panel uses it: a cleared cache counts twice, and a shared phone counts once.
   */
  record(v: Visit, at = Date.now()): void {
    this.store.db
      .prepare(
        `INSERT INTO visits (day, device, browser, mode, n) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(day, device, browser, mode) DO UPDATE SET n = n + 1`,
      )
      .run(dayOf(at), v.device, v.browser, v.mode);
    this.prune(at);
  }

  /** Drop anything past the retention window. Cheap — the table has at most a few rows a day —
   *  and unconditional, so retention is a property of writing rather than of remembering to. */
  prune(at = Date.now()): void {
    const cutoff = dayOf(at - KEEP_DAYS * 86_400_000);
    this.store.db.prepare('DELETE FROM visits WHERE day < ?').run(cutoff);
  }

  /**
   * One column's totals over the window, biggest first.
   *
   * The column name is INTERPOLATED, which is the shape of an injection and is not one: the
   * parameter is a union of three string literals, so a typechecked caller cannot pass anything
   * else, and the runtime check below closes the gap for a caller that is not typechecked. SQLite
   * has no way to bind an identifier, so this or three near-identical statements is the choice.
   * The only value that reaches the query as data is `since`, and that is bound.
   */
  private tally<K extends string>(column: 'device' | 'browser' | 'mode', since: string): { key: K; count: number }[] {
    if (column !== 'device' && column !== 'browser' && column !== 'mode') throw new Error('not a column of this table');
    return this.store.db
      .prepare(`SELECT ${column} AS key, SUM(n) AS count FROM visits WHERE day >= ? GROUP BY ${column} ORDER BY count DESC`)
      .all(since) as { key: K; count: number }[];
  }

  /** Everything the admin panel shows, in one read. */
  breakdown(at = Date.now()): Breakdown {
    const since = dayOf(at - (WINDOW_DAYS - 1) * 86_400_000);
    const devices = this.tally<Device>('device', since);
    const total = devices.reduce((sum, r) => sum + r.count, 0);
    const days = (this.store.db.prepare('SELECT COUNT(DISTINCT day) AS d FROM visits WHERE day >= ?').get(since) as { d: number }).d;
    return {
      devices,
      browsers: this.tally<Browser>('browser', since),
      modes: this.tally<Mode>('mode', since),
      total,
      days,
      windowDays: WINDOW_DAYS,
    };
  }
}
