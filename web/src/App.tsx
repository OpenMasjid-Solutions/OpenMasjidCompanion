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
import { Clock3, Compass, Github, HandCoins, Settings2 } from 'lucide-react';
import { api, type AppInfo } from './api';
import { ONBOARDING_PATH, stripBase, withBase } from './base';
import { useAppearanceSync, usePrefs, setThemeOverride } from './prefs';
import { surfaceFor } from './periodTheme';
import { jumuahLabels, periodOf, positionAt } from './prayerTimes';
import { useInstall, useServiceWorker } from './pwa';
import { useTelemetry } from './telemetry';
import { startButtonHaptics } from './haptics';
import { InstallPrompt, UpdateBanner } from './Install';
import { Scene } from './ui';
import { MasjidHeader, Today, useMinuteTick, type Timetable } from './Today';
import { Give, useCampaigns } from './Give';
import { Onboarding } from './Onboarding';
import { Settings } from './Settings';
import { Qibla } from './Qibla';
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
export type Route = '/' | '/give' | '/qibla' | '/settings' | '/onboarding' | '/admin' | 'unknown';

export function routeOf(pathname: string): Route {
  const p = stripBase(pathname).replace(/\/+$/, '') || '/';
  if (p === '/') return '/';
  if (p === '/give') return '/give';
  if (p === '/qibla') return '/qibla';
  if (p === '/settings') return '/settings';
  if (p === ONBOARDING_PATH) return '/onboarding';
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
 * Salah always, Settings always. Donate only once we know the masjid has appeals — `null` is
 * "we have not asked yet", and drawing a tab on a maybe would make it flicker in a moment after
 * the page settles. Qibla joins this list when it is built; the bar is deliberately data-driven
 * so that is one entry rather than a layout change.
 *
 * **Settings is what made the bar unconditional** (2026-08-29). Until it existed a masjid with
 * no appeals had exactly one page, and a single lit tab over the only screen there is is a
 * label taking up the most valuable strip of a phone. Now there are genuinely two places to go
 * on every install, so the rule in Tabs.tsx — draw nothing below two — is unchanged; it simply
 * no longer fires.
 *
 * Order is deliberate. Settings is last because it is the one nobody opens twice, and on a
 * phone the outer edges of a bar are where a thumb lands by accident.
 *
 * Pure, so the rule can be tested without a browser.
 */
export function tabsFor(appeals: number | null, secure = false): Tab[] {
  const tabs: Tab[] = [{ route: '/', label: 'Salah', icon: Clock3 }];
  if (appeals && appeals > 0) tabs.push({ route: '/give', label: 'Donate', icon: HandCoins });
  // **Only over the tunnel.** A browser will not hand a plain-HTTP page a location at all, so on
  // the masjid's own wifi this tab is a screen that can never do anything — the same rule as
  // install and notifications (docs/DESIGN_LANGUAGE.md). Hidden rather than shown-and-broken.
  if (secure) tabs.push({ route: '/qibla', label: 'Qibla', icon: Compass });
  tabs.push({ route: '/settings', label: 'Settings', icon: Settings2 });
  return tabs;
}

/**
 * Client-side navigation that keeps the base path on the URL bar.
 *
 * `replace` is for a REDIRECT rather than a move — the onboarding page sending an already
 * installed reader into the app. Pushing there would put the instructions in the history, so
 * the back gesture from the prayer times would land on them and immediately bounce forward
 * again, which on a phone reads as the app refusing to close.
 */
export function navigate(to: string, replace = false): void {
  const url = withBase(to);
  if (replace) history.replaceState(null, '', url);
  else history.pushState(null, '', url);
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

  // One delegated listener for every button, tab and chip in the app — see haptics.ts for why
  // it is not forty onClick handlers, and for the fact that none of it does anything on an
  // iPhone.
  useEffect(startButtonHaptics, []);

  useEffect(() => {
    void api.get<AppInfo>('/api/app').then((r) => {
      if (r.ok) setInfo(r.data);
    });
  }, []);

  useAppearanceSync();
  /** The reader's own say over the sky — "follow the day", or hold one polarity. See Settings. */
  const { sky } = usePrefs();

  /**
   * Which part of the day it is at THIS MASJID. Worked out here, from the timetable, on every
   * route.
   *
   * It used to be reported upward by the day view, which meant the sky was only ever right on
   * the one screen that mounted it: a reload on Settings, Qibla or the appeals left the app in
   * its "we do not know what time it is there" dark at two in the afternoon. The timetable is
   * fetched here anyway, and the masjid's own IANA zone comes with it, so there was never a
   * reason for the answer to live further down.
   *
   * `useMinuteTick` rather than the render clock: the period changes at a jamāʿah, and a page
   * left open through Maghrib should get dark without being touched.
   */
  const minute = useMinuteTick();
  const period = useMemo(() => {
    if (!times?.masjid || times.days.length === 0) return null;
    return periodOf(positionAt(times.days, times.masjid.timezone, minute));
  }, [times, minute]);

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
  const tabs = useMemo(() => tabsFor(appeals && appeals.length, secure), [appeals, secure]);

  /**
   * The onboarding page is its own world: its own header, no tabs, and no install modal over
   * the install instructions. Everything the shell would normally draw is a distraction from
   * the one thing somebody who just scanned a QR code is here to do.
   */
  const bare = route === '/onboarding';

  // What kind of phone opened this, once a day, as three enum values and nothing else. Never on
  // the admin panel — a volunteer opening their own settings is not a musalli, and counting
  // them would put one laptop in every masjid's numbers. See telemetry.ts.
  useTelemetry(!isAdmin);

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
    if (isAdmin) {
      el.removeAttribute('data-period');
      setThemeOverride(null);
      return;
    }
    // The whole rule, including what to do when we do not know the time at this masjid yet, is
    // in `surfaceFor` — where it can be tested, and where the sky and the ink that has to stay
    // legible on it are decided together rather than in two places that can disagree.
    const { period: shown, surface } = surfaceFor(period, sky);
    if (shown) el.setAttribute('data-period', shown);
    else el.removeAttribute('data-period');
    setThemeOverride(surface);
  }, [isAdmin, period, sky]);

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

  const showTabs = !isAdmin && !bare && tabs.length > 1;
  const jumuah = useMemo(() => jumuahLabels(times?.days ?? []), [times]);

  return (
    <>
      <Scene sky={!isAdmin} />
      {/* Above everything, so a version notice is the first thing seen rather than the last
          thing scrolled to. Fixed, so it does not shove the page down under a reading thumb. */}
      {!isAdmin && updateReady && <UpdateBanner onApply={applyUpdate} />}
      <div className={showTabs ? 'shell shell--tabs' : 'shell'}>
        {/* No action in the header any more. The bell that used to sit here was a shortcut to
            the reminder switches, and it was removed on 2026-08-30: with a permanent Settings
            tab at the bottom of every screen, a second door to the same room is a second thing
            to explain, and the top-right of a prayer-times page is the most valuable corner it
            has. */}
        {!isAdmin && !bare && <MasjidHeader name={times?.masjid?.name || 'Prayer times'} />}

        {route === '/' &&
          (times ? (
            <Today data={times} />
          ) : (
            <main className="centre-wrap">
              <span className="spinner" />
            </main>
          ))}

        {route === '/give' && <Give tiles={appeals} language={times?.masjid?.language ?? 'en'} />}

        {route === '/qibla' && <Qibla secure={secure} />}

        {route === '/settings' && (
          <Settings
            secure={secure}
            jumuah={jumuah}
            installed={install.installed}
            contact={info?.contact ?? null}
            masjidName={times?.masjid?.name || info?.installName || ''}
          />
        )}

        {route === '/onboarding' && (
          <Onboarding install={install} secure={secure} name={info?.installName || times?.masjid?.name || 'Prayer times'} />
        )}

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
            route={install.route}
            os={install.os}
            name={info?.installName || times.masjid.name}
            dismissed={install.dismissed}
            onInstall={() => void install.install()}
            onDismiss={install.dismiss}
          />
        )}

        {/* The AGPL source offer, on the Settings screen only (Hasan, 2026-08-31).
            §13's requirement is that the offer REACHES a network user, not that it is on every
            screen — and Settings is one tap away from all of them, on a tab bar that is always
            drawn. It was under the prayer times, which is the one screen somebody opens to read
            a single number. */}
        {!isAdmin && route === '/settings' && <Foot />}
      </div>
      {showTabs && <TabBar tabs={tabs} route={route} onGo={go} />}
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
