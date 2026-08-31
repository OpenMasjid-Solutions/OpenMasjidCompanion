// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Announcements the masjid sets once and forgets — the admin's half.
 *
 * Asked for by Hasan on 2026-08-30. An immediate announcement is already the only thing in this
 * app that reaches a musalli unbidden; a standing one does it again every week without anybody
 * deciding to, which is what shapes this screen:
 *
 *  - **The confirm step names the repetition**, not just the audience. "Send this to 40 phones"
 *    is the wrong question for something that will do it again next Friday, and the Friday
 *    after. The gate quotes the message and the sentence describing when.
 *  - **Every schedule shows when it will next go out**, computed by the server in the masjid's
 *    own zone. It is the only thing on the page that would catch "I meant Thursday" before four
 *    hundred phones do.
 *  - **Pause is offered before delete**, because a masjid's Ramadan notice should be able to
 *    come back next year without being retyped.
 *  - **It needs a timetable**, and says so rather than offering a time picker it could not
 *    honour: the masjid's IANA zone comes from Display's payload and there is no honest fallback
 *    for not knowing which hour "20:00" means (server/src/schedules.ts).
 */
import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Check, Pause, Play, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { Note } from '../ui';
import { describeNext, describeSchedule, prettyTime, weekdayNames, type Repeat } from './scheduleText';

interface Schedule {
  id: number;
  text: string;
  repeat: Repeat;
  time: string;
  days: number[];
  date: string;
  enabled: boolean;
  lastSentAt: number;
  sentCount: number;
  nextAt: number | null;
}

interface Listing {
  timezone: string;
  max: number;
  maxChars: number;
  audience: number;
  schedules: Schedule[];
}

const REPEAT_LABEL: { id: Repeat; label: string }[] = [
  { id: 'once', label: 'Once' },
  { id: 'daily', label: 'Every day' },
  { id: 'weekly', label: 'Every week' },
];

/** Today, in the masjid's zone, as the `min` for the date picker — a one-off in the past is a
 *  schedule that can never fire, and the browser can refuse it before the server has to. */
function todayIn(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export function Scheduled({ onChanged }: { onChanged?: () => void }): JSX.Element {
  const [data, setData] = useState<Listing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const r = await api.get<Listing>('/api/admin/announcements');
    if (r.ok) setData(r.data);
    else setError(r.error);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (path: string, body: unknown) => {
    setBusy(true);
    setError('');
    const r = await api.post(path, body);
    if (!r.ok) setError(r.error);
    await load();
    onChanged?.();
    setBusy(false);
  };

  return (
    <div className="announce">
      <h3 className="announce__title">
        <CalendarClock size={16} aria-hidden="true" />
        Set one to send itself
      </h3>
      <p className="hint">
        A notice that goes out on its own &mdash; every Friday morning before Jumuʿah, every night in Ramadan, or once
        on a date you choose. It reaches the same phones a one-off announcement does, and anyone who has turned notices
        off still doesn&rsquo;t get it.
      </p>

      {error && <p className="form-error">{error}</p>}

      {!data ? (
        <p className="card-body">
          <span className="spinner" />
        </p>
      ) : !data.timezone ? (
        <div style={{ marginBlockStart: '0.7rem' }}>
          <Note tone="warn">
            Scheduling needs your prayer timetable first &mdash; that is where this app learns which timezone your
            masjid is in. Without it, &ldquo;8&nbsp;pm&rdquo; could mean any hour of the day, so nothing is scheduled
            rather than something being sent at the wrong one.
          </Note>
        </div>
      ) : (
        <>
          {data.schedules.length > 0 && (
            <ul className="sched">
              {data.schedules.map((s) => (
                <li key={s.id} className={s.enabled ? 'sched__row' : 'sched__row sched__row--off'}>
                  <div className="sched__main">
                    <p className="sched__text">{s.text}</p>
                    <p className="sched__when">
                      {describeSchedule(s)}
                      <span className="sched__next">{describeNext(s.nextAt, data.timezone, s.enabled)}</span>
                    </p>
                    {s.sentCount > 0 && (
                      <p className="hint">
                        Sent {s.sentCount} time{s.sentCount === 1 ? '' : 's'}.
                      </p>
                    )}
                  </div>
                  <div className="sched__acts">
                    <button
                      className="icon-btn"
                      onClick={() => void act('/api/admin/announcements/update', { id: s.id, enabled: !s.enabled })}
                      disabled={busy}
                      aria-label={s.enabled ? `Pause: ${s.text}` : `Resume: ${s.text}`}
                      title={s.enabled ? 'Pause' : 'Resume'}
                    >
                      {s.enabled ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
                    </button>
                    <button
                      className="icon-btn"
                      onClick={() => void act('/api/admin/announcements/delete', { id: s.id })}
                      disabled={busy}
                      aria-label={`Delete: ${s.text}`}
                      title="Delete"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {data.schedules.length >= data.max ? (
            <div style={{ marginBlockStart: '0.7rem' }}>
              <Note tone="warn">
                That is as many standing announcements as this app will hold ({data.max}). Delete one to add another.
              </Note>
            </div>
          ) : (
            <NewSchedule data={data} onAdded={async () => {
              await load();
              onChanged?.();
            }} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The form.
 *
 * The confirm gate is the same shape as the immediate announcement's and for the same reason,
 * with one addition: it says how OFTEN. Somebody agreeing to send a notice to forty phones is
 * agreeing to something different from somebody agreeing to send it to forty phones every week
 * for the rest of the year, and only one of those is written on the button.
 */
function NewSchedule({ data, onAdded }: { data: Listing; onAdded: () => Promise<void> }): JSX.Element {
  const [text, setText] = useState('');
  const [repeat, setRepeat] = useState<Repeat>('weekly');
  const [time, setTime] = useState('11:00');
  const [days, setDays] = useState<number[]>([5]); // Friday, which is what this is mostly for
  const [date, setDate] = useState(todayIn(data.timezone));
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState('');

  const body = text.replace(/\s+/g, ' ').trim();
  const over = body.length > data.maxChars;
  // The two shapes that could never fire are refused here as well as on the server, so the
  // reader is told which box is empty rather than being handed a generic failure.
  const complete = repeat !== 'weekly' || days.length > 0;
  const dated = repeat !== 'once' || !!date;
  const ready = body.length > 0 && !over && complete && dated && !!time;

  /** Any edit withdraws the confirmation. It was given for the words and the schedule that were
   *  on screen at the time, and neither can be allowed to change underneath it. */
  const touched = () => {
    setConfirming(false);
    setOutcome('');
  };

  const save = async () => {
    setSaving(true);
    setOutcome('');
    const r = await api.post<{ refused: '' | 'full' | 'no-timezone' }>('/api/admin/announcements', {
      text: body,
      repeat,
      time,
      days: repeat === 'weekly' ? days : [],
      date: repeat === 'once' ? date : '',
      confirm: true,
    });
    if (!r.ok) setOutcome(r.error);
    else if (r.data.refused === 'full') setOutcome('There is no room for another standing announcement.');
    else if (r.data.refused === 'no-timezone') setOutcome('This app does not know your masjid’s timezone yet, so it can’t schedule anything.');
    else {
      setText('');
      setOutcome('Scheduled.');
    }
    setConfirming(false);
    setSaving(false);
    await onAdded();
  };

  const names = weekdayNames(undefined, 'short');
  const preview = describeSchedule({ repeat, time, days, date });

  return (
    <div className="sched__new">
      <div className="field">
        <label className="label" htmlFor="sched-text">
          Message
        </label>
        <textarea
          id="sched-text"
          className="input textarea announce__text"
          rows={2}
          value={text}
          maxLength={data.maxChars * 2}
          placeholder="Jumuʿah is at 1:30. Please come early."
          onChange={(e) => {
            setText(e.target.value);
            touched();
          }}
        />
        <p className={over ? 'form-error' : 'hint'}>
          {body.length} of {data.maxChars} characters{over ? ' — too long for a phone to show' : ''}
        </p>
      </div>

      <div className="field">
        <fieldset className="sched__opts">
          <legend className="label">How often</legend>
          {REPEAT_LABEL.map((r) => (
            <label key={r.id} className={repeat === r.id ? 'chip chip--on' : 'chip'}>
              <input
                className="sr-only"
                type="radio"
                name="sched-repeat"
                checked={repeat === r.id}
                onChange={() => {
                  setRepeat(r.id);
                  touched();
                }}
              />
              {repeat === r.id && <Check size={13} aria-hidden="true" />}
              {r.label}
            </label>
          ))}
        </fieldset>
      </div>

      {repeat === 'weekly' && (
        <div className="field">
          <fieldset className="sched__opts">
            <legend className="label">Which days</legend>
            {names.map((n, i) => {
              const on = days.includes(i);
              return (
                <label key={n} className={on ? 'chip chip--on' : 'chip'}>
                  <input
                    className="sr-only"
                    type="checkbox"
                    checked={on}
                    onChange={() => {
                      setDays(on ? days.filter((d) => d !== i) : [...days, i].sort((a, b) => a - b));
                      touched();
                    }}
                  />
                  {n}
                </label>
              );
            })}
          </fieldset>
          {days.length === 0 && <p className="form-error">Pick at least one day, or it will never send.</p>}
        </div>
      )}

      <div className="sched__row2">
        {repeat === 'once' && (
          <div className="field">
            <label className="label" htmlFor="sched-date">
              Date
            </label>
            <input
              id="sched-date"
              className="input"
              type="date"
              value={date}
              min={todayIn(data.timezone)}
              onChange={(e) => {
                setDate(e.target.value);
                touched();
              }}
            />
          </div>
        )}
        <div className="field">
          <label className="label" htmlFor="sched-time">
            Time
          </label>
          <input
            id="sched-time"
            className="input"
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value);
              touched();
            }}
          />
          {/* The masjid's clock, said out loud. A volunteer setting this up from another country
              — or from a laptop whose clock is on a different zone — would otherwise have no way
              to know which of the two times on their screen this one is. */}
          <p className="hint">
            {prettyTime(time)} at the masjid ({data.timezone}).
          </p>
        </div>
      </div>

      {outcome && <p className="muted card-body">{outcome}</p>}

      {!confirming ? (
        <div className="card-actions">
          <button className="btn" onClick={() => setConfirming(true)} disabled={!ready || saving}>
            <Plus size={15} aria-hidden="true" />
            Schedule it&hellip;
          </button>
        </div>
      ) : (
        <div className="announce__confirm">
          <p className="announce__ask">
            <TriangleAlert size={15} aria-hidden="true" />
            <span>
              <b>{preview}</b>
              {/* "to about 0 phones" is a true sentence and a useless one. A schedule is set for
                  the future, so nobody having signed up TODAY is not a reason not to set it —
                  it is a reason to say what the number will mean by then. */}
              {data.audience === 0
                ? ', to whoever has notifications on when it comes round. Nobody does yet.'
                : `, to about ${data.audience} phone${data.audience === 1 ? '' : 's'}`}
              {data.audience === 0 ? '' : repeat === 'once' ? '.' : ' — and again every time it comes round, until you pause it.'}
            </span>
          </p>
          <blockquote className="announce__quote">{body}</blockquote>
          <div className="card-actions">
            <button className="btn btn--primary" onClick={() => void save()} disabled={saving}>
              {saving ? <span className="spinner" /> : <CalendarClock size={15} aria-hidden="true" />}
              Yes, schedule it
            </button>
            <button className="btn" onClick={() => setConfirming(false)} disabled={saving}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
