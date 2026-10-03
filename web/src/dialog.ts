// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * dialog.ts — the three things a modal has to do, in one place.
 *
 * The platform's UI spec (§7) asks for all three and then says why this file exists: *"Prefer a
 * real primitive over hand-rolling this — every hand-rolled one we have audited was missing at
 * least two of the three."* This app had two hand-rolled dialogs and the prediction held exactly.
 * `InstallPrompt` did all three. The admin's "What's new" modal did one: Escape. Nothing moved
 * focus into it, so Tab walked straight out of an `aria-modal="true"` dialog into the page behind
 * the scrim, and its own comment claimed "focus starts inside" while no code did that.
 *
 * WHY NOT RADIX, which the spec suggests. A dialog primitive is a dependency, and this app's
 * budget is a product constraint rather than a preference (§8, and `chunkSizeWarningLimit: 260`
 * with a comment about Fajr on mobile data). Radix's dialog plus its focus-scope and
 * dismissable-layer dependencies is a large fraction of that budget for two dialogs. One shared,
 * tested implementation is the same correctness without the weight — but it had to actually be
 * shared, which is the part that was missing.
 *
 * The three:
 *   1. **Focus moves in**, so a keyboard or screen reader is inside the thing that just opened.
 *   2. **Focus is trapped**, so Tab cannot leave a modal that claims to be modal.
 *   3. **Focus returns to whatever opened it**, so dismissing does not dump the reader at the top
 *      of the document with no idea where they were.
 *
 * Plus the one nobody lists: the page behind must not scroll under the reader's finger.
 */
import { useEffect, type RefObject } from 'react';

/**
 * What counts as focusable, for the trap.
 *
 * Deliberately broader than the buttons the old trap looked for: the "What's new" modal renders
 * release notes that may carry links, and a trap that does not know about an element lets Tab
 * escape through it — which is the failure, not a cosmetic gap.
 */
export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab should go, as an index, or `null` to let the browser do its ordinary thing.
 *
 * Pure and index-based so the wrap-around can be tested without a DOM — the two edges are the
 * whole of the trap, and they are exactly the cases a browser test is least likely to cover.
 */
export function trapTarget(count: number, active: number, shift: boolean): number | null {
  if (count === 0) return null;
  // One focusable element is still a trap: Tab must return to it rather than leave.
  if (count === 1) return 0;
  if (shift && active === 0) return count - 1;
  if (!shift && active === count - 1) return 0;
  return null;
}

/**
 * Give a dialog the three behaviours and the scroll lock.
 *
 * `card` must point at the dialog element itself and that element needs `tabIndex={-1}`, or there
 * is nothing for step 1 to focus.
 */
export function useDialog(open: boolean, onClose: () => void, card: RefObject<HTMLElement>): void {
  // 1 and 3, plus the scroll lock. Together, because the cleanup that restores focus is the same
  // cleanup that restores scrolling — splitting them is how one of them gets forgotten.
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    card.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      // Optional-called: the opener may have been unmounted while the dialog was up.
      returnTo?.focus?.();
    };
  }, [open, card]);

  // 2, plus Escape. Bound to the card rather than the window so two dialogs can never both act
  // on one key press.
  useEffect(() => {
    const el = card.current;
    if (!open || !el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
      const to = trapTarget(items.length, items.indexOf(document.activeElement as HTMLElement), e.shiftKey);
      if (to === null) return;
      e.preventDefault();
      items[to].focus();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [open, onClose, card]);
}
