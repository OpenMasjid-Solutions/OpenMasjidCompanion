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
 * Slice 2 is the shell and the way in. The screens it will hold — Setup, Timetable, Donations,
 * Notifications, Share, Settings — arrive with the features they configure.
 */
import { useCallback, useState } from 'react';
import { CalendarClock, Gift, Share2, Wifi } from 'lucide-react';
import { withBase } from '../base';
import { BrandMark, Note } from '../ui';
import type { AppInfo } from '../api';
import { useSession } from './session';
import { Auth } from './Auth';
import { AccountMenu } from './AccountMenu';

export default function Admin({ info }: { info: AppInfo | null }): JSX.Element {
  const { state, error, reload } = useSession();
  const [reloading, setReloading] = useState(false);

  const refresh = useCallback(async () => {
    setReloading(true);
    await reload();
    setReloading(false);
  }, [reload]);

  const version = info?.version ?? '';

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
        <header className="topbar">
          <a className="brand" href={withBase('/')}>
            <BrandMark />
            <b>Companion</b>
          </a>
          <span className="spacer" />
        </header>
        <Auth state={state} onSignedIn={refresh} />
      </>
    );
  }

  const session = state!.session;

  return (
    <>
      <header className="topbar">
        <a className="brand" href={withBase('/')}>
          <BrandMark />
          <b>Companion</b>
        </a>
        <span className="spacer" />
        <AccountMenu username={session.username} version={version} onSignedOut={refresh} />
      </header>

      <main className="admin">
        <div className="page-head">
          <h1 className="page-title">Set up your app</h1>
          <p className="page-sub">
            {session.username ? `Signed in as ${session.username}.` : 'Signed in.'} Here&rsquo;s what still needs doing before
            anyone can use this on their phone.
          </p>
        </div>

        {/* The honest state of a build at this version. Each of these becomes a real screen in
            its own slice; saying so plainly beats showing four dead buttons. */}
        <div className="stack">
          <Todo
            icon={<Wifi size={18} aria-hidden="true" />}
            title="Turn on Remote access"
            body="This app is only useful over the internet — a QR code pointing inside your building works for nobody outside it. You'll switch this on in OpenMasjidOS and share this app."
            soon
          />
          <Todo
            icon={<CalendarClock size={18} aria-hidden="true" />}
            title="Choose your prayer timetable"
            body="Companion reads your times from OpenMasjid Display, so the times on a phone are the same ones on the wall. It never calculates a prayer time of its own."
            soon
          />
          <Todo
            icon={<Gift size={18} aria-hidden="true" />}
            title="Add your appeals"
            body="Paste the share link of any appeal from OpenMasjid Donations and it appears in the app, tapping through to your own donation page to give."
            soon
          />
          <Todo
            icon={<Share2 size={18} aria-hidden="true" />}
            title="Print the poster"
            body="A QR code and a printable poster for the noticeboard, pointing at your real public address."
            soon
          />
        </div>

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

function Todo({ icon, title, body, soon }: { icon: React.ReactNode; title: string; body: string; soon?: boolean }): JSX.Element {
  return (
    <section className="glass panel">
      <div className="card-head">
        <span className="panel-ico">{icon}</span>
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title">{title}</h2>
            {soon && <span className="badge">Coming soon</span>}
          </div>
          <p className="muted" style={{ marginBlockStart: '0.3rem', fontSize: '0.9rem', lineHeight: 1.55 }}>
            {body}
          </p>
        </div>
      </div>
    </section>
  );
}
