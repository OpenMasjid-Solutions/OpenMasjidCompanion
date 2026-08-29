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
import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { Clock3, Github, HandCoins } from 'lucide-react';
import { api, type AppInfo } from './api';
import { stripBase, withBase } from './base';
import { useAppearanceSync, setThemeOverride } from './prefs';
import { PERIOD_SURFACE } from './periodTheme';
import { jumuahLabels, type PeriodKey } from './prayerTimes';
import { useInstall, useServiceWorker } from './pwa';
import { InstallPrompt, UpdateBanner } from './Install';
import { Scene } from './ui';
import { MasjidHeader, Today, type Timetable } from './Today';
import { Give, useCampaigns } from './Give';
import { Notify, NotifyButton } from './Notify';
import { TabBar, type Tab } from './Tabs';

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
export type Route = '/' | '/give' | '/admin' | 'unknown';

export function routeOf(pathname: string): Route {
  const p = stripBase(pathname).replace(/\/+$/, '') || '/';
  if (p === '/') return '/';
  if (p === '/give') return '/give';
  if (p === '/admin' || p.startsWith('/admin/')) return '/admin';
  return 'unknown';
}

/**
 * Where to land someone who has just arrived, or null to leave them where they are.
 *
 * Pressing "Open" on Companion in the OpenMasjidOS dashboard is an ADMIN action — they want the
 * settings, not the page a musalli sees. The platform always opens an app at its root and has no
 * manifest field for a path, so the app makes the decision itself from the `#omos=` fragment the
 * dashboard attaches (see prefs.ts).
 *
 * Only ever from the ROOT. Someone opening a deep link already said where they wanted to go, and
 * redirecting them away from it would be worse than landing them on the wrong page once.
 *
 * Pure, so the rule can be tested without a browser.
 */
export function dashboardLanding(route: Route, openedFromDashboard: boolean): string | null {
  if (!openedFromDashboard) return null;
  return route === '/' ? '/admin' : null;
}

/**
 * The tabs, which are only the places there are to go.
 *
 * Salah always. Donate only once we know the masjid has appeals — `null` is "we have not asked
 * yet", and drawing a tab on a maybe would make it flicker in a moment after the page settles.
 * Qibla joins this list when it is built; the bar is deliberately data-driven so that is one
 * entry rather than a layout change.
 *
 * Pure, so the rule can be tested without a browser.
 */
export function tabsFor(appeals: number | null): Tab[] {
  const tabs: Tab[] = [{ route: '/', label: 'Salah', icon: Clock3 }];
  if (appeals && appeals > 0) tabs.push({ route: '/give', label: 'Donate', icon: HandCoins });
  return tabs;
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
  /** Which part of the day it is, reported up by Today. Drives the whole page's look. */
  const [period, setPeriod] = useState<PeriodKey | null>(null);

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
   * Install and offline both need a SECURE CONTEXT, and the server is what knows whether we
   * have one — a page reached at http://192.168.1.20:7880 is a perfectly normal way for a
   * kiosk to open this app, and must not be told it is broken. Over plain HTTP the worker is
   * never registered and no install strip appears, which is correct rather than a limitation.
   */
  const secure = !!info?.remote.secure;
  const { updateReady, applyUpdate } = useServiceWorker(secure);
  const install = useInstall(secure);

  // Fetched here rather than in the page, because the TAB BAR needs to know whether there is a
  // Donate tab at all — and because doing it per page would re-request on every switch.
  const appeals = useCampaigns(!isAdmin);
  const tabs = useMemo(() => tabsFor(appeals && appeals.length), [appeals]);
  const [notifyOpen, setNotifyOpen] = useState(false);

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

  /**
   * The musalli page themes itself by the TIME OF DAY, not by the browser's light/dark setting:
   * Fajr is dark, Duha is light, Maghrib is dark again, and each period has its own sky with the
   * sun in a different place. So the period sets both the attribute the sky keys off AND the
   * light/dark surface, overriding the reader's preference for as long as they are on this page.
   *
   * The admin panel keeps following the preference — it is a settings screen, and a volunteer
   * who set their dashboard to dark should not find it bright at noon.
   */
  useEffect(() => {
    const el = document.documentElement;
    if (isAdmin || !period) {
      el.removeAttribute('data-period');
      setThemeOverride(null);
      return;
    }
    el.setAttribute('data-period', period);
    setThemeOverride(PERIOD_SURFACE[period]);
  }, [isAdmin, period]);

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

  const showTabs = !isAdmin && tabs.length > 1;

  return (
    <>
      <Scene sky={!isAdmin} />
      {/* Above everything, so a version notice is the first thing seen rather than the last
          thing scrolled to. Fixed, so it does not shove the page down under a reading thumb. */}
      {!isAdmin && updateReady && <UpdateBanner onApply={applyUpdate} />}
      <div className={showTabs ? 'shell shell--tabs' : 'shell'}>
        {!isAdmin && (
          <MasjidHeader
            name={times?.masjid?.name || 'Prayer times'}
            action={<NotifyButton secure={secure} onOpen={() => setNotifyOpen(true)} />}
          />
        )}

        {route === '/' &&
          (times ? (
            <Today data={times} onPeriod={setPeriod} />
          ) : (
            <main className="centre-wrap">
              <span className="spinner" />
            </main>
          ))}

        {route === '/give' && <Give tiles={appeals} language={times?.masjid?.language ?? 'en'} />}

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

        {!isAdmin && route === '/' && times?.masjid && (
          <InstallPrompt
            kind={install.kind}
            name={info?.installName || times.masjid.name}
            dismissed={install.dismissed}
            onInstall={() => void install.install()}
            onDismiss={install.dismiss}
          />
        )}

        {!isAdmin && <Foot />}
      </div>
      {!isAdmin && <TabBar tabs={tabs} route={route} onGo={go} />}
      {!isAdmin && notifyOpen && (
        <Notify secure={secure} jumuah={jumuahLabels(times?.days ?? [])} onClose={() => setNotifyOpen(false)} />
      )}
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
 * This app is reached over a network by people who never installed it, which is exactly the
 * situation AGPL §13 is about: they are users of the software, and the offer of source has to
 * reach them, not only the admin. It is small and out of the way, because the musalli came here
 * for a prayer time.
 *
 * No version number. It meant something to whoever built this and nothing at all to the person
 * reading it, and the licence obligation is that the source is REACHABLE, not that the build is
 * labelled. The admin panel still shows the version, where it is the thing being asked about.
 */
function Foot(): JSX.Element {
  return (
    <footer className="page-foot">
      <a href="https://github.com/OpenMasjid-Solutions/OpenMasjidCompanion" target="_blank" rel="noopener noreferrer">
        <Github size={12} style={{ verticalAlign: '-0.1em', marginInlineEnd: '0.25rem' }} aria-hidden="true" />
        OpenMasjid Solutions
      </a>
    </footer>
  );
}
