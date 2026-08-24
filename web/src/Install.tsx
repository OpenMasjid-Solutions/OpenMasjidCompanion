// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * "Add this to your phone" — and "a new version is ready".
 *
 * Both are small strips at the bottom of the musalli page rather than dialogs. Someone opened
 * this to find out when Maghrib is; nothing here is allowed to stand in front of that.
 *
 * The install strip only appears when it can actually do something (see pwa.ts): never over
 * plain HTTP on the LAN, never once the app is already installed, and never again once it has
 * been dismissed. On iOS, where there is no prompt to show, it explains the Share sheet instead
 * of offering a button that would do nothing.
 */
import { ArrowUpFromLine, Plus, RefreshCw, Share, X } from 'lucide-react';
import type { InstallKind } from './pwa';

export function InstallStrip({
  kind,
  name,
  dismissed,
  onInstall,
  onDismiss,
}: {
  kind: InstallKind;
  name: string;
  dismissed: boolean;
  onInstall: () => void;
  onDismiss: () => void;
}): JSX.Element | null {
  if (dismissed || kind === 'installed' || kind === 'unavailable') return null;

  return (
    <aside className="strip" role="complementary" aria-label="Add to home screen">
      <div className="strip__body">
        <div className="strip__title">Keep {name} on your phone</div>
        {kind === 'prompt' ? (
          <p className="strip__text">Add it to your home screen and today&rsquo;s times are one tap away, even with no signal.</p>
        ) : (
          // iOS: no API exists, so the only honest thing is to say which buttons to press.
          <p className="strip__text">
            Tap <Share size={14} aria-label="the Share button" style={{ verticalAlign: '-0.15em' }} /> below, then{' '}
            <b>
              Add to Home Screen <Plus size={13} aria-hidden="true" style={{ verticalAlign: '-0.1em' }} />
            </b>
            .
          </p>
        )}
      </div>
      {kind === 'prompt' && (
        <button className="btn btn--primary strip__go" onClick={onInstall}>
          <ArrowUpFromLine size={15} aria-hidden="true" />
          Add
        </button>
      )}
      <button className="icon-btn strip__close" onClick={onDismiss} aria-label="Not now">
        <X size={17} aria-hidden="true" />
      </button>
    </aside>
  );
}

/**
 * A new build is cached and waiting.
 *
 * It is never applied on our own initiative. Swapping the service worker reloads the page, and
 * doing that to someone mid-read — on a page whose whole job is to be glanceable — is worse
 * than being one version behind for another minute.
 */
export function UpdateStrip({ onApply }: { onApply: () => void }): JSX.Element {
  return (
    <aside className="strip" role="status">
      <div className="strip__body">
        <div className="strip__title">A new version is ready</div>
        <p className="strip__text">Refresh to use it. Your times are unaffected either way.</p>
      </div>
      <button className="btn btn--primary strip__go" onClick={onApply}>
        <RefreshCw size={15} aria-hidden="true" />
        Refresh
      </button>
    </aside>
  );
}
