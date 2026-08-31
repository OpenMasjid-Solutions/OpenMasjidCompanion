// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * "Is this app actually reachable from a phone?" — the first thing the setup flow has to
 * settle, and the one step a masjid cannot skip.
 *
 * Everything this app is FOR lives on the far side of the tunnel. The QR code on the
 * noticeboard, adding it to a home screen, prayer notifications — none of them exist over
 * plain HTTP on the masjid's LAN, because browsers do not give a non-secure page a service
 * worker or the Push API at all. So until Remote access is on and this app is shared, the
 * honest thing is to say so and stop, rather than to show a QR code that works for nobody
 * outside the building (CLAUDE.md §6.4).
 *
 * FOUR STATES, and the reason they are four rather than two:
 *
 *   not configured  — a standalone install with no OpenMasjidOS at all. Nothing is wrong.
 *   unreachable     — we could not ask. The setting may well already be correct.
 *   off             — we asked, and it is genuinely off. This is the blocking step.
 *   on              — done, and here is the address a musalli will actually use.
 *
 * Collapsing "unreachable" into "off" is the mistake worth naming: it sends a volunteer to
 * change a setting that was already right, and then tells them it did not work.
 */
import { useState } from 'react';
import { Check, Globe, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react';
import { api } from '../api';
import { Note } from '../ui';

export interface RemoteStatus {
  configured: boolean;
  enabled: boolean;
  publicUrl: string;
  domain: string;
  basePath: string;
  reachable: boolean;
  checkedAt: number;
}

export function RemoteAccess({ status, onChanged }: { status: RemoteStatus; onChanged: () => void }): JSX.Element {
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');

  const check = async () => {
    setChecking(true);
    setError('');
    const r = await api.post('/api/admin/site/refresh');
    if (!r.ok) setError(r.error);
    onChanged();
    setChecking(false);
  };

  const CheckButton = ({ label = 'Check again' }: { label?: string }) => (
    <button className="btn" onClick={check} disabled={checking}>
      {checking ? <span className="spinner" /> : <RefreshCw size={15} aria-hidden="true" />}
      {label}
    </button>
  );

  // ── Standalone: no platform, and nothing to fix ────────────────────────────
  if (!status.configured) {
    return (
      <Card icon={<Globe size={18} aria-hidden="true" />} title="Running on its own" badge={<span className="badge">Standalone</span>}>
        <p className="card-body">
          This app isn&rsquo;t installed through OpenMasjidOS, so it can&rsquo;t publish itself to the internet or read
          your timetable from OpenMasjid Display. It still works as a local page.
        </p>
        <Note>
          To put prayer times on people&rsquo;s phones, install Companion from the OpenMasjidOS App Store instead.
        </Note>
      </Card>
    );
  }

  // ── We could not ask ───────────────────────────────────────────────────────
  if (!status.reachable) {
    return (
      <Card icon={<WifiOff size={18} aria-hidden="true" />} title="Can’t reach OpenMasjidOS" badge={<span className="badge badge--warn">Unknown</span>}>
        <p className="card-body">
          We couldn&rsquo;t check whether this app is shared over the internet, so this might already be set up
          correctly. This usually means OpenMasjidOS is restarting.
        </p>
        {error && <p className="form-error">{error}</p>}
        <div className="card-actions">
          <CheckButton label="Try again" />
        </div>
      </Card>
    );
  }

  // ── On, and here is the address ────────────────────────────────────────────
  if (status.enabled) {
    return (
      <Card icon={<Check size={18} aria-hidden="true" />} title="Shared over the internet" badge={<span className="badge badge--ok">On</span>}>
        <p className="card-body">
          Your app is reachable from anywhere. This is the address a musalli&rsquo;s phone will use, and the one
          the QR code on your noticeboard will point at.
        </p>
        <p className="url-chip tnum">{status.publicUrl}</p>
        <div className="card-actions">
          <CheckButton />
        </div>
      </Card>
    );
  }

  // ── Off: the blocking step ─────────────────────────────────────────────────
  return (
    <Card icon={<TriangleAlert size={18} aria-hidden="true" />} title="Turn on Remote access" badge={<span className="badge badge--warn">Needed</span>}>
      <p className="card-body">
        Right now this app can only be opened inside your building. A QR code on the noticeboard would work
        for nobody outside it, so nothing else here can be set up until this is on.
      </p>
      {/* Deliberately words, not a link. The dashboard's address is a LAN one that the browser
          reading this page may not be able to reach — sending someone to a link that times out
          is worse than telling them where to click. */}
      <ol className="steps">
        <li>
          In OpenMasjidOS, open <b>Settings → Remote access</b> and turn it on.
        </li>
        <li>
          Find <b>Companion</b> in your apps and tick <b>Share this app over the internet</b>.
        </li>
        <li>Come back here and press Check again.</li>
      </ol>
      {error && <p className="form-error">{error}</p>}
      <div className="card-actions">
        <CheckButton />
      </div>
    </Card>
  );
}

function Card({
  icon,
  title,
  badge,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="glass panel">
      <div className="card-head">
        <span className="panel-ico">{icon}</span>
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title">{title}</h2>
            {badge}
          </div>
          {children}
        </div>
      </div>
    </section>
  );
}
