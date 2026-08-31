// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Which ink each part of the day needs.
 *
 * The musalli page themes itself by the time of day rather than by the browser's light/dark
 * setting (Hasan, 2026-08-25): Fajr is dark, Duha is light, Maghrib is dark again. This table is
 * the one piece of that decision the SCRIPT needs — the skies themselves are in app.css, keyed
 * off `data-period`, but which of the two ink sets stays legible on a given sky cannot be worked
 * out from CSS, so it is stated here and the two are kept in step by hand.
 *
 * Getting a row wrong is not subtle: near-white ink on a noon sky, or dark ink on a night one.
 * `periodTheme.test.ts` asserts the split matches the reference screenshots.
 */
import type { PeriodKey } from './prayerTimes';

export const PERIOD_SURFACE: Record<PeriodKey, 'light' | 'dark'> = {
  /** Pre-dawn. Still night to look at, with the first light only at the horizon. */
  fajr: 'dark',
  /** Duha — the stretch from Shurūq to Zawāl. The reference's own "Duha" screen is light. */
  sunrise: 'light',
  /** Midday, the brightest the page ever gets. */
  dhuhr: 'light',
  /** Afternoon, going golden but still plainly daylight. */
  asr: 'light',
  /** Sunset into dusk. The reference's "Maghrib" screen is deep navy, not a bright sunset. */
  maghrib: 'dark',
  /** Night. */
  isha: 'dark',
};

/** In day order, for anything that needs to walk them (the tests, and any future preview). */
export const PERIODS: PeriodKey[] = ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'];

/**
 * What the reader asked the page to look like (Hasan, 2026-08-29).
 *
 *  - `period` — the default and the design: the page looks like the time of day.
 *  - `dark` / `light` — hold one polarity all day. A phone in a dark prayer hall at noon, or
 *    somebody who simply finds the bright screens hard to read.
 */
export type SkyMode = 'period' | 'dark' | 'light';

export const SKY_MODES: { id: SkyMode; label: string; hint: string }[] = [
  { id: 'period', label: 'Follow the day', hint: 'Dark before Fajr, light by mid-morning, dark again after Maghrib.' },
  { id: 'dark', label: 'Always dark', hint: 'Night skies all day.' },
  { id: 'light', label: 'Always light', hint: 'Daytime skies all day.' },
];

/**
 * Pinning a polarity does NOT pin one picture.
 *
 * The obvious implementation of "always dark" is a single night sky, and it throws away the
 * thing this page is (docs/DESIGN_LANGUAGE.md): the sun crosses it. So each mode keeps moving
 * through the day inside the polarity it was given — always-dark runs Fajr → Maghrib → Isha,
 * always-light runs Duha → Dhuhr → Asr. The reader gets the contrast they asked for and the
 * page still tells them roughly where in the day they are.
 *
 * The two maps are chosen for how a sky FEELS at that hour rather than by any rule that could
 * be computed. Late afternoon's dark counterpart is Maghrib, not midnight; night's light
 * counterpart is the soft morning, not the glare of noon.
 */
const DARK_OF: Record<PeriodKey, PeriodKey> = {
  fajr: 'fajr',
  sunrise: 'fajr',
  dhuhr: 'isha',
  asr: 'maghrib',
  maghrib: 'maghrib',
  isha: 'isha',
};

const LIGHT_OF: Record<PeriodKey, PeriodKey> = {
  fajr: 'sunrise',
  sunrise: 'sunrise',
  dhuhr: 'dhuhr',
  asr: 'asr',
  maghrib: 'asr',
  isha: 'sunrise',
};

/** Which sky to actually draw, given the real period and what the reader asked for. */
export function skyFor(period: PeriodKey, mode: SkyMode): PeriodKey {
  if (mode === 'dark') return DARK_OF[period];
  if (mode === 'light') return LIGHT_OF[period];
  return period;
}

/**
 * What to draw, given everything we know — and the one case that was quietly wrong.
 *
 * `period` is null when we do not yet know what time it is AT THIS MASJID: a fresh install with
 * no timetable chosen, Display not granted, or simply any page opened before the day view has
 * mounted (the onboarding page, /give from a link). We must never guess it from the device
 * clock — CLAUDE.md §7 — so the sky falls back to the default one in app.css, which is NIGHT.
 * "Dark is the safe unknown", as the stylesheet puts it.
 *
 * **The surface has to follow it there.** Returning "no opinion" and letting `data-theme` fall
 * back to the reader's own light/dark preference is what this used to do, and on a phone set to
 * light it put near-black ink on a midnight gradient — on the fresh-install screen an admin sees
 * first, and on every deep link into the app. A dark sky needs the dark ink set whether or not
 * the reader's phone agrees, because the sky is not the thing their preference controls.
 *
 * Pure, and returned as a pair, because the two halves are one decision: the sky and the ink
 * that has to stay legible on it.
 */
export function surfaceFor(period: PeriodKey | null, mode: SkyMode): { period: PeriodKey | null; surface: 'light' | 'dark' } {
  // A reader who chose "always light" answered a question about their own SCREEN rather than
  // about the masjid, so that choice is honoured even before the timetable arrives; `isha` is
  // only the seed the polarity map runs from.
  const shown = period ? skyFor(period, mode) : mode === 'period' ? null : skyFor('isha', mode);
  return { period: shown, surface: shown ? PERIOD_SURFACE[shown] : 'dark' };
}
