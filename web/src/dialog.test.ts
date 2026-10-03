// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The edges of the focus trap.
 *
 * A trap is only ever wrong at its two edges — Tab on the last element, Shift+Tab on the first —
 * and those are precisely the two a person testing by hand does not reach, because the dialog
 * behaves perfectly until they do. The platform spec says every hand-rolled dialog it audited was
 * missing at least two of the three behaviours; this pins the one that is pure.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { FOCUSABLE, trapTarget } from './dialog';

test('TAB OFF THE END WRAPS TO THE START', () => {
  // The common case: three buttons, focus on the last, Tab. Without this the next Tab leaves a
  // dialog that told the screen reader it was modal.
  assert.equal(trapTarget(3, 2, false), 0);
});

test('SHIFT+TAB OFF THE FRONT WRAPS TO THE END', () => {
  assert.equal(trapTarget(3, 0, true), 2);
});

test('in the middle the browser is left alone', () => {
  // Re-implementing ordinary tab order is how a trap breaks reading order for everyone else.
  assert.equal(trapTarget(3, 1, false), null);
  assert.equal(trapTarget(3, 1, true), null);
});

test('ONE focusable element is still a trap', () => {
  // A dialog with a single Close button: Tab must come back to it, not escape. Both directions.
  assert.equal(trapTarget(1, 0, false), 0);
  assert.equal(trapTarget(1, 0, true), 0);
});

test('a dialog with nothing focusable does not throw, and does not fight the browser', () => {
  assert.equal(trapTarget(0, -1, false), null);
  assert.equal(trapTarget(0, -1, true), null);
});

test('focus somewhere unexpected does not wedge the trap', () => {
  // `indexOf` returns -1 when focus is on the card itself — which is exactly where this hook puts
  // it on open. The first Tab from there must behave normally and land on the first control,
  // rather than being treated as "on the last element" and bounced.
  assert.equal(trapTarget(3, -1, false), null);
  assert.equal(trapTarget(3, -1, true), null);
});

test('the focusable selector covers what these dialogs actually contain', () => {
  // The old trap looked only for `button`. The "What's new" modal renders release notes that can
  // carry links, and a trap blind to an element lets Tab out through it.
  for (const needed of ['a[href]', 'button:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])']) {
    assert.ok(FOCUSABLE.includes(needed), `${needed} must be focusable to the trap`);
  }
  assert.ok(!FOCUSABLE.includes('[tabindex="-1"]:not'), 'the card itself is not a tab stop');
});
