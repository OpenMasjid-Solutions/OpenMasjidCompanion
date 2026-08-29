// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * What the admin can see and do about prayer reminders — which is deliberately very little.
 *
 * **A count, never a list.** There is no endpoint in this app that returns push endpoints, and
 * that is the only way to be sure one is never rendered. The masjid learns how many people
 * signed up and nothing whatever about who; a subscription is an endpoint, two keys and a set
 * of switches, and none of that is theirs to browse.
 *
 * The rest of the screen is about whether the machinery is working, because the failure mode
 * of a notification system is silence — and silence looks exactly like "nobody has signed up
 * yet" unless something says otherwise.
 */
import { useCallback, useEffect, useState } from 'react';
import { BellRing, Megaphone, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import { api } from '../api';
import { Note } from '../ui';

export interface PushStatus {
  subscribers: number;
  /** Those who have not turned announcements off — the real size of a broadcast. */
  audience: number;
  lastAnnouncedAt: number;
  maxChars: number;
  lastRunAt: number;
  lastSentAt: number;
  /** '' when it is working; otherwise why nothing is going out. */
  paused: '' | 'no-timetable' | 'stale' | 'no-subscribers';
  timetableAt: number;
  enabled: boolean;
}

interface AnnounceResult {
  refused: '' | 'empty' | 'too-long' | 'cooldown' | 'nobody';
  sent: number;
  failed: number;
  pruned: number;
  audience: number;
}

const WHEN = (at: number) => (at ? new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');

export function Notifications(): JSX.Element {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState('');

  const load = useCallback(async () => {
    const r = await api.get<PushStatus>('/api/admin/push');
    if (r.ok) setStatus(r.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Send a test to THIS device.
   *
   * The admin's own phone, through its own subscription — so it proves the whole chain (our
   * VAPID key, the push service, the service worker on a real handset) without touching
   * anybody else's. It needs this browser to be subscribed first, which is why it says so
   * rather than failing.
   */
  const test = async () => {
    setBusy('test');
    setResult('');
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        setResult('This device isn’t signed up for reminders yet. Open the app’s prayer times, tap the bell, and turn them on — then try again here.');
        setBusy('');
        return;
      }
      const r = await api.post<{ result: string }>('/api/admin/push/test', sub.toJSON());
      setResult(
        !r.ok
          ? r.error
          : r.data.result === 'sent'
            ? 'Sent. It should appear on this device within a few seconds.'
            : r.data.result === 'gone'
              ? 'Your phone’s push service says this subscription no longer exists. Turn reminders off and on again in the app.'
              : 'The push service rejected it. If this keeps happening, you’ll get an alert about it.',
      );
    } catch {
      setResult('This browser can’t send a test — it isn’t set up for notifications.');
    }
    setBusy('');
  };

  const refresh = async () => {
    setBusy('refresh');
    await load();
    setBusy('');
  };

  const paused = status?.paused ?? '';
  const trouble =
    paused === 'stale'
      ? 'Reminders are paused because the prayer times are more than two days old. Nothing will be sent until they refresh — a wrong time is worse than no reminder.'
      : paused === 'no-timetable'
        ? 'No prayer times have arrived yet, so there is nothing to remind anyone about. Choose a timetable above.'
        : '';

  return (
    <section className="glass panel">
      <div className="card-head">
        <span className="panel-ico">
          <BellRing size={18} aria-hidden="true" />
        </span>
        <div className="card-head__main">
          <div className="row-between">
            <h2 className="section-title">Prayer reminders</h2>
            {status && (trouble ? <span className="badge badge--warn">Paused</span> : <span className="badge badge--ok">On</span>)}
          </div>

          <p className="card-body">
            Musallis can turn on a reminder before each jamāʿah, per phone, from the bell on the prayer times page.
            They choose which prayers and how long before.
          </p>

          {!status ? (
            <p className="card-body">
              <span className="spinner" />
            </p>
          ) : (
            <>
              <div className="stat">
                <div className="stat__n tnum">{status.subscribers}</div>
                <div className="stat__label">
                  {status.subscribers === 1 ? 'phone signed up' : 'phones signed up'}
                </div>
              </div>

              {/* Stated rather than merely true. A masjid should know what this app does NOT
                  hold about their congregation, and reading it here is how they find out. */}
              <Note>
                We can tell you how many, and nothing else. This app stores no name, phone number or address for
                anybody who signs up &mdash; only their phone&rsquo;s anonymous notification address and what they chose
                to be told about.
              </Note>

              {trouble && (
                <div style={{ marginBlockStart: '0.7rem' }}>
                  <Note tone="warn">{trouble}</Note>
                </div>
              )}

              {!status.enabled && (
                <div style={{ marginBlockStart: '0.7rem' }}>
                  <Note tone="warn">
                    Remote access is off, so nobody can sign up for reminders yet &mdash; a phone needs to reach this
                    app over the internet.
                  </Note>
                </div>
              )}

              <p className="hint" style={{ marginBlockStart: '0.7rem' }}>
                Last checked {WHEN(status.lastRunAt)}. Last reminder sent {WHEN(status.lastSentAt)}.
              </p>
            </>
          )}

          {result && <p className="muted card-body">{result}</p>}

          <div className="card-actions">
            <button className="btn" onClick={() => void test()} disabled={!!busy}>
              {busy === 'test' ? <span className="spinner" /> : <Send size={15} aria-hidden="true" />}
              Send a test to this device
            </button>
            <button className="btn" onClick={() => void refresh()} disabled={!!busy}>
              {busy === 'refresh' ? <span className="spinner" /> : <RefreshCw size={15} aria-hidden="true" />}
              Check again
            </button>
          </div>

          {status && <Announce status={status} onSent={load} />}
        </div>
      </div>
    </section>
  );
}

/**
 * One notice to everybody.
 *
 * **This is the only thing in this app that reaches a musalli unbidden, and it cannot be
 * recalled.** So it is built to be hard to do by accident and easy to do deliberately: the
 * Send button does not send. It asks — naming the number of phones and quoting the message
 * back — and a second, differently-worded press is what actually broadcasts.
 *
 * Typing again after that cancels the confirmation, so an edit can never be sent under a
 * confirmation the admin gave to different words.
 */
function Announce({ status, onSent }: { status: PushStatus; onSent: () => Promise<void> }): JSX.Element {
  const [text, setText] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState('');

  const body = text.replace(/\s+/g, ' ').trim();
  const over = body.length > status.maxChars;
  const ready = body.length > 0 && !over;

  const send = async () => {
    setSending(true);
    setOutcome('');
    const r = await api.post<AnnounceResult>('/api/admin/push/announce', { text: body, confirm: true });
    if (!r.ok) setOutcome(r.error);
    else {
      const d = r.data;
      setOutcome(
        d.refused === 'nobody'
          ? 'Nobody has notifications turned on yet, so it wasn’t sent to anyone.'
          : d.refused === 'cooldown'
            ? 'That was sent a moment ago. Wait a minute before sending another — it stops the same notice going out twice.'
            : d.refused === 'too-long'
              ? 'That message is too long to send.'
              : d.refused === 'empty'
                ? 'There was no message to send.'
                : `Sent to ${d.sent} of ${d.audience} phone${d.audience === 1 ? '' : 's'}.${d.failed ? ` ${d.failed} didn’t go through.` : ''}`,
      );
      if (!d.refused) setText('');
    }
    setConfirming(false);
    setSending(false);
    await onSent();
  };

  return (
    <div className="announce">
      <div className="row-between">
        <h3 className="announce__title">
          <Megaphone size={16} aria-hidden="true" />
          Send an announcement
        </h3>
      </div>
      <p className="hint">
        A one-off notice to every phone signed up &mdash; a funeral, a closure, a changed jamāʿah. It arrives like a
        prayer reminder, with your masjid&rsquo;s name on it. <b>It can&rsquo;t be taken back once sent.</b>
      </p>

      <div className="field" style={{ marginBlockStart: '0.6rem' }}>
        <label className="label" htmlFor="announce-text">
          Message
        </label>
        <textarea
          id="announce-text"
          className="input textarea announce__text"
          rows={2}
          value={text}
          maxLength={status.maxChars * 2}
          placeholder="Jumuʿah is at 1:30 this week, not 1:00."
          onChange={(e) => {
            setText(e.target.value);
            // A confirmation is for the words that were on screen when it was given.
            setConfirming(false);
            setOutcome('');
          }}
        />
        <p className={over ? 'form-error' : 'hint'}>
          {body.length} of {status.maxChars} characters{over ? ' — too long for a phone to show' : ''}
        </p>
      </div>

      {outcome && <p className="muted card-body">{outcome}</p>}

      {!confirming ? (
        <div className="card-actions">
          <button className="btn" onClick={() => setConfirming(true)} disabled={!ready || sending}>
            <Megaphone size={15} aria-hidden="true" />
            Send to everyone&hellip;
          </button>
        </div>
      ) : (
        // The gate. It quotes the message back, because the thing being confirmed is the WORDS,
        // and names the count, because "everyone" is not a number anybody can picture.
        <div className="announce__confirm">
          <p className="announce__ask">
            <TriangleAlert size={15} aria-hidden="true" />
            <span>
              Send this to <b>{status.audience}</b> phone{status.audience === 1 ? '' : 's'} now? It can&rsquo;t be
              undone.
            </span>
          </p>
          <blockquote className="announce__quote">{body}</blockquote>
          <div className="card-actions">
            <button className="btn btn--primary" onClick={() => void send()} disabled={sending}>
              {sending ? <span className="spinner" /> : <Megaphone size={15} aria-hidden="true" />}
              Yes, send it now
            </button>
            <button className="btn" onClick={() => setConfirming(false)} disabled={sending}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
