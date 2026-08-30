// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * "Add this to your phone" — and "a new version is ready".
 *
 * The install ask is a **dialog in the middle of the screen** (Hasan, 2026-08-28). It was a
 * strip at the foot of the page, on the reasoning that someone who opened this to find out when
 * Maghrib is should not be interrupted — but a strip below the fold on a phone is not a gentler
 * ask, it is an invisible one, and an install prompt nobody sees does not respect the reader,
 * it just fails quietly. So it asks properly, once, and takes no for an answer permanently.
 *
 * What keeps it from being an interruption instead:
 *
 *  • It waits until the times are on screen. A modal in the first paint hides the one thing
 *    the reader came for, before they have seen it.
 *  • Escape, the backdrop, "Not now", and the close button all dismiss it, and `onDismiss`
 *    persists — it is asked once per phone, not once per visit.
 *  • It only appears when it can DO something (see pwa.ts): never over plain HTTP on the LAN,
 *    never when already installed. On iOS, where no prompt API exists, it names the buttons to
 *    press rather than offering one that would do nothing.
 *
 * The update notice stays a strip: nobody needs to be stopped to be told about a version.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUpFromLine, Compass, Copy, Plus, RefreshCw, Share, X } from 'lucide-react';
import { withBase } from './base';
import { preferredBrowser, type InstallRoute, type Os } from './platform';

/** Long enough for the page to have painted and been read, short enough to still feel like part
 *  of arriving rather than an ambush half a minute later. */
const APPEAR_AFTER_MS = 1400;

/**
 * The routes worth interrupting somebody for.
 *
 * Deliberately NOT every route this app understands. `menu` and `desktop` are real answers —
 * an Android browser whose install lives behind its own menu, a laptop — but neither is worth
 * a modal over a page of prayer times: `menu` cannot be told apart from "already installed,
 * opened in a tab", and nobody adds a masjid timetable to a desktop. Both are handled properly
 * on the onboarding page, which somebody reached by choosing to.
 */
const ASKABLE: InstallRoute[] = ['prompt', 'ios-safari', 'switch'];

export function InstallPrompt({
  route,
  os,
  name,
  dismissed,
  onInstall,
  onDismiss,
}: {
  route: InstallRoute;
  os: Os;
  name: string;
  dismissed: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}): JSX.Element | null {
  const eligible = !dismissed && ASKABLE.includes(route);
  const [shown, setShown] = useState(false);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!eligible) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), APPEAR_AFTER_MS);
    return () => clearTimeout(t);
  }, [eligible]);

  // Move focus into the dialog and hold the page still behind it. Both are undone on the way
  // out, including when the component unmounts mid-animation.
  useEffect(() => {
    if (!shown) return;
    const returnTo = document.activeElement as HTMLElement | null;
    card.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      returnTo?.focus?.();
    };
  }, [shown]);

  if (!eligible || !shown) return null;

  /** Keep Tab inside the dialog. It is three controls at most, so this is the whole trap. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onDismiss();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = card.current?.querySelectorAll<HTMLElement>('button');
    if (!items || items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    // Clicking the backdrop dismisses; clicking the card must not. A modal that closes when you
    // tap its own text is worse than one with no backdrop dismissal at all.
    <div className="modal-back" onClick={onDismiss}>
      <div
        ref={card}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="install-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <button className="icon-btn modal__close" onClick={onDismiss} aria-label="Not now">
          <X size={18} aria-hidden="true" />
        </button>

        {/* The masjid's own icon, at the size a launcher draws it — so the ask shows what the
            reader would actually end up with on their home screen. */}
        <img className="modal__icon" src={withBase('/api/public/icon/192.png')} width={64} height={64} alt="" />

        <h2 className="modal__title" id="install-title">
          Keep {name} on your phone
        </h2>

        {route === 'prompt' ? (
          <p className="modal__text">
            Add it to your home screen and today&rsquo;s times are one tap away, even with no signal.
          </p>
        ) : route === 'ios-safari' ? (
          // iOS Safari: no API exists, so the only honest thing is to say which buttons to press.
          <p className="modal__text">
            Tap <Share size={15} aria-label="the Share button" style={{ verticalAlign: '-0.15em' }} /> at the bottom of
            the screen, then{' '}
            <b>
              Add to Home Screen <Plus size={14} aria-hidden="true" style={{ verticalAlign: '-0.1em' }} />
            </b>
            .
          </p>
        ) : os === 'ios' ? (
          // iOS, but not in Safari. Adding to the Home Screen is a SAFARI feature, not an iOS
          // one — in Chrome, or in the in-app browser that opens when you tap a link in
          // WhatsApp, the button simply is not in the Share sheet. Telling someone to look for
          // it there would send them hunting for something that is not on their screen.
          <p className="modal__text">
            On iPhone and iPad this only works in <b>Safari</b>. Open this page in Safari, then tap{' '}
            <Share size={15} aria-label="the Share button" style={{ verticalAlign: '-0.15em' }} /> and{' '}
            <b>
              Add to Home Screen <Plus size={14} aria-hidden="true" style={{ verticalAlign: '-0.1em' }} />
            </b>
            .
          </p>
        ) : (
          // An in-app browser on Android — a link tapped inside Instagram or WhatsApp. It can
          // sometimes install, into a container the person will never find again, so the only
          // useful advice is the same one: open it in a real browser first.
          <p className="modal__text">
            You&rsquo;re reading this inside another app, which can&rsquo;t add it to your home screen. Open this page in{' '}
            <b>{preferredBrowser(os)}</b> and it will offer to.
          </p>
        )}

        <div className="modal__actions">
          {route === 'prompt' && (
            <button className="btn btn--primary modal__go" onClick={onInstall}>
              <ArrowUpFromLine size={15} aria-hidden="true" />
              Add to home screen
            </button>
          )}
          {/* "Open this in Safari" cannot be done from a web page — no browser lets one page
              hand itself to another. So the useful thing is the ADDRESS, ready to paste. */}
          {route === 'switch' && <CopyLink />}
          {/* On iOS there is no button that installs anything, so the only control here is the
              one that closes it — and the only action on a dialog should look like the action. */}
          <button
            className={route === 'prompt' || route === 'switch' ? 'btn modal__later' : 'btn btn--primary modal__later'}
            onClick={onDismiss}
          >
            {route === 'prompt' ? 'Not now' : 'Got it'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The page's own address, ready to paste into Safari.
 *
 * `location.href` rather than the app's configured public URL: whatever address actually got
 * this page onto their screen is the one that will work when they paste it. Falls back to
 * showing the address when the clipboard is unavailable, which it is in more iOS in-app
 * browsers than you would expect.
 */
function CopyLink(): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      setState('copied');
    } catch {
      setState('failed');
    }
  };
  return (
    <>
      <button className="btn btn--primary modal__go" onClick={() => void copy()}>
        {state === 'copied' ? <Compass size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        {state === 'copied' ? 'Copied — now paste it in Safari' : 'Copy this page’s address'}
      </button>
      {state === 'failed' && <p className="modal__addr">{location.href}</p>}
    </>
  );
}

/**
 * A new build is cached and waiting — a banner across the top (Hasan, 2026-08-29).
 *
 * It is never applied on our own initiative. Swapping the service worker reloads the page, and
 * doing that to someone mid-read — on a page whose whole job is to be glanceable — is worse
 * than being one version behind for another minute.
 *
 * **Fixed rather than in the flow.** This appears while somebody is already reading: inserting
 * it into the top of the document would shove the whole page down under their thumb, which on a
 * page of times is how you tap the wrong day. Fixed, it costs no layout and stays visible when
 * they scroll.
 *
 * It is dismissible, and dismissing it is not a refusal of the update — the new version is
 * already downloaded and takes over on the next visit regardless. The button only offers to
 * have it NOW.
 */
export function UpdateBanner({ onApply }: { onApply: () => void }): JSX.Element | null {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <aside className="update no-print" role="status">
      <span className="update__text">A new version is ready</span>
      <button className="btn btn--primary update__go" onClick={onApply}>
        <RefreshCw size={14} aria-hidden="true" />
        Refresh
      </button>
      <button className="icon-btn update__close" onClick={() => setHidden(true)} aria-label="Later">
        <X size={16} aria-hidden="true" />
      </button>
    </aside>
  );
}
