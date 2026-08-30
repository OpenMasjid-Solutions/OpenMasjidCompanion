// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Where the masjid types how to be reached.
 *
 * **Every field is optional, and the form says so once rather than ten times.** A masjid with a
 * phone number and a WhatsApp group and nothing else should be able to fill in two boxes and
 * leave, without wondering whether the eight empty ones are a problem. Nothing here is required,
 * nothing is validated as you type, and what is left blank simply does not appear on anybody's
 * phone.
 *
 * Saved in one press rather than per field. Ten separate saves is ten chances for one of them to
 * fail silently, and a masjid filling this in is doing one job, not ten.
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Contact as ContactIcon, Save } from 'lucide-react';
import { api } from '../api';
import { Note } from '../ui';

const EMPTY = {
  phone: '',
  email: '',
  address: '',
  website: '',
  whatsapp: '',
  instagram: '',
  facebook: '',
  x: '',
  youtube: '',
  telegram: '',
};

type Contact = typeof EMPTY;
type Field = keyof Contact;

/** The order they are asked for, which is roughly the order a masjid knows them in. */
const DETAILS: { id: Field; label: string; hint: string; type?: string }[] = [
  { id: 'phone', label: 'Phone', hint: 'Written however you say it — “020 7946 0000”.', type: 'tel' },
  { id: 'email', label: 'Email', hint: 'The one somebody should write to.', type: 'email' },
  { id: 'website', label: 'Website', hint: 'Just the address — “masjid.org” is enough.' },
];

const LINKS: { id: Field; label: string; hint: string }[] = [
  { id: 'whatsapp', label: 'WhatsApp', hint: 'A group invite, or a chat link.' },
  { id: 'instagram', label: 'Instagram', hint: '' },
  { id: 'facebook', label: 'Facebook', hint: '' },
  { id: 'x', label: 'X', hint: '' },
  { id: 'youtube', label: 'YouTube', hint: '' },
  { id: 'telegram', label: 'Telegram', hint: '' },
];

export function ContactForm(): JSX.Element {
  const [form, setForm] = useState<Contact>(EMPTY);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const r = await api.get<{ contact: Contact }>('/api/admin/contact');
    if (r.ok) setForm({ ...EMPTY, ...r.data.contact });
    else setError(r.error);
    setLoaded(true);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const set = (id: Field, v: string) => {
    setForm((f) => ({ ...f, [id]: v }));
    setOutcome('');
    setError('');
  };

  const save = async () => {
    setSaving(true);
    setError('');
    const r = await api.post<{ contact: Contact }>('/api/admin/contact', form);
    if (!r.ok) setError(r.error);
    else {
      // Echoed back from the server, not kept as typed: it is the server that turns
      // "masjid.org" into "https://masjid.org/" and drops what it will not accept, and the form
      // should show what is actually stored rather than what was asked for.
      setForm({ ...EMPTY, ...r.data.contact });
      setOutcome('Saved. It appears at the top of Settings in the app.');
    }
    setSaving(false);
  };

  return (
    <section className="glass panel">
      <div className="card-head">
        <span className="panel-ico">
          <ContactIcon size={18} aria-hidden="true" />
        </span>
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title">How to reach you</h2>
          </div>
          <p className="card-body">
            Shown at the top of <b>Settings</b> in the app. Fill in as much or as little as you like &mdash; anything
            you leave blank simply isn&rsquo;t shown, so a phone number on its own is a perfectly good answer.
          </p>

          {!loaded ? (
            <p className="card-body">
              <span className="spinner" />
            </p>
          ) : (
            <>
              {DETAILS.map((f) => (
                <div className="field" key={f.id}>
                  <label className="label" htmlFor={`contact-${f.id}`}>
                    {f.label}
                  </label>
                  <input
                    id={`contact-${f.id}`}
                    className="input"
                    type={f.type ?? 'text'}
                    value={form[f.id]}
                    onChange={(e) => set(f.id, e.target.value)}
                    autoComplete="off"
                  />
                  {f.hint && <p className="hint">{f.hint}</p>}
                </div>
              ))}

              <div className="field">
                <label className="label" htmlFor="contact-address">
                  Address
                </label>
                {/* A textarea, because an address has lines. They are kept — this is the one
                    field somebody may copy onto an envelope. */}
                <textarea
                  id="contact-address"
                  className="input textarea"
                  rows={3}
                  value={form.address}
                  onChange={(e) => set('address', e.target.value)}
                />
                <p className="hint">A “Directions” button appears under it in the app.</p>
              </div>

              <h3 className="announce__title" style={{ marginBlockStart: '1rem' }}>
                Links
              </h3>
              <p className="hint">Paste the full address of each one. Only the ones you fill in are shown.</p>

              {LINKS.map((f) => (
                <div className="field" key={f.id}>
                  <label className="label" htmlFor={`contact-${f.id}`}>
                    {f.label}
                  </label>
                  <input
                    id={`contact-${f.id}`}
                    className="input"
                    type="url"
                    inputMode="url"
                    value={form[f.id]}
                    onChange={(e) => set(f.id, e.target.value)}
                    autoComplete="off"
                  />
                  {f.hint && <p className="hint">{f.hint}</p>}
                </div>
              ))}

              {error && <p className="form-error">{error}</p>}
              {outcome && (
                <div style={{ marginBlockStart: '0.7rem' }}>
                  <Note icon={<Check size={16} aria-hidden="true" />}>{outcome}</Note>
                </div>
              )}

              <div className="card-actions">
                <button className="btn btn--primary" onClick={() => void save()} disabled={saving}>
                  {saving ? <span className="spinner" /> : <Save size={15} aria-hidden="true" />}
                  Save contact details
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
