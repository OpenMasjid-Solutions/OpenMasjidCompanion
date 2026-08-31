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
import { PERIODS, PERIOD_SURFACE, SKY_MODES, skyFor, surfaceFor } from './periodTheme';

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

// ── Holding one polarity all day ─────────────────────────────────────────────
//
// The reader's own setting (Hasan, 2026-08-29): keep the time-of-day look, or pin it dark or
// light. `skyFor` is where a wrong entry would show as a bright noon sky on somebody who asked
// for "always dark", so the property that actually matters is asserted rather than the table.

test('ALWAYS-DARK IS ALWAYS DARK, AND ALWAYS-LIGHT IS ALWAYS LIGHT', () => {
  // The one thing this must never do. Every period, both directions, checked against the same
  // surface table the CSS is kept in step with.
  for (const p of PERIODS) {
    assert.equal(PERIOD_SURFACE[skyFor(p, 'dark')], 'dark', `${p} → ${skyFor(p, 'dark')} must be dark`);
    assert.equal(PERIOD_SURFACE[skyFor(p, 'light')], 'light', `${p} → ${skyFor(p, 'light')} must be light`);
  }
});

test('"follow the day" changes nothing at all', () => {
  for (const p of PERIODS) assert.equal(skyFor(p, 'period'), p);
});

test('a pinned polarity still MOVES through the day', () => {
  // The obvious implementation of "always dark" is one night sky for ever, and it throws away
  // what this page is: the sun crosses it. Both modes have to reach more than one sky, or the
  // setting quietly turns the design off instead of adjusting it.
  const darks = new Set(PERIODS.map((p) => skyFor(p, 'dark')));
  const lights = new Set(PERIODS.map((p) => skyFor(p, 'light')));
  assert.ok(darks.size > 1, `always-dark collapsed to ${[...darks].join()}`);
  assert.ok(lights.size > 1, `always-light collapsed to ${[...lights].join()}`);
});

test('a sky already of the right polarity is left exactly where it is', () => {
  // Somebody on "always dark" at Maghrib should see Maghrib, not a substitute for it. Only a
  // period of the WRONG polarity is ever swapped.
  for (const p of PERIODS) {
    const want = PERIOD_SURFACE[p];
    assert.equal(skyFor(p, want), p, `${p} is already ${want} and must not be moved`);
  }
});

test('the three options offered are the three the code understands', () => {
  // The picker is built from SKY_MODES and the effect switches on the id. A fourth label with
  // no branch behind it would be a setting that silently does nothing.
  assert.deepEqual(SKY_MODES.map((m) => m.id), ['period', 'dark', 'light']);
  for (const m of SKY_MODES) {
    assert.ok(m.label.length > 0 && m.hint.length > 0, `${m.id} needs a label and a hint`);
  }
});

// ── When we do not know what time it is at this masjid ───────────────────────

test('AN UNKNOWN TIME GETS THE NIGHT SKY AND THE NIGHT INK, TOGETHER', () => {
  // The bug this replaced: `surfaceFor` used to return "no opinion" here, so `data-theme` fell
  // back to the reader's own phone setting — and on a phone set to light that is near-black ink
  // on the midnight gradient app.css falls back to. Reachable on a fresh install with no
  // timetable, and on any page opened before the day view has mounted.
  const unknown = surfaceFor(null, 'period');
  assert.equal(unknown.period, null, 'no period is guessed — never from the device clock');
  assert.equal(unknown.surface, 'dark', 'the fallback sky is night, so the ink must be too');
});

test('a pinned polarity is honoured before the timetable arrives', () => {
  // "Always light" is an answer about the reader's own screen, not about the masjid, so it does
  // not have to wait for Display. It still resolves to a real sky rather than a bare attribute.
  const light = surfaceFor(null, 'light');
  assert.equal(light.surface, 'light');
  assert.ok(light.period, 'a light surface needs a light sky under it, not the night fallback');
  assert.equal(PERIOD_SURFACE[light.period!], 'light');

  const dark = surfaceFor(null, 'dark');
  assert.equal(dark.surface, 'dark');
  assert.equal(PERIOD_SURFACE[dark.period!], 'dark');
});

test('THE SKY AND THE INK CAN NEVER DISAGREE', () => {
  // The property the whole pair exists for. Every period, every mode, plus the unknown case.
  for (const mode of ['period', 'dark', 'light'] as const) {
    for (const p of [...PERIODS, null]) {
      const { period: shown, surface } = surfaceFor(p, mode);
      const want = shown ? PERIOD_SURFACE[shown] : 'dark';
      assert.equal(surface, want, `${p ?? 'unknown'} in ${mode} mode: ${shown} sky with ${surface} ink`);
    }
  }
});
