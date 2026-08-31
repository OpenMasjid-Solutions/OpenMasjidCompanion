// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * rateLimit.ts — two small in-memory limiters.
 *
 * Both are keyed on the real TCP peer, never `req.ip`: `trustProxy` is off precisely because
 * this container is port-mapped directly, so an `X-Forwarded-For` a client set itself must
 * never become a limiter key — that would make both of these bypassable with a header.
 */

// ── Failed-login backoff ──────────────────────────────────────────────────────

interface Entry {
  fails: number;
  lockedUntil: number;
  /** When we last saw a failure from this peer — what the sweep ages entries out on. */
  seen: number;
}

const MAX_FREE = 5; // attempts before backoff starts
const BASE_MS = 2000; // first lockout step
const MAX_MS = 5 * 60 * 1000; // cap one lockout at 5 minutes
/** Forget a peer that has not failed for this long. Far longer than the longest single
 *  lockout, so ageing an entry out can never shorten a live one. */
const IDLE_MS = 60 * 60 * 1000;

/**
 * Exponential backoff on failed admin logins. This is the real defence behind a password a
 * volunteer chose — without it, a short password is trivially brute-forced over the LAN, and
 * this app is also published on a public hostname through the tunnel.
 */
export class LoginLimiter {
  private readonly map = new Map<string, Entry>();

  constructor() {
    const sweep = setInterval(() => this.sweep(), 10 * 60 * 1000);
    // unref so an idle timer never holds the process open on shutdown.
    sweep.unref?.();
  }

  /**
   * Drop peers that are not currently locked out and have not failed for an hour.
   *
   * BOTH conditions matter. `lockedUntil <= now` means an entry is never evicted mid-lockout —
   * evicting one would hand an attacker a fresh allowance on every sweep, which is a
   * rate-limit bypass hiding inside a memory fix. The `seen` ageing means an admin who
   * mistyped twice last month is not remembered for ever.
   */
  private sweep(now = Date.now()): void {
    for (const [k, e] of this.map) {
      if (e.lockedUntil <= now && now - e.seen > IDLE_MS) this.map.delete(k);
    }
  }

  /** Entries currently held. Exposed for the regression test that pins the sweep. */
  size(): number {
    return this.map.size;
  }

  /** Run the sweep now, with an injectable clock (tests; the interval uses the real one). */
  sweepNow(now = Date.now()): void {
    this.sweep(now);
  }

  /** ms the caller must wait before another attempt (0 = allowed now). */
  retryAfterMs(peer: string, now = Date.now()): number {
    const e = this.map.get(peer);
    if (!e) return 0;
    const left = e.lockedUntil - now;
    return left > 0 ? left : 0;
  }

  fail(peer: string, now = Date.now()): void {
    const e = this.map.get(peer) ?? { fails: 0, lockedUntil: 0, seen: 0 };
    e.seen = now;
    e.fails += 1;
    if (e.fails > MAX_FREE) {
      e.lockedUntil = now + Math.min(MAX_MS, BASE_MS * 2 ** (e.fails - MAX_FREE - 1));
    }
    this.map.set(peer, e);
  }

  succeed(peer: string): void {
    this.map.delete(peer);
  }
}

// ── Per-minute request cap ────────────────────────────────────────────────────

/**
 * A fixed-window per-minute cap, for unauthenticated routes that cost something REAL —
 * specifically the ones that make an outbound call to the OpenMasjidOS core on every request.
 *
 * Without a cap those routes turn this container into an unmetered amplifier against the
 * platform, and each call also occupies one of a Pi's sockets for several seconds. The cap is
 * set far above any real page load, so it can never get in the way of the thing it protects.
 */
export function makeRateLimiter(perMinute: number, windowMs = 60_000) {
  const hits = new Map<string, { c: number; reset: number }>();
  return (peer: string, now = Date.now()): boolean => {
    // Bounded: an attacker cycling source addresses must not grow this without limit.
    if (hits.size > 5000) for (const [k, w] of hits) if (w.reset <= now) hits.delete(k);
    const w = hits.get(peer);
    if (!w || w.reset <= now) {
      hits.set(peer, { c: 1, reset: now + windowMs });
      return true;
    }
    if (w.c >= perMinute) return false;
    w.c += 1;
    return true;
  };
}
