// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * What the sky is doing right now.
 *
 * The musalli page's background follows the time of day: night is deep and quiet, dawn warms
 * at the horizon, midday is open and bright. It is not decoration. Before a single word has
 * been read it says whether you are looking at the end of the day or the start of one, and it
 * makes a prayer-times app feel like it is about the actual sky rather than about a table.
 * See docs/DESIGN_LANGUAGE.md.
 *
 * Two rules hold this together:
 *
 * **The theme still owns legibility.** `data-theme` decides the ink and the glass; `data-sky`
 * only moves the hue and the glow behind them. So the light theme at night is a soft dusk-blue
 * rather than a black page with dark text on it, and WCAG AA holds in both without the sky
 * being able to break it.
 *
 * **The clock is the MASJID's, not the phone's.** A musalli travelling, or a phone left on the
 * wrong timezone, must not make the masjid's own page claim it is midnight. Every function here
 * takes an IANA zone and none of them reads the device's zone by default.
 */

import { useEffect, useState } from 'react';

export type SkyPhase = 'night' | 'dawn' | 'morning' | 'day' | 'dusk';

/** Where one phase becomes the next, in minutes from local midnight. */
export interface SkyBoundaries {
  /** First light — Fajr, once we have a timetable. */
  dawn: number;
  /** Shurūq. */
  sunrise: number;
  /** The light starting to go, roughly ʿAṣr. */
  dusk: number;
  /** Maghrib: the sky is dark from here. */
  night: number;
}

/**
 * The fallback when no timetable has been chosen yet — a plain clock, deliberately unremarkable.
 *
 * These hours are crude, and they are meant to be temporary: once a masjid picks a timetable,
 * the boundaries come from the real Fajr, Shurūq and Maghrib for that day, which is both more
 * accurate and more appropriate — a prayer app's sky ought to turn over at the prayers. Until
 * then this is only ever the background of a page whose main message is "not set up yet".
 *
 * They are NOT prayer times and are never shown as any. Nothing in this file is a calculation
 * of anything (CLAUDE.md §2).
 */
export const CLOCK_BOUNDARIES: SkyBoundaries = {
  dawn: 5 * 60,
  sunrise: 7 * 60,
  dusk: 16 * 60 + 30,
  night: 19 * 60,
};

/** Which phase a given moment of the day falls in. */
export function skyPhase(minutesOfDay: number, b: SkyBoundaries = CLOCK_BOUNDARIES): SkyPhase {
  const m = ((minutesOfDay % 1440) + 1440) % 1440;
  if (m < b.dawn) return 'night';
  if (m < b.sunrise) return 'dawn';
  if (m < b.dusk) return m < b.sunrise + 180 ? 'morning' : 'day';
  if (m < b.night) return 'dusk';
  return 'night';
}

/**
 * Minutes since midnight in a given IANA timezone.
 *
 * Uses Intl rather than any arithmetic on the date, because an offset computed by hand is
 * wrong twice a year in most of the world and permanently wrong in the parts that do not
 * observe DST the way you assumed. This is the same rule every time in this app follows —
 * CLAUDE.md §7 — and it is worth obeying even for something as forgiving as a background.
 *
 * Falls back to the device's own clock when the zone is missing or unrecognised, which is the
 * honest answer before a timetable has been picked.
 */
export function minutesOfDay(at: Date, timeZone?: string): number {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(at);
      const hour = Number(parts.find((p) => p.type === 'hour')?.value);
      const minute = Number(parts.find((p) => p.type === 'minute')?.value);
      if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute;
    } catch {
      // An unknown zone name. Fall through to the device clock rather than throwing — a
      // background is never worth taking the page down for.
    }
  }
  return at.getHours() * 60 + at.getMinutes();
}

/** The current phase. Split from the hook so a test can ask about any moment it likes. */
export function skyPhaseAt(at: Date, timeZone?: string, boundaries?: SkyBoundaries): SkyPhase {
  return skyPhase(minutesOfDay(at, timeZone), boundaries);
}

/**
 * Follow the sky, live.
 *
 * Re-evaluated once a minute, which is both often enough (the phases are hours apart) and
 * cheap enough to leave running on a phone that has been left open on a prayer hall shelf.
 * The attribute is only written when the phase actually changes, so a page sitting open all
 * afternoon does four DOM writes, not four hundred.
 */
export function useSkyPhase(timeZone?: string, boundaries?: SkyBoundaries): SkyPhase {
  const [phase, setPhase] = useState(() => skyPhaseAt(new Date(), timeZone, boundaries));
  useEffect(() => {
    const tick = () => setPhase((was) => {
      const now = skyPhaseAt(new Date(), timeZone, boundaries);
      return now === was ? was : now;
    });
    tick(); // the zone or the boundaries may have just arrived with the timetable
    const id = setInterval(tick, 60_000);
    return () => clearInterval(id);
  }, [timeZone, boundaries]);
  return phase;
}
