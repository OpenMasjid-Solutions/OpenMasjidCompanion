// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The accent, measured rather than eyeballed.
 *
 * The admin picks one of five accents in OpenMasjidOS and this app follows it. A filled button
 * then draws `--color-on-primary` on `--color-btn`, and those two were being set in different
 * places: the fill inline from the accent, the ink from whichever theme block the stylesheet
 * happened to reach. On the light theme that ink is **white**, because light's own primary is a
 * deep blue — so every non-default accent produced white-on-bright. Gold came out at **1.67:1**.
 *
 * Nothing on screen says "this is 1.67:1". Somebody has to pick that accent, in that theme, and
 * notice. So it is measured here, where a regression fails a build instead of waiting for a
 * masjid to squint at a Delete button.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ACCENTS, ACCENT_PROPS, accentVars } from './prefs';

// ── WCAG 2.1 relative luminance and contrast, straight from the spec ─────────

function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const channel = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test('the harness agrees with the WCAG worked examples', () => {
  // Measuring with a broken ruler is worse than not measuring: it reports pass.
  assert.equal(Number(contrast('#FFFFFF', '#000000').toFixed(2)), 21);
  assert.equal(Number(contrast('#FFFFFF', '#FFFFFF').toFixed(2)), 1);
});

// ── the thing that was wrong ─────────────────────────────────────────────────

test('EVERY ACCENT CARRIES INK THAT PASSES AA ON ITS OWN FILL', () => {
  for (const [id, a] of Object.entries(ACCENTS)) {
    const ratio = contrast(a.primary, a.onPrimary);
    assert.ok(
      ratio >= 4.5,
      `${id}: ink ${a.onPrimary} on fill ${a.primary} is ${ratio.toFixed(2)}:1 — under AA, and this is what a filled button draws`,
    );
  }
});

test('the hover fill is readable with the same ink, because the ink does not change on hover', () => {
  for (const [id, a] of Object.entries(ACCENTS)) {
    const ratio = contrast(a.hover, a.onPrimary);
    assert.ok(ratio >= 4.5, `${id}: ${ratio.toFixed(2)}:1 while the pointer is on it`);
  }
});

// ── and the thing that let it be wrong ───────────────────────────────────────

test('AN ACCENT SETS ITS INK AND ITS FILL TOGETHER, OR NEITHER', () => {
  // The actual defect was not a bad colour — it was a fill applied without its ink, leaving the
  // button to borrow whatever the theme had. Both arrive in one object now, so "set the fill and
  // forget the ink" is not a thing that can be written.
  for (const id of Object.keys(ACCENTS)) {
    const vars = accentVars(id);
    if (!vars) continue; // cyan: the stylesheet's own pairing, see accentVars
    assert.ok(vars['--color-btn'], `${id} sets a fill`);
    assert.ok(vars['--color-on-primary'], `${id} MUST set the ink that goes on it`);
    assert.equal(contrast(vars['--color-btn'], vars['--color-on-primary']) >= 4.5, true);
  }
});

test('cyan leaves the stylesheet alone, rather than overriding it with itself', () => {
  // On the light theme the stylesheet pairs #0369A1 with white at 5.93:1. Replacing that with
  // raw cyan and white would be 1.81:1 — a downgrade dressed up as a no-op.
  assert.equal(accentVars('cyan'), null);
  assert.equal(accentVars('not-an-accent'), null, 'an unknown accent is the default, never a crash');
});

test('every property an accent can set is one the reset path clears', () => {
  // A property left behind by a switch is the same bug in slow motion: last accent's ink on this
  // accent's fill. The removal list has to cover everything `accentVars` can produce.
  const set = new Set(ACCENT_PROPS as readonly string[]);
  for (const id of Object.keys(ACCENTS)) {
    for (const prop of Object.keys(accentVars(id) ?? {})) {
      assert.ok(set.has(prop), `${prop} is set by ${id} but never cleared — it would outlive its accent`);
    }
  }
});

test('the five ids are exactly the five OpenMasjidOS offers', () => {
  // The platform sends one of these strings; an id we do not know silently becomes the default,
  // so a rename upstream must break a test here rather than quietly un-brand every masjid.
  assert.deepEqual(Object.keys(ACCENTS).sort(), ['cyan', 'gold', 'sky', 'teal', 'violet']);
});
