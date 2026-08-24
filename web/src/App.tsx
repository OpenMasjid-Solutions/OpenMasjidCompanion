// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The app shell and its router.
 *
 * There is no router library. This app has a handful of flat routes and the whole point
 * of the musalli half is that it is small enough to open instantly on a phone with one
 * bar of signal — a router is a dependency and a few kilobytes for a `switch`.
 *
 * The one thing the routing MUST get right is the base path: `stripBase` turns the real
 * `location.pathname` (which behind the tunnel still carries "/companion") into the route
 * this code reasons about, and every link goes back through `withBase`.
 */
import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { CalendarClock, Github } from 'lucide-react';
import { api, type AppInfo } from './api';
import { stripBase, withBase } from './base';
import { useAppearanceSync } from './prefs';
import { useSkyPhase } from './sky';
import { Scene, MasjidLogo, Note } from './ui';

/**
 * The admin panel is LAZY, and this line is the reason the musalli bundle stays small.
 *
 * A musalli opens this on a phone to read one number; the panel is used by one volunteer at a
 * desk. Vite splits it into its own chunk, and because the build uses a relative `base` the
 * chunk's URL resolves against the injected `<base href>` — so it loads correctly under the
 * tunnel prefix too, with nothing baked in at build time.
 */
const Admin = lazy(() => import('./admin/Admin'));

/** The routes this app answers. Anything else renders the not-found state rather than a
 *  blank page — a mistyped or stale link should say so. */
type Route = '/' | '/admin' | 'unknown';

function routeOf(pathname: string): Route {
  const p = stripBase(pathname).replace(/\/+$/, '') || '/';
  if (p === '/') return '/';
  if (p === '/admin' || p.startsWith('/admin/')) return '/admin';
  return 'unknown';
}

/** Client-side navigation that keeps the base path on the URL bar. */
export function navigate(to: string): void {
  history.pushState(null, '', withBase(to));
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function App(): JSX.Element {
  const [route, setRoute] = useState<Route>(() => routeOf(location.pathname));
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    const on = () => setRoute(routeOf(location.pathname));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  useEffect(() => {
    void api.get<AppInfo>('/api/app').then((r) => {
      if (r.ok) setInfo(r.data);
    });
  }, []);

  useAppearanceSync();

  /**
   * The time of day, for the musalli page's sky.
   *
   * No timezone yet: until a masjid has picked a timetable this app has no idea what zone it
   * is meant to be in, and inventing one would be the first step down a road this app does not
   * go down. It follows the device clock, which is right for the person holding it, and
   * switches to the MASJID's zone in the slice that brings the timetable — the same rule every
   * other time on this page will follow.
   */
  const sky = useSkyPhase();

  const go = useCallback((to: string) => (e: React.MouseEvent) => {
    // Let a middle-click or a modified click open a new tab, as any link should.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  }, []);

  const isAdmin = route === '/admin';

  return (
    <>
      {/* The admin keeps the family's aurora; the musalli page gets the sky. See ui.tsx. */}
      <Scene sky={isAdmin ? undefined : sky} />
      <div className="shell">
        {!isAdmin && (
          <header className="topbar">
            <a className="brand" href={withBase('/')} onClick={go('/')}>
              {/* The masjid's own logo when they have one, our mark when they do not — the app
                  on a musalli's phone is theirs, not ours. */}
              <MasjidLogo />
              <b>Prayer times</b>
            </a>
            <span className="spacer" />
          </header>
        )}

        {route === '/' && <Home />}
        {isAdmin && (
          <Suspense
            fallback={
              <main className="centre-wrap">
                <span className="spinner" />
              </main>
            }
          >
            <Admin info={info} />
          </Suspense>
        )}
        {route === 'unknown' && <NotFound onHome={go('/')} />}

        {!isAdmin && <Foot info={info} />}
      </div>
    </>
  );
}

/**
 * The musalli's home.
 *
 * Right now it has one honest thing to say. The timetable arrives from OpenMasjid Display
 * over the Fabric in a later slice; until a masjid has picked one, this app has NO prayer
 * times, and the single most important rule it has is that it must never invent any. So
 * this state is not a placeholder to be replaced by "loading" — it is the real, permanent
 * answer for a masjid that has not finished setting up, and it stays exactly this calm.
 */
function Home(): JSX.Element {
  return (
    <main className="centre-wrap">
      <section className="glass centre-card">
        <span className="centre-emblem">
          <CalendarClock size={26} strokeWidth={1.75} aria-hidden="true" />
        </span>
        <h1 className="centre-title">Prayer times aren&rsquo;t set up yet</h1>
        <p className="centre-lead">
          This masjid hasn&rsquo;t finished setting up their app. Once they have, today&rsquo;s times will be
          right here &mdash; and you&rsquo;ll be able to add this page to your phone&rsquo;s home screen.
        </p>
        <Note>Nothing is shown here until the masjid connects their own timetable, so no time on this page is ever a guess.</Note>
      </section>
    </main>
  );
}

function NotFound({ onHome }: { onHome: (e: React.MouseEvent) => void }): JSX.Element {
  return (
    <main className="centre-wrap">
      <section className="glass centre-card">
        <h1 className="centre-title">That page isn&rsquo;t here</h1>
        <p className="centre-lead">The link may be old, or mistyped.</p>
        <a className="btn btn--primary" href={withBase('/')} onClick={onHome}>
          Go to prayer times
        </a>
      </section>
    </main>
  );
}

/**
 * The footer carries the AGPL source link.
 *
 * This app is reached over a network by people who never installed it, which is exactly
 * the situation AGPL §13 is about: they are users of the software, and the offer of
 * source has to reach them, not only the admin. It is small and out of the way, because
 * the musalli came here for a prayer time.
 */
function Foot({ info }: { info: AppInfo | null }): JSX.Element {
  return (
    <footer className="page-foot">
      <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidCompanion" target="_blank" rel="noopener noreferrer">
        <Github size={12} style={{ verticalAlign: '-0.1em', marginInlineEnd: '0.25rem' }} aria-hidden="true" />
        OpenMasjid Companion{info ? ` ${info.version}` : ''}
      </a>
    </footer>
  );
}
