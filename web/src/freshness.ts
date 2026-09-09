// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * freshness.ts — whether the times on screen came from the masjid, or from this phone.
 *
 * WHY THIS EXISTS. The app caches the timetable so a musalli in a basement prayer hall with no
 * signal still sees times (§10). That is right. What was missing is that the reader could not
 * tell the difference, and the difference is the whole of the risk: a masjid moves Iqamah, a
 * phone opens the app three days later with no signal, and the old time is shown with exactly
 * the same confidence as a live one. Somebody prays at the wrong time and has no way of knowing
 * they were reading a copy.
 *
 * TWO DIFFERENT STALENESSES, and conflating them is what hid this. The payload's own `stale`
 * flag is about the SERVER: our box could not reach OpenMasjid Display. It is computed on the
 * server, so it describes the server's health at the moment the response was WRITTEN — which
 * means a response cached by a phone while everything was healthy says `stale: false` for ever,
 * however old the phone's copy becomes. The second staleness — this file — is about the PHONE:
 * did this device just reach the masjid, or is it drawing its own saved copy? Only the phone can
 * answer that, so the answer is computed here and never trusted from the body.
 *
 * The functions are pure and take everything as arguments so they can be tested without a
 * browser: the failure being prevented is silent by construction, so the logic that prevents it
 * must not itself be untestable.
 */

/** What the service worker told us about where this body came from — see `sw.tmpl`. */
export interface FeedMeta {
  /** Served out of this phone's cache because the network could not be reached in time. */
  fromCache: boolean;
  /** When this phone stored it, ms epoch. 0 when unknown (an entry from an older build). */
  cachedAt: number;
}

export type NoticeKind = 'offline' | 'unreachable';

export interface Notice {
  kind: NoticeKind;
  /** ms epoch to show the reader, already chosen between the phone's and the server's clock. */
  at: number;
}

/**
 * Should the reader be told that these times are a saved copy — and why?
 *
 * `null` means the times came from the masjid just now and need no caveat. Anything else is
 * shown, always: there is no threshold below which serving an unlabelled copy becomes honest,
 * because the reader cannot see how old it is unless we say so. A copy two minutes old is not
 * alarming *because the timestamp says two minutes*, which is the proportionality doing its job
 * — not a reason to hide the notice.
 *
 * `online` separates the two causes, which want different words. "You are offline" is
 * actionable and familiar; it is also wrong, and quietly confusing, when the phone has four bars
 * and it is the masjid's box that is off.
 */
export function noticeFor(meta: FeedMeta | null, serverAt: number, online: boolean): Notice | null {
  if (!meta || !meta.fromCache) return null;
  return {
    kind: online ? 'unreachable' : 'offline',
    // The phone's own stamp is the honest one: it answers "how old is what I am looking at".
    // `serverAt` is when the SERVER last read Display, which for a cached body is frozen at
    // whatever it was when the copy was taken — close, but a different question, and only a
    // fallback for an entry stored before the phone started stamping them.
    at: meta.cachedAt || serverAt,
  };
}

/**
 * "on Tuesday at 6:04 pm", or "a while ago" when nothing knows.
 *
 * Deliberately absolute rather than "3 days ago". A relative age reads as an app being chatty
 * about itself; a date and a time is the thing a reader can actually weigh against "did the
 * committee change Iqamah this week?".
 */
export function describeWhen(at: number, now: number, locale?: string): string {
  if (!at || at > now + 60_000) return 'a while ago';
  const then = new Date(at);
  const sameDay = new Date(now).toDateString() === then.toDateString();
  const time = then.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `today at ${time}`;
  return `${then.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })} at ${time}`;
}
