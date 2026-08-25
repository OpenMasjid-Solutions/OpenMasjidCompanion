// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The admin panel.
 *
 * This module is LAZY-LOADED and must stay that way. The musalli half of this app is opened on
 * a phone, on masjid wifi, sometimes on one bar of mobile data, by someone who wants one number
 * — and the admin panel is used by one person, at a desk, a handful of times. Letting the panel
 * into the first load would make every musalli pay for it.
 *
 * The screens it will hold — Timetable, Donations, Notifications, Share, Settings — arrive with
 * the features they configure. What is here is the setup checklist, and the first item on it is
 * real: everything this app does depends on being reachable from outside the building.
 */
import { useCallback, useEffect, useState } from 'react';
import { BellRing, CalendarClock, Gift } from 'lucide-react';
import { api } from '../api';
import { stripBase, withBase } from '../base';
import { navigate } from '../App';
import { BrandMark, Note } from '../ui';
import type { AppInfo } from '../api';
import { useSession } from './session';
import { Auth } from './Auth';
import { AccountMenu } from './AccountMenu';
import { RemoteAccess, type RemoteStatus } from './RemoteAccess';
import { TimetablePicker, type TimetableStatus } from './Timetable';
import { Appearance, type PwaStatus } from './Appearance';
import { Poster, Share } from './Share';

interface AdminStatus {
  remote: RemoteStatus;
  timetable: TimetableStatus;
  pwa: PwaStatus;
}

export default function Admin({ info }: { info: AppInfo | null }): JSX.Element {
  const { state, error, reload } = useSession();
  const [reloading, setReloading] = useState(false);

  const refresh = useCallback(async () => {
    setReloading(true);
    await reload();
    setReloading(false);
  }, [reload]);

  const version = info?.version ?? '';
  const signedIn = state?.kind === 'in';

  /**
   * The panel's own sub-route.
   *
   * App collapses every `/admin/*` path to one route, so moving between the panel and the
   * poster does not change App's state and nothing there re-renders. Reading `location` during
   * render would therefore go stale the moment it mattered — so this listens for itself.
   */
  const [subRoute, setSubRoute] = useState(() => stripBase(location.pathname).replace(/\/+$/, ''));
  useEffect(() => {
    const on = () => setSubRoute(stripBase(location.pathname).replace(/\/+$/, ''));
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);

  // ── The state of everything this app depends on ────────────────────────────
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const loadStatus = useCallback(async () => {
    const r = await api.get<AdminStatus>('/api/admin/status');
    if (r.ok) setStatus(r.data);
  }, []);
  useEffect(() => {
    if (signedIn) void loadStatus();
  }, [signedIn, loadStatus]);

  // First load, before the session answer. Deliberately quiet — a flash of a login form for
  // someone who is already signed in is worse than a moment of nothing.
  if (!state && !error) {
    return (
      <main className="centre-wrap">
        <span className="spinner" />
      </main>
    );
  }

  if (error && !state) {
    return (
      <main className="centre-wrap">
        <section className="glass centre-card">
          <h1 className="centre-title">Can&rsquo;t reach this app</h1>
          <p className="centre-lead">{error}</p>
          <button className="btn btn--primary" onClick={refresh} disabled={reloading}>
            {reloading ? <span className="spinner" /> : 'Try again'}
          </button>
        </section>
      </main>
    );
  }

  if (state && state.kind !== 'in') {
    return (
      <>
        <Topbar />
        <Auth state={state} onSignedIn={refresh} />
      </>
    );
  }

  const session = state!.session;
  const remote = status?.remote;

  // A sub-route rather than a card: the poster is laid out for a sheet of A4 and the print
  // stylesheet hides everything else on the page. Kept under /admin so it stays behind the
  // login — the public URL is not a secret, but the panel is not a place to wander into.
  if (subRoute === '/admin/poster') {
    return (
      <Poster
        publicUrl={remote?.publicUrl ?? ''}
        masjidName={status?.timetable.masjidName ?? ''}
        appName={status?.pwa.effectiveName ?? ''}
        onBack={() => navigate('/admin')}
      />
    );
  }

  return (
    <>
      <Topbar>
        <AccountMenu username={session.username} version={version} onSignedOut={refresh} />
      </Topbar>

      <main className="admin">
        <div className="page-head">
          <h1 className="page-title">Set up your app</h1>
          <p className="page-sub">
            {session.username ? `Signed in as ${session.username}.` : 'Signed in.'} Here&rsquo;s what still needs doing before
            anyone can use this on their phone.
          </p>
        </div>

        <div className="stack">
          {/* The one live step. Until this is done the rest cannot work, so it goes first and
              says why rather than sitting in a list of equals. */}
          {remote ? (
            <RemoteAccess status={remote} onChanged={loadStatus} />
          ) : (
            <section className="glass panel">
              <span className="spinner" />
            </section>
          )}

          {/* Live once the app is embedded. Standalone there is no Display to read from, so
              the honest thing is to say what it would do rather than show a picker that cannot
              be filled. */}
          {status?.timetable && remote?.configured ? (
            <TimetablePicker status={status.timetable} onChanged={loadStatus} />
          ) : (
            <Todo
              icon={<CalendarClock size={18} aria-hidden="true" />}
              title="Choose your prayer timetable"
              body="Companion reads your times from OpenMasjid Display, so the times on a phone are the same ones on the wall. It never calculates a prayer time of its own."
            />
          )}
          <Todo
            icon={<Gift size={18} aria-hidden="true" />}
            title="Add your appeals"
            body="Paste the share link of any appeal from OpenMasjid Donations and it appears in the app, tapping through to your own donation page to give."
          />
          {status?.pwa && <Appearance status={status.pwa} onChanged={loadStatus} />}

          {remote && (
            <Share
              publicUrl={remote.publicUrl}
              enabled={remote.enabled}
              masjidName={status?.timetable.masjidName ?? ''}
              onPoster={() => navigate('/admin/poster')}
            />
          )}
        </div>

        {remote?.configured && <AlertCheck />}

        <div style={{ marginBlockStart: '1.25rem' }}>
          <Note>
            This is an early build. Each step above arrives in its own update &mdash; check{' '}
            <b>What&rsquo;s new</b> in the account menu to see what a build actually does.
          </Note>
        </div>
      </main>
    </>
  );
}

function Topbar({ children }: { children?: React.ReactNode }): JSX.Element {
  return (
    <header className="topbar">
      <a className="brand" href={withBase('/')}>
        <BrandMark />
        <b>Companion</b>
      </a>
      <span className="spacer" />
      {children}
    </header>
  );
}

/**
 * "Will I actually be told when something breaks?"
 *
 * An alert channel is otherwise discovered to be misconfigured at the exact moment it was
 * needed. Where the alert is routed — email, a webhook, nothing at all — is chosen in
 * OpenMasjidOS and we cannot read it, so a round trip is genuinely the only way either of us
 * can find out that it works.
 *
 * "You've turned this alert off" is reported plainly rather than as a failure. It is the
 * admin's own setting, and this app has no business second-guessing it.
 */
function AlertCheck(): JSX.Element {
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string>('');

  const send = async () => {
    setSending(true);
    setResult('');
    const r = await api.post<{ result: string }>('/api/admin/alert/test');
    setResult(
      !r.ok
        ? r.error
        : r.data.result === 'sent'
          ? 'Sent. It should reach you wherever you route alerts in OpenMasjidOS.'
          : r.data.result === 'disabled_by_admin'
            ? 'OpenMasjidOS has this alert switched off, so nothing was sent. That’s a setting on their end, not a problem here.'
            : 'We couldn’t reach OpenMasjidOS to send it.',
    );
    setSending(false);
  };

  return (
    <section className="glass panel" style={{ marginBlockStart: '0.75rem' }}>
      <div className="card-head">
        <span className="panel-ico">
          <BellRing size={18} aria-hidden="true" />
        </span>
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title">Check your alerts reach you</h2>
          </div>
          <p className="card-body">
            If this app ever loses your prayer times, it tells you through OpenMasjidOS. Send a test now so you
            know that works before it matters.
          </p>
          {result && <p className="muted card-body">{result}</p>}
          <div className="card-actions">
            <button className="btn" onClick={send} disabled={sending}>
              {sending ? <span className="spinner" /> : 'Send a test alert'}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Todo({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }): JSX.Element {
  return (
    <section className="glass panel">
      <div className="card-head">
        <span className="panel-ico">{icon}</span>
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title">{title}</h2>
            <span className="badge">Coming soon</span>
          </div>
          <p className="card-body">{body}</p>
        </div>
      </div>
    </section>
  );
}
