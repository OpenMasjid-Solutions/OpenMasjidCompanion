// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * haptics.ts — the small buzz that confirms a tap.
 *
 * Asked for by Hasan on 2026-08-30, across the Qibla, the day and month swipes, the tabs and the
 * buttons. One thing has to be said plainly before any of it, because it is not a bug and cannot
 * be worked around:
 *
 * **This does nothing on an iPhone.** Safari has never shipped the Vibration API, on iOS or on
 * macOS, and there is no other route to the Taptic Engine from a web page — no permission to
 * ask for, no flag, no polyfill. Every call below is a no-op there. So haptics are treated
 * throughout as a *confirmation of something already visible*, never as the signal itself: the
 * Qibla says "Facing the Qibla" on screen and buzzes as well, and the buzz is the part that is
 * allowed to be missing.
 *
 * Where it does work — Android, in a browser and in an installed PWA — the OS still has the last
 * word. Both Android's system-wide haptic setting and the browser's own can silence it, and
 * neither is readable from here. That is correct: somebody who turned vibration off on their
 * phone has already answered this question and should not have to answer it again.
 *
 * The patterns are DELIBERATELY SHORT. A phone in a prayer hall is in somebody's hand or pocket
 * near other people, and anything long enough to be audible against a chair is too long.
 */
import { prefsStore } from './prefs';

export type Feel =
  /** A press. The default, and by far the most common — 10 ms is under the threshold of
   *  "a vibration" and reads as a click. */
  | 'tap'
  /** Something changed under the finger: a day swiped, a chip switched on. */
  | 'select'
  /** It worked, and the reader may not be looking. Two pulses, because one is a tap. */
  | 'success'
  /** It did not, or it is about to do something that cannot be undone. */
  | 'warn';

const PATTERNS: Record<Feel, number | number[]> = {
  tap: 8,
  select: 14,
  success: [14, 44, 22],
  warn: [22, 60, 22],
};

/** Is there a vibrator to talk to at all? False on every iPhone, and on most laptops. */
export function hapticsSupported(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

/**
 * Buzz, unless there is a reason not to.
 *
 * Never throws and never awaits: it is called from event handlers on a path the reader is
 * waiting on, and a haptic that delayed a tap by even a frame would be worse than no haptic.
 * `vibrate` returns false when the browser refuses, which is not worth reacting to — there is
 * no fallback and nothing to tell anybody.
 */
export function haptic(feel: Feel = 'tap'): void {
  if (!hapticsSupported()) return;
  try {
    if (!prefsStore.get().haptics) return;
    navigator.vibrate(PATTERNS[feel]);
  } catch {
    /* a browser that has the method and refuses to run it — nothing to do about it */
  }
}

/**
 * One listener for every button in the app, instead of a call at every call site.
 *
 * "Haptics on buttons, throughout" is a property of the app rather than of any one component, and
 * threading it through forty `onClick`s would guarantee that the forty-first is missed. A single
 * delegated listener is also how the platforms themselves do it: the OS decides what a press
 * feels like, not each button.
 *
 * **`pointerdown`, not `click`.** The feedback has to land on the press — a buzz on release,
 * after the screen has already changed, feels like a fault rather than a confirmation.
 *
 * What is deliberately excluded:
 *
 *  - Anything `disabled` or `aria-disabled`, which is a press that does nothing.
 *  - Untrusted events, so a script cannot make somebody's phone buzz.
 *  - Non-primary buttons and multi-touch, which are not taps.
 *
 * The listener is passive and does no layout work, so it cannot make a tap feel slower.
 */
export function startButtonHaptics(): () => void {
  if (typeof document === 'undefined') return () => undefined;

  const onDown = (e: PointerEvent) => {
    if (!e.isTrusted || e.button !== 0) return;
    const el = e.target instanceof Element ? e.target.closest('button, .tab, .chip, .set-option, summary') : null;
    if (!el) return;
    if (el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true') return;
    if (el.closest('[disabled]')) return;
    haptic('tap');
  };

  document.addEventListener('pointerdown', onDown, { passive: true });
  return () => document.removeEventListener('pointerdown', onDown);
}
