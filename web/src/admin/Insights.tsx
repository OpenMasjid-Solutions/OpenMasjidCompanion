// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * "Is anybody actually using this?" — the one question a volunteer has after putting a poster
 * on the wall, and until now the app could not answer it at all.
 *
 * **What is on this screen is the whole of what is stored** (server/src/analytics.ts): a
 * counter per day per device type per browser per mode. There is no visitor, no session and no
 * timestamp finer than a date anywhere in the table, so there is nothing here that could be
 * expanded into a list later without somebody adding a column on purpose.
 *
 * Two honesty rules the wording follows, because a number on a dashboard is believed:
 *
 *  - It counts **browsers, roughly** — once a day each. A cleared cache counts twice, a shared
 *    phone counts once, and a musalli who never opens the app again is still in last month's
 *    figure. So the panel says "phones", never "people", and never puts a trend on two days.
 *  - The endpoint behind it is **public and unauthenticated**, like every page a musalli
 *    opens. Somebody who wanted to could inflate it. That is inherent and it is said out loud
 *    rather than left for an admin to work out when a number looks wrong.
 */
import { useCallback, useEffect, useState } from 'react';
import { ChartNoAxesColumn, RefreshCw, Smartphone } from 'lucide-react';
import { api } from '../api';
import { Note } from '../ui';
import type { BrowserId, Device, Mode } from '../platform';

interface Breakdown {
  devices: { key: Device; count: number }[];
  browsers: { key: BrowserId; count: number }[];
  modes: { key: Mode; count: number }[];
  total: number;
  days: number;
  windowDays: number;
}

/**
 * The admin's words for the same values the app detects.
 *
 * Separate from the labels in `platform.ts` on purpose, and only the WORDS are separate: the
 * types come from there, so a new browser cannot be added without this map failing to compile.
 * The other set is dropped into a sentence a musalli reads ("Chrome can't add a web app…");
 * these are row headings in a table. "Inside another app" is a row; "In-app browser" is jargon.
 */
const DEVICE_LABEL: Record<Device, string> = {
  ios: 'iPhone & iPad',
  android: 'Android',
  desktop: 'Computer',
  other: 'Something else',
};

const BROWSER_LABEL: Record<BrowserId, string> = {
  safari: 'Safari',
  chrome: 'Chrome',
  edge: 'Edge',
  firefox: 'Firefox',
  samsung: 'Samsung Internet',
  opera: 'Opera',
  inapp: 'Inside another app',
  other: 'Something else',
};

const MODE_LABEL: Record<Mode, string> = {
  standalone: 'On the home screen',
  browser: 'In a browser',
};

export function Insights(): JSX.Element {
  const [data, setData] = useState<Breakdown | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusy(true);
    const r = await api.get<Breakdown>('/api/admin/analytics');
    if (r.ok) {
      setData(r.data);
      setError('');
    } else {
      setError(r.error);
    }
    setBusy(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const installed = data?.modes.find((m) => m.key === 'standalone')?.count ?? 0;

  return (
    <section className="glass panel">
      <div className="card-head">
        <span className="panel-ico">
          <ChartNoAxesColumn size={18} aria-hidden="true" />
        </span>
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title">Who&rsquo;s using it</h2>
            <button className="btn" onClick={() => void load()} disabled={busy} aria-label="Refresh the figures">
              {busy ? <span className="spinner" /> : <RefreshCw size={14} aria-hidden="true" />}
            </button>
          </div>

          {error && <p className="form-error">{error}</p>}

          {!data ? (
            <p className="card-body">
              <span className="spinner" />
            </p>
          ) : data.total === 0 ? (
            <p className="card-body">
              Nothing counted yet. Once people start scanning the code on your noticeboard, this fills in.
            </p>
          ) : (
            <>
              <div className="stat">
                <span className="stat__n">{data.total}</span>
                <span className="stat__label">
                  {data.total === 1 ? 'phone opened it' : 'phones opened it'} in the last {data.windowDays} days
                </span>
              </div>

              {/* The number the poster was for. Given its own line because "how many actually
                  installed it" is a different question from "how many looked", and it is the
                  one that says whether the noticeboard is working. */}
              <p className="card-body">
                <Smartphone size={14} aria-hidden="true" style={{ verticalAlign: '-0.15em', marginInlineEnd: '0.3rem' }} />
                <b>{installed}</b> of them opened it from their <b>home screen</b> rather than a browser.
              </p>

              <Bars title="Device" rows={data.devices.map((r) => ({ label: DEVICE_LABEL[r.key], count: r.count }))} total={data.total} />
              <Bars title="Browser" rows={data.browsers.map((r) => ({ label: BROWSER_LABEL[r.key], count: r.count }))} total={data.total} />
              <Bars title="How they open it" rows={data.modes.map((r) => ({ label: MODE_LABEL[r.key], count: r.count }))} total={data.total} />

              {/* Only when it would actually mislead. Three days of counts read as a trend if
                  nothing says they are three days. */}
              {data.days < 7 && (
                <Note>
                  Only {data.days === 1 ? 'one day' : `${data.days} days`} of counting so far &mdash; give it a week
                  before reading anything into the shape of it.
                </Note>
              )}

              <p className="hint" style={{ marginBlockStart: '0.7rem' }}>
                Counted once a day per browser, never per person. This app stores no name, no number and no address for
                anyone who opens it &mdash; only these totals, and only for 90 days. Treat them as a guide rather than
                an audit: the page is public, so the count is a count of openings, not of members.
              </p>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** A row per value, biggest first, with the bar drawn as a share of the total. Percentages are
 *  rounded for display only — the count beside each one is the real number, so a set of bars
 *  reading 33% three times never has to add up to 99. */
function Bars({ title, rows, total }: { title: string; rows: { label: string; count: number }[]; total: number }): JSX.Element {
  return (
    <div className="bars">
      <div className="label">{title}</div>
      {rows.map((r) => {
        const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
        return (
          <div className="bars__row" key={r.label}>
            <span className="bars__label">{r.label}</span>
            <span className="bars__track" aria-hidden="true">
              <span className="bars__fill" style={{ inlineSize: `${total > 0 ? (r.count / total) * 100 : 0}%` }} />
            </span>
            <span className="bars__n">
              {r.count} <span className="bars__pct">({pct}%)</span>
            </span>
          </div>
        );
      })}
    </div>
  );
}
