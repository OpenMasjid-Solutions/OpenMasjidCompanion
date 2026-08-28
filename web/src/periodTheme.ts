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
