// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Small shared pieces of the interface. Anything used on more than one screen lives here
 * so the musalli page and the admin panel cannot drift into looking like two apps.
 */
import type { ReactNode } from 'react';
import { withBase } from './base';
import { safeImageUrl, usePrefs } from './prefs';

/**
 * The ambient backdrop.
 *
 * A custom wallpaper image REPLACES the preset scene entirely rather than layering over
 * it — the aurora and the geometric texture are tuned for the gradient, and drawing them
 * on top of somebody's photograph looks like a mistake.
 *
 * The URL is sanitised (`safeImageUrl`) before it reaches `url(...)`, because it arrives
 * from the attacker-craftable `#omos=` fragment and lands inside a CSS function where a
 * quote would escape the context.
 */
export function Scene(): JSX.Element {
  const { wallpaperImage } = usePrefs();
  const img = safeImageUrl(wallpaperImage);
  if (img) return <div className="scene-img" style={{ backgroundImage: `url(${img})` }} aria-hidden="true" />;
  return <div className="scene" aria-hidden="true" />;
}

/**
 * The app's own mark — the crescent, dome and phone-clock that OpenMasjid Companion is
 * identified by in the App Store and on a home screen.
 *
 * Served from `public/` rather than imported as a module, because the SAME file is what
 * the server reads as the bundled default PWA icon when a masjid has not uploaded one of
 * their own. One copy in the repo, one copy in the image, one thing to change.
 *
 * `withBase` is not optional here: behind the tunnel a root-absolute "/mark-512.png"
 * would leave this app entirely.
 *
 * This is OUR mark, and it belongs to the app's own chrome. It is not what a musalli sees
 * at the top of their prayer times once a masjid has set up — that is the MASJID's name
 * and logo, because the app on their phone is the masjid's, not ours.
 */
export function BrandMark({ size = 30 }: { size?: number }): JSX.Element {
  return (
    <img
      className="brand-mark"
      src={withBase('/mark-512.png')}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      decoding="async"
      style={{ display: 'block', flex: 'none' }}
    />
  );
}

/**
 * A quiet inset strip for the states this app has to be honest about: times that are
 * stale, a masjid that has not finished setting up, remote access that is off.
 *
 * Never styled as an error. None of these is the reader's fault, and a red panel on a
 * prayer-times page reads as "something is broken" when the truthful message is usually
 * "this is the last thing we heard, and here is when".
 */
export function Note({ icon, children, tone = 'info' }: { icon?: ReactNode; children: ReactNode; tone?: 'info' | 'warn' }): JSX.Element {
  return (
    <p className={tone === 'warn' ? 'note note--warn' : 'note'}>
      {icon}
      <span>{children}</span>
    </p>
  );
}
