// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * telemetry.ts — what the masjid learns about the phones their app is on.
 *
 * Asked for by Hasan on 2026-08-29, and CLAUDE.md §4 had "analytics beyond a plain count of
 * push subscriptions" in the OUT-of-scope list. That line was written to stop this app growing
 * a visitor log, and the reason is still right, so the shape here is the one that answers the
 * question without ever building one:
 *
 *  - **Three enum values, and a day. That is the entire payload.** `{ device, browser, mode }`,
 *    each one of a fixed short list this file and the server both know. There is no free text
 *    anywhere in it, so there is nothing that could carry a user agent, a URL, a referrer or an
 *    id even by accident.
 *  - **The server adds one to a counter and stores nothing else.** No row per visit, no
 *    timestamp finer than the date, no IP — see `analytics.ts`. A masjid can learn "about a
 *    third of our people are on iPhones"; nothing in the store could ever answer "who".
 *  - **Once a day per browser, not once a page load.** Otherwise the numbers would measure how
 *    often a few people open the app rather than how many people have it, which is a different
 *    question that nobody asked and that flatters whoever checks it most.
 *
 * The signature is kept in this browser's own localStorage and never leaves it. Losing it —
 * private browsing, cleared site data — costs one extra count, which is the right way round for
 * something whose worst failure should be a slightly high number.
 */
import { useEffect } from 'react';
import { api } from './api';
import { browserOf, currentEnv, deviceOf, modeOf, osOf, type BrowserId, type Device, type Mode } from './platform';

const KEY = 'omc-seen';

export interface Visit {
  device: Device;
  browser: BrowserId;
  mode: Mode;
}

/**
 * The whole of what is remembered locally: a date and the three values.
 *
 * The mode is in it deliberately. Somebody who installs the app at lunchtime should show up in
 * both columns that day — that transition is the single most useful thing on the admin's screen
 * ("did the poster work?") and it is the one a once-a-day check would swallow.
 */
export function signature(day: string, v: Visit): string {
  return `${day}|${v.device}|${v.browser}|${v.mode}`;
}

/** Today, as the phone reckons it. A device clock is untrustworthy for a prayer time and
 *  perfectly adequate for "have I already counted this browser today". */
export function today(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** Read the current browser's own answer to the three questions. */
export function currentVisit(): Visit {
  const env = currentEnv();
  return { device: deviceOf(osOf(env)), browser: browserOf(env), mode: modeOf() };
}

/**
 * Report this browser once, quietly, if it has not been counted today.
 *
 * Exported for the test: the decision is "is the stored signature the same as this one", and
 * getting it wrong in either direction is invisible — too eager and every reload is a person,
 * too lazy and installing the app never shows up.
 */
export function shouldReport(stored: string | null, sig: string): boolean {
  return stored !== sig;
}

/** Some browsers still offer the setting, and an app that keeps a counter of phone types has no
 *  business being the one that ignores it. It undercounts, and the admin screen says so. */
function tracksRefused(): boolean {
  const n = typeof navigator === 'undefined' ? null : (navigator as unknown as { doNotTrack?: string | null });
  return n?.doNotTrack === '1';
}

/**
 * Count this browser, at most once a day.
 *
 * `active` is false on the admin panel — a volunteer opening their own settings is not a
 * musalli, and counting them would put one Chrome-on-a-laptop in every masjid's numbers.
 *
 * Deferred a couple of seconds on purpose. This is the least important request the page makes
 * and it must never be in front of the prayer times on a bad connection; a failure is silent
 * and simply not counted, because there is nothing here worth a retry.
 */
export function useTelemetry(active: boolean): void {
  useEffect(() => {
    if (!active || tracksRefused()) return;
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(KEY);
    } catch {
      // Private browsing. Counted every day rather than never — see the note above.
    }
    const visit = currentVisit();
    const sig = signature(today(), visit);
    if (!shouldReport(stored, sig)) return;

    const id = setTimeout(() => {
      void api.post('/api/public/visit', visit).then((r) => {
        // Written only on success, so a phone that was offline is still counted tomorrow.
        if (!r.ok) return;
        try {
          localStorage.setItem(KEY, sig);
        } catch {
          /* private browsing — it just will not persist */
        }
      });
    }, 2500);
    return () => clearTimeout(id);
  }, [active]);
}
