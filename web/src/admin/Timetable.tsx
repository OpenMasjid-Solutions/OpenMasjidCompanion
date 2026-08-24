// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Choosing which of the masjid's timetables the app shows.
 *
 * The whole screen is a list and one button, but the states around it are the point: OpenMasjid
 * Display may not be installed, may not have granted access, may have no location set, or may
 * have had the chosen timetable deleted out from under us. Each of those needs a different
 * sentence and a different next step, and the server has already turned every one of them into
 * plain words (see `BrokerFailure` in fabric.ts) — so this component renders the message rather
 * than trying to interpret a code.
 *
 * `name` is the admin's own private label for a timetable ("Women's section"). This is the ONE
 * screen it belongs on; it is never shown to a musalli.
 */
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Check, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { Note } from '../ui';

export interface TimetableStatus {
  id: string;
  name: string;
  masjidName: string;
  timezone: string;
  days: number;
  at: number;
  stale: boolean;
  problem: { code: string; message: string; retryable: boolean } | null;
}

interface ListResult {
  ok: boolean;
  reason: string;
  code: string;
  timetables: { id: string; name: string }[];
  chosen?: string;
}

export function TimetablePicker({ status, onChanged }: { status: TimetableStatus; onChanged: () => void }): JSX.Element {
  const [list, setList] = useState<ListResult | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const loadList = useCallback(async () => {
    const r = await api.get<ListResult>('/api/admin/timetables');
    if (r.ok) setList(r.data);
    else setError(r.error);
  }, []);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const choose = async (id: string) => {
    setBusy(id);
    setError('');
    const r = await api.post('/api/admin/timetable', { id });
    if (!r.ok) setError(r.error);
    await loadList();
    onChanged();
    setBusy('');
  };

  const refresh = async () => {
    setBusy('refresh');
    setError('');
    const r = await api.post('/api/admin/timetable/refresh');
    if (!r.ok) setError(r.error);
    onChanged();
    setBusy('');
  };

  return (
    <section className="glass panel">
      <div className="card-head">
        <span className="panel-ico">
          <CalendarClock size={18} aria-hidden="true" />
        </span>
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title">Prayer timetable</h2>
            {status.id && !status.problem && <span className="badge badge--ok">Connected</span>}
            {status.problem && <span className="badge badge--warn">Needs attention</span>}
          </div>

          <p className="card-body">
            Companion reads your times from OpenMasjid Display, so what a musalli sees on their phone is what is on
            the wall. It never works out a prayer time of its own.
          </p>

          {/* The server has already said what went wrong in plain words. Rendering its sentence
              beats re-deriving one from a code that would drift out of step with it. */}
          {status.problem && (
            <Note tone="warn">{status.problem.message}</Note>
          )}

          {!list && !error && <p className="card-body"><span className="spinner" /></p>}

          {list && !list.ok && <Note tone="warn">{list.reason}</Note>}

          {list?.ok && list.timetables.length === 0 && (
            <Note>You have no timetables in OpenMasjid Display yet. Create one there and it will appear here.</Note>
          )}

          {list?.ok && list.timetables.length > 0 && (
            <ul className="picker">
              {list.timetables.map((t) => {
                const chosen = t.id === status.id;
                return (
                  <li key={t.id}>
                    <button
                      className={chosen ? 'picker__item picker__item--on' : 'picker__item'}
                      onClick={() => void choose(t.id)}
                      disabled={!!busy}
                      aria-pressed={chosen}
                    >
                      <span className="picker__name">{t.name || t.id}</span>
                      {busy === t.id ? <span className="spinner" /> : chosen ? <Check size={17} aria-hidden="true" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {status.id && !status.problem && status.days > 0 && (
            <p className="card-body">
              Showing <b>{status.masjidName}</b> &mdash; {status.days} days of times, in {status.timezone}.
              {status.at ? ` Last read ${new Date(status.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.` : ''}
            </p>
          )}

          {error && <p className="form-error">{error}</p>}

          {status.id && (
            <div className="card-actions">
              <button className="btn" onClick={() => void refresh()} disabled={!!busy}>
                {busy === 'refresh' ? <span className="spinner" /> : <RefreshCw size={15} aria-hidden="true" />}
                Refresh now
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
