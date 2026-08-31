// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * timetableService.ts — the masjid's chosen timetable: which one, how fresh, and what to say
 * when it cannot be had.
 *
 * The rule the whole file exists to keep: **never show a time this app was not given, and never
 * hide that a time is old.** Those pull in opposite directions — the calm thing to do with a
 * failed refresh is show yesterday's times and say nothing — so the staleness marker is not a
 * nicety, it is the other half of being allowed to serve a cache at all.
 *
 * What is stored on the volume: the chosen timetable **id** (a non-secret) and the last good
 * feed. Nothing from the platform's environment ever lands here (config.ts).
 */
import { Cached, KEEP, loaded } from './cache';
import { type BrokerFailure, raiseAlert } from './fabric';
import { makeLog } from './logger';
import type { Store } from './store';
import { MAX_DAYS, type TimetableFeed, getTimetable, listTimetables } from './timetable';

const log = makeLog('timetable');

const KEY_ID = 'timetable.id';
const KEY_FEED = 'timetable.feed';
const KEY_FEED_AT = 'timetable.feedAt';

/**
 * How much runway to fetch.
 *
 * One day BEHIND today, deliberately: "today" differs by zone, and until the first feed arrives
 * we do not know the masjid's zone — so starting a day early guarantees the masjid's real today
 * is in the window from any zone on earth, at the cost of one extra day. Thirty-five ahead
 * covers the month view and gives the push scheduler runway.
 */
const DAYS_BEHIND = 1;
const DAYS_AHEAD = 35;
const WINDOW_DAYS = Math.min(MAX_DAYS, DAYS_BEHIND + 1 + DAYS_AHEAD);

/** Fresh enough that an Iqamah change made in Display reaches phones within the hour. */
const TTL_MS = 15 * 60_000;
const RETRY_MS = 90_000;

/**
 * How long a masjid's times may be quietly wrong before the admin is told.
 *
 * CLAUDE.md §6.5: once per outage, not once per failure. An alert per failed poll is 96 emails
 * a day, which is a way of not being told anything.
 */
const OUTAGE_ALERT_AFTER_MS = 6 * 60 * 60_000;

/** The date, YYYY-MM-DD, in a given IANA zone. Never the container's own date: at 23:00 in
 *  New York the container's UTC date is already tomorrow, and a window computed from it would
 *  start on the wrong day. */
export function dateInZone(at: Date, timeZone: string): string {
  try {
    // 'en-CA' formats as YYYY-MM-DD, which saves reassembling parts by hand.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }
}

/** Shift a YYYY-MM-DD by whole days. Pure calendar arithmetic on a date with no clock, so it
 *  cannot be pushed onto the wrong day by an offset. */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

export interface TimetableState {
  /** The id the admin picked, or '' when they have not yet. */
  id: string;
  /** The last good feed, or null when we have never had one. */
  feed: TimetableFeed | null;
  /** ms epoch of the last SUCCESSFUL fetch; 0 = never. */
  at: number;
  /** True when the data is past its TTL and the last refresh failed. */
  stale: boolean;
  /** Why the last attempt failed, for the admin panel. null when the last attempt worked. */
  failure: BrokerFailure | null;
}

export class TimetableService {
  private readonly cache: Cached<TimetableFeed>;
  private failure: BrokerFailure | null = null;
  private failingSince = 0;
  private alertedThisOutage = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly store: Store) {
    this.cache = new Cached<TimetableFeed>((now) => this.fetchWindow(now), TTL_MS, RETRY_MS);
    // Re-hydrate the last good feed so a restart does not blank a masjid's prayer times while
    // it waits for the first poll. This is the ONE thing worth persisting: it is Display's
    // answer, not the platform's configuration.
    const saved = this.store.getJson<TimetableFeed | null>(KEY_FEED, null);
    const savedAt = Number(this.store.get(KEY_FEED_AT) ?? 0);
    if (saved && savedAt) this.cache.seed(saved, savedAt);
  }

  /** The timetable the admin chose. '' before they have. */
  get chosenId(): string {
    return this.store.get(KEY_ID) ?? '';
  }

  /**
   * Choose a timetable. Clears everything cached for the previous one FIRST — leaving the old
   * hall's times on screen while the new ones load is the one moment this app could show a
   * genuinely wrong time to a real person.
   */
  setChosen(id: string): void {
    if (id === this.chosenId) return;
    this.store.set(KEY_ID, id);
    this.store.del(KEY_FEED);
    this.store.del(KEY_FEED_AT);
    this.cache.clear();
    this.failure = null;
    this.failingSince = 0;
    this.alertedThisOutage = false;
    log.info(`timetable set to ${id || '(none)'}`);
  }

  /** Ask Display for the current window, honouring the cache. */
  async get(now = Date.now()): Promise<TimetableState> {
    if (!this.chosenId) return { id: '', feed: null, at: 0, stale: false, failure: null };
    const entry = await this.cache.get(now);
    return { id: this.chosenId, feed: entry.value ?? null, at: entry.at, stale: entry.stale, failure: this.failure };
  }

  /** What we already hold, with no network call. For a background job and for tests. */
  peek(now = Date.now()): TimetableState {
    const entry = this.cache.peek(now);
    return { id: this.chosenId, feed: entry.value ?? null, at: entry.at, stale: entry.stale, failure: this.failure };
  }

  /** Force the next `get` to go to Display. The admin panel's "refresh now". */
  async refresh(now = Date.now()): Promise<TimetableState> {
    this.cache.invalidate();
    return this.get(now);
  }

  /** The picker's list. Not cached — it is read once, by one admin, on one screen. */
  async list() {
    return listTimetables();
  }

  /**
   * One window fetch, plus the outage bookkeeping.
   *
   * Returns KEEP on any failure, so `Cached` holds the previous feed rather than blanking the
   * page — see the file header.
   */
  private async fetchWindow(now: number) {
    const id = this.chosenId;
    if (!id) return KEEP;

    // Ask in the MASJID's calendar. Before the first feed we do not know the zone, so UTC and
    // the day of margin above cover it.
    const zone = this.cache.peek(now).value?.timezone ?? 'UTC';
    const from = shiftDate(dateInZone(new Date(now), zone), -DAYS_BEHIND);

    const res = await getTimetable(id, from, WINDOW_DAYS);
    if (!res.ok) {
      await this.noteFailure(res.failure, now);
      return KEEP;
    }
    if (res.data.id !== id) {
      // Display answered about a different timetable. Never seen, and never to be trusted:
      // rendering it would put another hall's times under this masjid's name.
      log.warn(`Display answered for "${res.data.id}" when asked for "${id}" — refusing it`);
      await this.noteFailure({ code: 'wrong_timetable', retryable: false, admin: 'OpenMasjid Display answered about a different timetable than the one selected. Please choose it again.' }, now);
      return KEEP;
    }

    this.noteSuccess(res.data, now);
    return loaded(res.data);
  }

  private noteSuccess(feed: TimetableFeed, now: number): void {
    if (this.failingSince) log.info('prayer times are being read from OpenMasjid Display again');
    this.failure = null;
    this.failingSince = 0;
    this.alertedThisOutage = false;
    this.store.setJson(KEY_FEED, feed);
    this.store.set(KEY_FEED_AT, String(now));
  }

  private async noteFailure(failure: BrokerFailure, now: number): Promise<void> {
    this.failure = failure;
    if (!this.failingSince) {
      this.failingSince = now;
      log.warn(`could not read the timetable from Display: ${failure.code}`);
    }
    // Awaited, not fired and forgotten. `raiseAlert` has its own timeout and never throws, so
    // this costs a few seconds on the ONE poll that crosses the threshold — and in exchange the
    // alert is actually sent before the refresh that noticed the outage is considered finished,
    // rather than racing it.
    await this.maybeAlert(now);
  }

  /**
   * Tell the admin, once, when this has been broken long enough to matter.
   *
   * Gated on actually having served something: a masjid that has never had a feed sees the
   * honest "not set up yet" page, which is not an outage and not something to email about.
   */
  private async maybeAlert(now: number): Promise<void> {
    if (this.alertedThisOutage) return;
    if (!this.failingSince || now - this.failingSince < OUTAGE_ALERT_AFTER_MS) return;
    if (!this.cache.peek(now).value) return;

    this.alertedThisOutage = true;
    const hours = Math.round((now - this.failingSince) / 3_600_000);
    const result = await raiseAlert(
      'timetable-unavailable',
      `Companion has not been able to read your prayer times from OpenMasjid Display for about ${hours} hours. ` +
        `Musallis are being shown the last times it received, marked as out of date. ${this.failure?.admin ?? ''}`.trim(),
    );
    log.warn(`timetable-unavailable alert: ${result}`);
  }

  /** Keep the window fresh in the background, so a phone opening the app reads a warm cache
   *  instead of waiting on a broker round trip. */
  start(): void {
    if (this.timer) return;
    void this.get();
    this.timer = setInterval(() => void this.get(), TTL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
