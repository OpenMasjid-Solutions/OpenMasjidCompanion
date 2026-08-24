// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * What the app is called and what it looks like on a musalli's home screen.
 *
 * The whole screen exists to make one thing true: the icon on someone's phone is **the
 * masjid's**, not ours. Most masjids will never touch it — the icon is already derived from the
 * logo on their prayer screens, or from their OpenMasjidOS logo — so this is where they can see
 * WHICH of those it came from, and override it if it picked wrong.
 */
import { useEffect, useRef, useState } from 'react';
import { ImageUp, RotateCcw, Smartphone } from 'lucide-react';
import { api } from '../api';
import { withBase } from '../base';
import { Note } from '../ui';

export interface PwaStatus {
  appName: string;
  effectiveName: string;
  icon: { source: 'upload' | 'display' | 'platform' | 'bundled'; at: number; hasUpload: boolean };
}

const WHERE: Record<PwaStatus['icon']['source'], string> = {
  upload: 'the image you uploaded here',
  display: 'the logo on your timetable in OpenMasjid Display',
  platform: 'your masjid logo in OpenMasjidOS',
  bundled: 'the Companion mark, because no masjid logo was found',
};

export function Appearance({ status, onChanged }: { status: PwaStatus; onChanged: () => void }): JSX.Element {
  const [name, setName] = useState(status.appName);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(() => Date.now());
  const file = useRef<HTMLInputElement>(null);

  // Follow the server when it changes underneath us — picking a different timetable can change
  // which logo the icon comes from.
  useEffect(() => setName(status.appName), [status.appName]);

  const saveName = async () => {
    setSaving('name');
    setError('');
    const r = await api.post('/api/admin/appname', { name });
    if (!r.ok) setError(r.error);
    onChanged();
    setSaving('');
  };

  const upload = async (f: File) => {
    setSaving('icon');
    setError('');
    // Sent as raw bytes with its real type. The server validates from the MAGIC NUMBERS and
    // re-encodes, so nothing is trusted because of what the browser called it.
    const r = await api.postBinary('/api/admin/icon', f, 'image/png');
    if (!r.ok) setError(r.error);
    else setPreview(Date.now()); // bust the icon's own ETag so the preview updates
    onChanged();
    setSaving('');
  };

  const reset = async () => {
    setSaving('reset');
    setError('');
    const r = await api.post('/api/admin/icon/reset');
    if (!r.ok) setError(r.error);
    setPreview(Date.now());
    onChanged();
    setSaving('');
  };

  return (
    <section className="glass panel">
      <div className="card-head">
        <span className="panel-ico">
          <Smartphone size={18} aria-hidden="true" />
        </span>
        <div className="card-head__main">
          <h2 className="section-title">On a musalli&rsquo;s phone</h2>
          <p className="card-body">
            When someone adds this to their home screen, this is the name and icon they keep. It should be your masjid,
            not ours.
          </p>

          <div className="home-preview">
            <img
              className="home-preview__icon"
              src={`${withBase('/api/public/icon/192.png')}?v=${preview}`}
              width={60}
              height={60}
              alt="Your app icon"
            />
            <div className="home-preview__label">{status.effectiveName}</div>
          </div>

          <p className="hint" style={{ marginBlockStart: '0.6rem' }}>
            The icon currently comes from <b>{WHERE[status.icon.source]}</b>.
          </p>

          <div className="field" style={{ marginBlockStart: '0.9rem' }}>
            <label className="label" htmlFor="appname">
              App name
            </label>
            <input
              id="appname"
              className="input"
              value={name}
              maxLength={60}
              placeholder={status.effectiveName}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="hint">
              Leave this empty to follow your masjid&rsquo;s name from OpenMasjid Display, so renaming it there is enough.
            </p>
          </div>

          {error && <p className="form-error">{error}</p>}

          <div className="card-actions">
            <button className="btn btn--primary" onClick={() => void saveName()} disabled={!!saving || name === status.appName}>
              {saving === 'name' ? <span className="spinner" /> : 'Save name'}
            </button>

            <input
              ref={file}
              type="file"
              accept="image/png"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void upload(f);
                e.target.value = '';
              }}
            />
            <button className="btn" onClick={() => file.current?.click()} disabled={!!saving}>
              {saving === 'icon' ? <span className="spinner" /> : <ImageUp size={15} aria-hidden="true" />}
              Upload an icon
            </button>

            {status.icon.hasUpload && (
              <button className="btn" onClick={() => void reset()} disabled={!!saving}>
                {saving === 'reset' ? <span className="spinner" /> : <RotateCcw size={15} aria-hidden="true" />}
                Use my masjid logo instead
              </button>
            )}
          </div>

          <div style={{ marginBlockStart: '0.8rem' }}>
            <Note>
              A square PNG, at least 512 pixels each way. It&rsquo;s cropped to a square and resized here, and Android may
              round the corners &mdash; so keep anything important away from the edges.
            </Note>
          </div>
        </div>
      </div>
    </section>
  );
}
