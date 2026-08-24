// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * cache.ts — one value, fetched from somewhere that might not answer.
 *
 * Every upstream this app has is optional at runtime: the platform's appearance and logo, the
 * timetable from Display, the campaign JSON from Donations. All four want the same three
 * behaviours, and writing them a fourth time is how they end up subtly different.
 *
 *  - **A TTL**, so a phone opening the app does not cost a round trip to another container.
 *  - **In-flight dedupe.** Fifty musallis opening the app at Maghrib on a cold cache must
 *    produce ONE upstream call, not fifty. On a Pi running the core, Display and Donations on
 *    the same box, the stampede *is* the outage.
 *  - **Serve-stale-on-error**, which is the whole doctrine of CLAUDE.md §6.5 in one line: an
 *    unreachable upstream degrades a section to slightly old data with an honest marker, and
 *    never to an error page.
 *
 * The loader signals "I could not load; keep what you have" by RETURNING `KEEP` rather than by
 * throwing, because every outbound fetch in this app is written not to throw.
 */

/**
 * What a loader hands back: either a value, or KEEP meaning "I could not reach the upstream,
 * keep what you have".
 *
 * A tagged union rather than a bare sentinel, because T is generic: a sentinel cannot be
 * narrowed out of an arbitrary T without a cast, and `null` is a legitimate VALUE for some of
 * these — a masjid that has set no logo. The two must not collapse into each other.
 */
export type Load<T> = { ok: true; value: T } | { ok: false };

/** The upstream could not be reached. Keep the previous value, however old. */
export const KEEP: Load<never> = { ok: false };

/** The upstream answered. `loaded(null)` is a real answer, and is not KEEP. */
export function loaded<T>(value: T): Load<T> {
  return { ok: true, value };
}

export interface Entry<T> {
  /** undefined = we have NEVER successfully loaded. Distinct from stale, and a different
   *  screen: "not set up yet" versus "here are the times, last updated an hour ago". */
  value: T | undefined;
  /** ms epoch of the last SUCCESSFUL load; 0 = never. This is the age of the DATA, which is
   *  what a staleness marker has to report — not the age of the last attempt. */
  at: number;
  /** True when we hold a value that is past its TTL and the last attempt to refresh it
   *  failed. A caller showing prayer times to a musalli MUST surface this (CLAUDE.md §7). */
  stale: boolean;
}

export class Cached<T> {
  private value: T | undefined;
  /** Last SUCCESSFUL load. Never advanced by a failure. */
  private at = 0;
  /** Last attempt of any kind. Separate from `at` so a failing upstream backs off without
   *  making the data look freshly fetched. */
  private attemptedAt = 0;
  private lastOk = true;
  private inflight: Promise<Entry<T>> | null = null;

  /**
   * @param loader  Fetches the value: `loaded(v)` on success, `KEEP` when unreachable.
   * @param ttlMs   How long a successful value is served without asking again.
   * @param retryMs How long to wait after a FAILURE before trying again. Shorter than the TTL,
   *                because a caller sitting on stale data wants it fixed sooner than a caller
   *                sitting on fresh data wants it refreshed — but never zero, or an upstream
   *                that is down turns every single request into a fresh timeout.
   */
  constructor(
    private readonly loader: () => Promise<Load<T>>,
    private readonly ttlMs: number,
    private readonly retryMs: number = Math.min(ttlMs, 30_000),
  ) {}

  /** The current value, refreshing first if it is due. Never throws. */
  async get(now: number = Date.now()): Promise<Entry<T>> {
    if (!this.isDue(now)) return this.entry(now);
    // One caller does the work; everyone arriving mid-flight awaits the same promise.
    if (!this.inflight) {
      this.inflight = this.load(now).finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  /** The current value with no refresh, however old. For a background job that must not block
   *  on a network call — the push scheduler — and for tests. */
  peek(now: number = Date.now()): Entry<T> {
    return this.entry(now);
  }

  /** Make the next `get` reload. The admin panel's "check again" button. */
  invalidate(): void {
    this.attemptedAt = 0;
  }

  /** Drop everything, including the value. For tests, and for a setting change that makes the
   *  cached value meaningless — the admin picking a different timetable, say. */
  clear(): void {
    this.value = undefined;
    this.at = 0;
    this.attemptedAt = 0;
    this.lastOk = true;
    this.inflight = null;
  }

  private isDue(now: number): boolean {
    if (this.attemptedAt === 0) return true;
    return now - this.attemptedAt >= (this.lastOk ? this.ttlMs : this.retryMs);
  }

  private async load(now: number): Promise<Entry<T>> {
    // A loader is not supposed to throw, but one that does must not take a request with it.
    const result = await this.loader().catch((): Load<T> => KEEP);
    this.attemptedAt = now;
    if (!result.ok) {
      this.lastOk = false;
      return this.entry(now);
    }
    this.value = result.value;
    this.at = now;
    this.lastOk = true;
    return this.entry(now);
  }

  private entry(now: number): Entry<T> {
    return {
      value: this.value,
      at: this.at,
      // "Past its time", not merely "we failed once": a failure a second after a successful
      // load leaves data that is still perfectly current, and marking that stale would train
      // an admin to ignore the marker.
      stale: !this.lastOk && (this.at === 0 || now - this.at >= this.ttlMs),
    };
  }
}
