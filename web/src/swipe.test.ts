// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Which gestures count as moving between days.
 *
 * The failure that matters is not a missed swipe — it is a STOLEN scroll. A prayer times page
 * that jumps to tomorrow when someone tries to scroll down the list is worse than one with no
 * swipe at all, because it happens to people who were not trying to swipe.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { swipeResult } from './swipe';

test('a clear horizontal flick moves a day, in the direction photos move', () => {
  assert.equal(swipeResult(-120, 10, 200), 'next', 'swiping left brings the next day in from the right');
  assert.equal(swipeResult(120, 10, 200), 'prev');
});

test('A VERTICAL SCROLL IS NEVER STOLEN', () => {
  // The one that has to hold. Someone dragging down the list of times must get the list, every
  // time, even if their thumb wanders sideways on the way.
  assert.equal(swipeResult(10, -200, 250), 'none', 'straight down');
  assert.equal(swipeResult(40, 200, 250), 'none', 'down with a wobble');
  assert.equal(swipeResult(-60, 300, 300), 'none', 'a long scroll with real sideways drift');
});

test('a thumb that arcs still counts as a swipe', () => {
  // The other direction of the same rule: thumbs are hinged, so a genuine horizontal flick on a
  // phone drifts vertically. Being too strict here makes the gesture feel broken.
  assert.equal(swipeResult(-140, 90, 250), 'next');
});

test('a tap, or a twitch, is not a swipe', () => {
  assert.equal(swipeResult(0, 0, 80), 'none');
  assert.equal(swipeResult(-12, 3, 90), 'none');
  assert.equal(swipeResult(-54, 0, 200), 'none', 'just under the threshold');
  assert.equal(swipeResult(-56, 0, 200), 'next', 'just over it');
});

test('a slow drag is not a flick', () => {
  // Someone selecting text, or resting a thumb while reading, then moving.
  assert.equal(swipeResult(-200, 5, 1500), 'none');
  assert.equal(swipeResult(-200, 5, 690), 'next', 'still within the window');
});
