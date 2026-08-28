// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * swipe.ts — moving between days with a thumb, the way you move between photos.
 *
 * The whole difficulty is telling a horizontal swipe apart from the vertical scroll that starts
 * the same way. A page that steals every drag becomes a page you cannot scroll; one that never
 * commits feels broken. So the gesture is decided by which axis moves FIRST and by how far,
 * and once it has been decided as a scroll it is left alone for the rest of the touch.
 *
 * Pointer events rather than touch events, so the same code works for a trackpad drag and for a
 * stylus — and so nothing has to be registered as a non-passive listener to call
 * `preventDefault`, which is what makes a page scroll badly on Android.
 */
import { useCallback, useRef } from 'react';

/** Far enough that a tap with a slightly unsteady thumb never counts, short enough that a real
 *  flick on a small phone always does. */
const DISTANCE = 55;

/** Past this, the gesture is a scroll and this hook never looks at it again. Deliberately
 *  generous: a thumb arcs, so a genuine horizontal swipe drifts vertically by a fair amount. */
const SLOPE = 1.0;

/** A slow drag across the screen is someone selecting text or thinking, not a flick. */
const MAX_MS = 700;

export interface SwipeHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  onPointerCancel: () => void;
}

/**
 * @param onNext  Swiped LEFT — the next day comes in from the right, as a photo would.
 * @param onPrev  Swiped RIGHT — the previous day.
 * @param now     Injectable clock. `Date.now` by default; a test passes its own.
 */
export function useSwipe(onNext: () => void, onPrev: () => void, now: () => number = Date.now): SwipeHandlers {
  const start = useRef<{ x: number; y: number; t: number; id: number } | null>(null);
  const decided = useRef<'none' | 'horizontal' | 'scroll'>('none');

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only a primary touch or drag. A right-click or a second finger is not a swipe.
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
      start.current = { x: e.clientX, y: e.clientY, t: now(), id: e.pointerId };
      decided.current = 'none';
    },
    [now],
  );

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const s = start.current;
    if (!s || e.pointerId !== s.id || decided.current === 'scroll') return;
    const dx = Math.abs(e.clientX - s.x);
    const dy = Math.abs(e.clientY - s.y);
    // Wait until there is enough movement to tell the axes apart at all — the first few pixels
    // of any gesture are noise, and judging on them makes the page feel like it is guessing.
    if (dx < 10 && dy < 10) return;
    decided.current = dy > dx * SLOPE ? 'scroll' : 'horizontal';
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const s = start.current;
      start.current = null;
      if (!s || e.pointerId !== s.id || decided.current !== 'horizontal') return;
      const dx = e.clientX - s.x;
      if (Math.abs(dx) < DISTANCE || now() - s.t > MAX_MS) return;
      // Swiping left pulls the next day in from the right, which is the direction photos move.
      if (dx < 0) onNext();
      else onPrev();
    },
    [onNext, onPrev, now],
  );

  const onPointerCancel = useCallback(() => {
    start.current = null;
    decided.current = 'none';
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel };
}

/**
 * Decide a gesture from raw numbers, so the rule can be tested without a browser.
 *
 * Exported separately because the hook above is all refs and event plumbing: the part worth
 * testing is which gestures count, and that is this.
 */
export function swipeResult(dx: number, dy: number, ms: number): 'next' | 'prev' | 'none' {
  if (Math.abs(dy) > Math.abs(dx) * SLOPE) return 'none'; // a scroll
  if (Math.abs(dx) < DISTANCE) return 'none'; // a tap, or a twitch
  if (ms > MAX_MS) return 'none'; // a drag, not a flick
  return dx < 0 ? 'next' : 'prev';
}
