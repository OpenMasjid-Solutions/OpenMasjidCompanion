// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Small shared pieces of the interface. Anything used on more than one screen lives here
 * so the musalli page and the admin panel cannot drift into looking like two apps.
 */
import { type ReactNode, useState } from 'react';
import { withBase } from './base';
import { safeImageUrl, usePrefs } from './prefs';
import type { SkyPhase } from './sky';

/**
 * The ambient backdrop, in two forms.
 *
 * With a `sky` phase — the MUSALLI page — the background follows the time of day: deep at
 * night, warm at dawn, open at midday. It is the identity of this app, and the reason is in
 * docs/DESIGN_LANGUAGE.md: someone opening this at Fajr in a dark room should be able to tell
 * what part of the day they are in before reading a word.
 *
 * Without one — the ADMIN panel — it is the family's aurora scene, because a volunteer at a
 * desk should feel like they are still inside OpenMasjidOS.
 *
 * A custom wallpaper image REPLACES either entirely rather than layering over it: the aurora
 * and the sky are both tuned for their own gradient, and drawing them on someone's photograph
 * looks like a mistake. The URL is sanitised (`safeImageUrl`) before it reaches `url(...)`,
 * because it arrives from the attacker-craftable `#omos=` fragment and lands inside a CSS
 * function where a quote would escape the context.
 */
export function Scene({ sky }: { sky?: SkyPhase }): JSX.Element {
  const { wallpaperImage } = usePrefs();
  const img = safeImageUrl(wallpaperImage);
  if (img) return <div className="scene-img" style={{ backgroundImage: `url(${img})` }} aria-hidden="true" />;
  if (sky) {
    return (
      <div className="sky" data-sky={sky} aria-hidden="true">
        <div className="sky__body" />
        <div className="sky__stars" />
      </div>
    );
  }
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
 * The masjid's own logo, relayed from OpenMasjidOS by our server.
 *
 * The fallback is the whole design here. Most masjids will not have set a logo, and the route
 * answers a plain 404 for them — a normal state, not an error — so `onError` quietly puts our
 * own mark in its place. That means the header is never empty and never broken, whether the
 * masjid has a logo, has not set one, or has one the platform cannot serve this second.
 *
 * The image is decorative: the masjid's NAME sits next to it as text, so a screen reader that
 * announced the logo too would just say the same thing twice.
 */
export function MasjidLogo({ size = 30 }: { size?: number }): JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) return <BrandMark size={size} />;
  return (
    <img
      className="brand-mark"
      src={withBase('/api/public/logo')}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      decoding="async"
      onError={() => setFailed(true)}
      style={{ display: 'block', flex: 'none', objectFit: 'contain', borderRadius: '0.4rem' }}
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
