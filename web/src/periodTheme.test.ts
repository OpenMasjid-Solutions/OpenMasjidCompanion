// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Which ink each part of the day gets.
 *
 * This table and the `[data-period]` skies in app.css are two halves of one decision that the
 * language cannot check: CSS cannot tell the script how dark a gradient is, and the script
 * cannot see the stylesheet. Get a row wrong and it is not subtle — near-white text on a noon
 * sky, or dark text on a midnight one — but it is also not something a typechecker or a build
 * will ever notice. So the split is asserted here against the reference screenshots.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { PERIODS, PERIOD_SURFACE } from './periodTheme';

test('every period has a surface, and there are exactly six', () => {
  assert.equal(PERIODS.length, 6);
  assert.deepEqual(PERIODS, ['fajr', 'sunrise', 'dhuhr', 'asr', 'maghrib', 'isha'], 'in day order');
  for (const p of PERIODS) {
    assert.ok(PERIOD_SURFACE[p] === 'light' || PERIOD_SURFACE[p] === 'dark', `${p} has no surface`);
  }
  assert.equal(Object.keys(PERIOD_SURFACE).length, 6, 'no orphaned entries');
});

test('THE TWO REFERENCE SCREENS COME OUT AS THEY DO IN THE REFERENCE', () => {
  // The owner supplied exactly two: a light "Duha" screen and a dark "Maghrib" one. If either
  // of these flips, the thing he actually asked for is broken.
  assert.equal(PERIOD_SURFACE.sunrise, 'light', 'the Duha screen is light');
  assert.equal(PERIOD_SURFACE.maghrib, 'dark', 'the Maghrib screen is deep navy, not a bright sunset');
});

test('the day is light and the night is dark, which is the whole point', () => {
  assert.equal(PERIOD_SURFACE.dhuhr, 'light', 'midday');
  assert.equal(PERIOD_SURFACE.asr, 'light', 'afternoon');
  assert.equal(PERIOD_SURFACE.fajr, 'dark', 'before dawn');
  assert.equal(PERIOD_SURFACE.isha, 'dark', 'night');
});

test('the surface changes exactly twice across the day, not more', () => {
  // Once at Shurūq and once at Maghrib. A third flip would mean the page inverts itself
  // somewhere in the middle of the afternoon, which no sky does.
  const flips = PERIODS.filter((p, i) => i > 0 && PERIOD_SURFACE[p] !== PERIOD_SURFACE[PERIODS[i - 1]]);
  assert.deepEqual(flips, ['sunrise', 'maghrib']);
});

test('it is dark at both ends of the day, so the page wraps around cleanly', () => {
  // Isha runs through midnight into Fajr. If those two disagreed the page would flip theme in
  // the middle of the night for no reason a reader could see.
  assert.equal(PERIOD_SURFACE.isha, PERIOD_SURFACE.fajr);
});
