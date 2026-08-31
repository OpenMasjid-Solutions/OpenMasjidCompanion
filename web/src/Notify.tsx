// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * Prayer reminders, as a musalli sets them.
 *
 * **This is the most refusable thing in the app**, and it is built that way on purpose: it is
 * off until someone asks, it asks the browser for permission only on a real tap, and turning
 * it off removes the subscription rather than merely muting it.
 *
 * It was a sheet over the prayer times until Settings arrived (Hasan, 2026-08-29) and is now a
 * section inside it. That is a better home than a modal for a reason worth stating: these are
 * SETTINGS — six switches somebody sets once and revisits twice a year — and a modal is a
 * shape for a question, not for a list of choices you scroll back to.
 *
 * The state, the subscribe flow and the platform rules all live in `reminders.ts`, because the
 * onboarding page can turn these on too and two copies of that flow is two chances to get the
 * order wrong.
 */
import { Bell, BellOff, BellRing, Check, Loader2 } from 'lucide-react';
import { LABELS, LEADS, PRAYERS, useReminders, type Blocker, type Notifiable } from './reminders';

export { PRAYERS, LEADS, DEFAULTS, blockerFor, type Prefs, type Prayer, type Notifiable } from './reminders';

/** The same heading in four places — the section has four states and every one of them is
 *  still the reminders section. Its own component, so a change to the wording cannot land on
 *  three of them and miss the fourth. */
function Head(): JSX.Element {
  return (
    <h2 className="set-title">
      <BellRing size={16} aria-hidden="true" />
      Prayer reminders
    </h2>
  );
}

/**
 * The reminders section of the Settings screen.
 *
 * `jumuah` is this masjid's Jumu'ah names, in order. Empty when the timetable has none — a
 * masjid that publishes no Jumu'ah gets no Jumu'ah switch rather than an empty one.
 */
export function ReminderSettings({ secure, jumuah }: { secure: boolean; jumuah: string[] }): JSX.Element {
  const { blocker, on, busy, error, prefs, enable, disable, save } = useReminders(secure);

  const togglePrayer = (p: Notifiable) => {
    const chosen = prefs.prayers.includes(p);
    const next = chosen ? prefs.prayers.filter((x) => x !== p) : [...prefs.prayers, p];
    // **Turning Jumuʿah back ON clears which ones.** Without this, a choice that no longer
    // matches anything the masjid holds — someone picked the second, the masjid now holds one —
    // is unreachable: the picker only appears when there is more than one to pick between, so
    // off-and-on-again re-posts the same dead list and the reminder stays silent for ever. The
    // server has its own fallback for that case; this is the half a reader can actually see.
    const jumuahReset = p === 'jumuah' && !chosen ? { jumuah: null } : {};
    void save({ ...prefs, prayers: next, ...jumuahReset });
  };

  /** Which Jumu'ah is chosen. `null` means all, so an unticked one has to become an explicit
   *  list of the rest — otherwise "all except the second" has no way to be said. */
  const jumuahOn = (i: number) => prefs.jumuah === null || prefs.jumuah.includes(i);
  const toggleJumuah = (i: number) => {
    const all = jumuah.map((_, k) => k);
    const now = prefs.jumuah ?? all;
    const next = now.includes(i) ? now.filter((k) => k !== i) : [...now, i].sort((a, b) => a - b);
    // Back to "all of them" when every one is ticked, so the preference keeps working if the
    // masjid adds a third Jumu'ah later.
    void save({ ...prefs, jumuah: next.length === all.length ? null : next });
  };

  if (blocker) {
    return (
      <section className="set-card">
        <Head />
        <Blocked blocker={blocker} />
      </section>
    );
  }

  if (on === null) {
    return (
      <section className="set-card">
        <Head />
        <p className="set-lead">
          <Loader2 size={16} className="spin" aria-hidden="true" />
        </p>
      </section>
    );
  }

  if (!on) {
    return (
      <section className="set-card">
        <Head />
        <p className="set-lead">
          A quiet reminder on this phone before each Iqamah, and the occasional notice from the masjid. Only this
          device, and you can turn any of it off whenever you like &mdash; the masjid never sees who signed up.
        </p>
        {error && <p className="form-error">{error}</p>}
        <button className="btn btn--primary" onClick={() => void enable()} disabled={busy}>
          {busy ? <span className="spinner" /> : <Bell size={15} aria-hidden="true" />}
          Turn on reminders
        </button>
      </section>
    );
  }

  return (
    <section className="set-card">
        <Head />

      <div className="notify__group">
        <div className="notify__label">Remind me for</div>
        <div className="notify__chips">
          {([...PRAYERS, ...(jumuah.length ? (['jumuah'] as const) : [])] as Notifiable[]).map((p) => {
            const chosen = prefs.prayers.includes(p);
            return (
              <button key={p} className={chosen ? 'chip chip--on' : 'chip'} onClick={() => togglePrayer(p)} aria-pressed={chosen}>
                {chosen && <Check size={13} aria-hidden="true" />}
                {LABELS[p]}
              </button>
            );
          })}
        </div>

        {/* Only when there is a choice to make. One Jumu'ah needs no picker, and a second
            row of chips under a single option reads as a decision the reader has to make
            about something that has only one answer. */}
        {prefs.prayers.includes('jumuah') && jumuah.length > 1 && (
          <div className="notify__sub">
            <div className="notify__label">Which Jumuʿah</div>
            <div className="notify__chips">
              {jumuah.map((label, i) => (
                <button
                  key={label + i}
                  className={jumuahOn(i) ? 'chip chip--on' : 'chip'}
                  onClick={() => toggleJumuah(i)}
                  aria-pressed={jumuahOn(i)}
                >
                  {jumuahOn(i) && <Check size={13} aria-hidden="true" />}
                  {label}
                </button>
              ))}
            </div>
            {prefs.jumuah !== null && prefs.jumuah.length === 0 && (
              <p className="notify__hint">None chosen, so no Jumuʿah reminder will be sent.</p>
            )}
          </div>
        )}
      </div>

      <div className="notify__group">
        <div className="notify__label">When</div>
        <div className="notify__chips">
          <button
            className={prefs.adhan ? 'chip chip--on' : 'chip'}
            onClick={() => void save({ ...prefs, adhan: !prefs.adhan })}
            aria-pressed={prefs.adhan}
          >
            {prefs.adhan && <Check size={13} aria-hidden="true" />}
            At the adhan
          </button>
          {LEADS.map((m) => {
            const chosen = prefs.beforeIqamah === m;
            return (
              <button
                key={m}
                className={chosen ? 'chip chip--on' : 'chip'}
                // Tapping the chosen one clears it, so "adhan only" is reachable.
                onClick={() => void save({ ...prefs, beforeIqamah: chosen ? null : m })}
                aria-pressed={chosen}
              >
                {chosen && <Check size={13} aria-hidden="true" />}
                {m} min before
              </button>
            );
          })}
        </div>
        {!prefs.adhan && prefs.beforeIqamah === null && (
          <p className="notify__hint">Nothing is selected, so no prayer reminders will be sent.</p>
        )}
      </div>

      {/* Its own group, because it is its own thing. Someone who wants silence at prayer
          times may still want to hear that the masjid is closed on Saturday — folding
          this in with the prayer switches would take that choice away from them. */}
      <div className="notify__group">
        <div className="notify__label">From the masjid</div>
        <div className="notify__chips">
          <button
            className={prefs.announcements ? 'chip chip--on' : 'chip'}
            onClick={() => void save({ ...prefs, announcements: !prefs.announcements })}
            aria-pressed={prefs.announcements}
          >
            {prefs.announcements && <Check size={13} aria-hidden="true" />}
            Announcements
          </button>
        </div>
      </div>

      {error && <p className="form-error">{error}</p>}

      <button className="btn" onClick={() => void disable()} disabled={busy}>
        {busy ? <span className="spinner" /> : <BellOff size={15} aria-hidden="true" />}
        Turn reminders off
      </button>
    </section>
  );
}

/** Every one of these is a platform rule, so each says what it is and what would fix it.
 *  Shared with the onboarding page, which reaches the same walls from the other direction. */
export function Blocked({ blocker }: { blocker: Blocker }): JSX.Element {
  if (blocker === 'insecure') {
    return (
      <p className="set-lead">
        Reminders need this app to be opened over the internet rather than on the masjid&rsquo;s own wifi. Scan the QR
        code on the noticeboard, or ask the masjid for the link.
      </p>
    );
  }
  if (blocker === 'ios-not-installed') {
    return (
      <p className="set-lead">
        On an iPhone or iPad, reminders only work once this is on your <b>Home Screen</b>. Tap Share, then{' '}
        <b>Add to Home Screen</b>, open it from there, and this will be waiting.
      </p>
    );
  }
  if (blocker === 'denied') {
    return (
      <p className="set-lead">
        Notifications are blocked for this app in your browser&rsquo;s settings. You&rsquo;d need to allow them there
        first &mdash; we can&rsquo;t ask again from here.
      </p>
    );
  }
  return (
    <p className="set-lead">
      This browser can&rsquo;t do notifications. Opening the app in Chrome or Safari, or adding it to your home screen,
      usually does it.
    </p>
  );
}
