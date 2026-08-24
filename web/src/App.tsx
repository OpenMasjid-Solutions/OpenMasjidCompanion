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
import { Github } from 'lucide-react';
import { api, type AppInfo } from './api';
import { stripBase, withBase } from './base';
import { useAppearanceSync } from './prefs';
import { Scene } from './ui';
import { MasjidHeader, Today, type Timetable } from './Today';

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
  const [times, setTimes] = useState<Timetable | null>(null);

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

  const isAdmin = route === '/admin';

  /**
   * The MUSALLI surface has its own fixed palette (coral on navy, from the reference design),
   * while the admin panel keeps inheriting the masjid's OpenMasjidOS accent. Set on the root
   * element so the whole cascade can be scoped to it in one place — see app.css.
   */
  useEffect(() => {
    const el = document.documentElement;
    if (isAdmin) el.removeAttribute('data-surface');
    else el.setAttribute('data-surface', 'musalli');
  }, [isAdmin]);

  // The timetable is only needed by the musalli half, so the admin panel does not pay for it.
  useEffect(() => {
    if (isAdmin) return;
    let alive = true;
    const pull = () =>
      void api.get<Timetable>('/api/public/timetable').then((r) => {
        if (alive && r.ok) setTimes(r.data);
      });
    pull();
    // A page left open in the prayer hall should pick up an Iqamah change without being
    // reloaded. Rare enough to cost nothing; the server's own cache absorbs it.
    const id = setInterval(pull, 10 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [isAdmin]);

  const go = useCallback((to: string) => (e: React.MouseEvent) => {
    // Let a middle-click or a modified click open a new tab, as any link should.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(to);
  }, []);

  return (
    <>
      <Scene sky={!isAdmin} />
      <div className="shell">
        {!isAdmin && <MasjidHeader name={times?.masjid?.name || 'Prayer times'} />}

        {route === '/' &&
          (times ? (
            <Today data={times} />
          ) : (
            <main className="centre-wrap">
              <span className="spinner" />
            </main>
          ))}

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
