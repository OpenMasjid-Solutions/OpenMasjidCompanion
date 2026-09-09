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
import { formatClock, formatStampNumeric } from './dates';

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
 * "today at 6:04 pm", "on 09/06/2026 at 6:04 pm", or "a while ago" when nothing knows.
 *
 * The ONE place this app writes a numeric date (see dates.ts): it sits inside a sentence that is
 * already doing work, and a short date keeps that sentence readable.
 *
 * Deliberately absolute rather than "3 days ago". A relative age reads as an app being chatty
 * about itself; a date and a time is the thing a reader can actually weigh against "did the
 * committee change Iqamah this week?". Same day is the one exception — there the reader is
 * judging an age, and a date would be three numbers to compare against today's first.
 */
export function describeWhen(at: number, now: number, locale?: string): string {
  if (!at || at > now + 60_000) return 'a while ago';
  // "today at 6:04 pm" beats "09/09/2026 at 6:04 pm" for something that happened hours ago: the
  // reader is judging an age, and on the same day the date is three numbers they have to compare
  // against today's before learning anything.
  if (new Date(now).toDateString() === new Date(at).toDateString()) return `today at ${formatClock(at, locale)}`;
  return `on ${formatStampNumeric(at, locale)}`;
}

/**
 * When this phone last got times it KNOWS were live.
 *
 * Kept here, on the phone, because it is the only record of the fact. The worker's stamp says
 * "this body came out of the cache"; it cannot say when the masjid was last actually reached if
 * the worker was not the one that answered — and the worker is not always in a position to
 * answer. Right after an app update the previous worker is still in control until the reader
 * accepts the refresh, on the masjid's own LAN over plain http there is no worker at all, and a
 * request can simply fail. In every one of those the times on screen are of unknown age, and
 * this is what lets the page still put a date on them.
 *
 * Losing it — private browsing, cleared site data — costs a date, not the warning: `noticeFor`
 * still fires, and `describeWhen` says "a while ago". That is the right way round for something
 * whose job is to be honest about not knowing.
 */
const LIVE_KEY = 'omc-live-at';

export function rememberLive(at: number): void {
  try {
    localStorage.setItem(LIVE_KEY, String(at));
  } catch {
    /* private browsing — the notice still appears, just without a date */
  }
}

export function lastLive(): number {
  try {
    return Number(localStorage.getItem(LIVE_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}
