// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Curating the appeals that appear in the app.
 *
 * The masjid pastes share links — one per line, in the order they should appear. That is the
 * whole interface, and it is deliberate: Donations has no "list every campaign" endpoint, and
 * if it had one this screen would be worse for it. A masjid running a private staff appeal
 * alongside a public Ramadan one does not want the first on a noticeboard, and a list of
 * checkboxes over everything they have ever created is a way to feature the wrong thing by
 * accident. **Choosing is the feature.**
 *
 * The other half of this screen is the honest reporting underneath. An appeal can be deleted in
 * Donations, or stop accepting donations, or be on a test account that takes no real money —
 * and every one of those is invisible from here unless something says so. A tile that quietly
 * vanishes from musallis' phones with no explanation on this page is the failure this screen
 * exists to prevent.
 */
import { useEffect, useState } from 'react';
import { CircleAlert, ExternalLink, Gift, RefreshCw, TriangleAlert } from 'lucide-react';
import { api } from '../api';

export interface AdminCampaign {
  url: string;
  slug: string;
  title: string;
  health: 'ok' | 'gone' | 'unreachable';
  /** Donations' own sentence about why it cannot take a donation. '' when it can. */
  notReady: string;
  /** Why we could not read it — the actual cause, not a shrug. */
  why: string;
  /** The same in one technical line. */
  detail: string;
  testMode: boolean;
  localOnly: boolean;
}

interface Payload {
  links: string[];
  campaigns: AdminCampaign[];
  max: number;
}

export function Appeals({ onChanged }: { onChanged: () => void }): JSX.Element {
  const [data, setData] = useState<Payload | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const adopt = (p: Payload) => {
    setData(p);
    setText(p.links.join('\n'));
  };

  useEffect(() => {
    void api.get<Payload>('/api/admin/campaigns').then((r) => {
      if (r.ok) adopt(r.data);
      else setError(r.error);
    });
  }, []);

  const save = async () => {
    setBusy('save');
    setError('');
    setSaved(false);
    const links = text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    const r = await api.post<Payload>('/api/admin/campaigns', { links });
    // The server refuses the WHOLE list when one line is wrong, and says which line. Saving the
    // nine that parsed and dropping the tenth is how an appeal goes missing without anyone
    // knowing — so the text area is left exactly as typed, with the mistake still in it.
    if (!r.ok) setError(r.error);
    else {
      adopt(r.data);
      setSaved(true);
      onChanged();
    }
    setBusy('');
  };

  const recheck = async () => {
    setBusy('refresh');
    setError('');
    const r = await api.post<Payload>('/api/admin/campaigns/refresh');
    if (!r.ok) setError(r.error);
    else adopt(r.data);
    setBusy('');
  };

  const dirty = data ? text.trim() !== data.links.join('\n') : false;
  const live = data?.campaigns.filter((c) => c.health === 'ok' && !c.notReady).length ?? 0;

  return (
    <section className="glass panel">
      <div className="card-head">
        <span className="panel-ico">
          <Gift size={18} aria-hidden="true" />
        </span>
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title">Appeals</h2>
            {data && data.campaigns.length > 0 && (
              <span className={live === data.campaigns.length ? 'badge badge--ok' : 'badge badge--warn'}>
                {live} of {data.campaigns.length} showing
              </span>
            )}
          </div>

          <p className="card-body">
            Paste the share link of any appeal from OpenMasjid Donations, one per line, in the order you want them to
            appear. Musallis see the picture, the title and the progress; tapping one opens your own donation page to
            give. <b>This app never handles money.</b>
          </p>

          <div className="field">
            <label className="label" htmlFor="appeal-links">
              Share links
            </label>
            <textarea
              id="appeal-links"
              className="input textarea"
              rows={Math.max(3, Math.min(10, text.split('\n').length + 1))}
              spellCheck={false}
              value={text}
              placeholder={'https://your-masjid.example.org/donations/ramadan\nhttps://your-masjid.example.org/donations/roof-fund'}
              onChange={(e) => {
                setText(e.target.value);
                setSaved(false);
              }}
            />
            <p className="hint">
              In Donations, open an appeal and copy its share link. Up to {data?.max ?? 12}. Delete a line to take an
              appeal out of the app &mdash; it stays exactly as it is in Donations.
            </p>
          </div>

          {error && <p className="form-error">{error}</p>}
          {saved && !dirty && <p className="hint">Saved.</p>}

          {data && data.campaigns.length > 0 && (
            <ul className="appeal-list">
              {data.campaigns.map((c) => (
                <Row key={c.url} c={c} />
              ))}
            </ul>
          )}

          <div className="card-actions">
            <button className="btn btn--primary" onClick={() => void save()} disabled={!!busy || !dirty}>
              {busy === 'save' ? <span className="spinner" /> : 'Save appeals'}
            </button>
            {data && data.campaigns.length > 0 && (
              <button className="btn" onClick={() => void recheck()} disabled={!!busy}>
                {busy === 'refresh' ? <span className="spinner" /> : <RefreshCw size={15} aria-hidden="true" />}
                Check again
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/** One appeal, and every reason it might not be on a phone. */
function Row({ c }: { c: AdminCampaign }): JSX.Element {
// The server has worked out WHICH way it failed. Rendering its sentence beats re-deriving
  // one here from a status — "we couldn't reach it" on a link the admin has just opened in
  // their own browser names the one explanation they have already ruled out.
  const problem =
    c.health === 'gone'
      ? 'This appeal no longer exists in Donations, or has been made inactive. It isn’t showing in the app.'
      : c.health === 'unreachable'
        ? c.why || 'We couldn’t reach this appeal. If OpenMasjid Donations is restarting, this clears on its own.'
        : c.notReady
          ? `${c.notReady} It isn’t showing in the app while that’s true.`
          : '';

  return (
    <li className="appeal-row">
      <div className="appeal-row__main">
        <div className="appeal-row__title">
          {c.title}
          {c.health === 'ok' && !problem && <span className="badge badge--ok">Showing</span>}
          {problem && <span className="badge badge--warn">Hidden</span>}
        </div>
        <a className="appeal-row__url" href={c.url} target="_blank" rel="noopener noreferrer">
          {c.url}
          <ExternalLink size={12} aria-hidden="true" />
        </a>

        {problem && (
          <p className="appeal-row__note">
            <CircleAlert size={14} aria-hidden="true" />
            {problem}
          </p>
        )}

        {/* The technical line, for whoever can act on it. Deliberately not hidden behind a
            "details" toggle: the person reading this is trying to fix a link, and one short
            line is not clutter when it is the only line that names the actual fault. */}
        {c.detail && <p className="appeal-row__detail">{c.detail}</p>}

        {/* Test mode does NOT hide the appeal — the masjid chose to feature it and Donations
            badges it on its own page. But an appeal on a test account takes no real money, and
            finding that out from a confused donor is the wrong way round. */}
        {c.testMode && (
          <p className="appeal-row__note appeal-row__note--warn">
            <TriangleAlert size={14} aria-hidden="true" />
            This appeal is on a test account, so it takes no real money. It is still showing in the app.
          </p>
        )}

        {c.localOnly && (
          <p className="appeal-row__note appeal-row__note--warn">
            <TriangleAlert size={14} aria-hidden="true" />
            This link only works inside your building. A musalli&rsquo;s phone out on the street won&rsquo;t open it &mdash;
            use the https link from Donations&rsquo; own share button.
          </p>
        )}
      </div>
    </li>
  );
}

