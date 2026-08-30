// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The musalli's own settings (Hasan, 2026-08-29).
 *
 * One tab, holding the two things a reader is ever going to want to change: how the page looks,
 * and what their phone is allowed to interrupt them for. Everything else about this app is the
 * masjid's decision, not theirs, and putting a masjid's setting on this screen would be the
 * beginning of a preferences panel nobody asked for.
 *
 * **Every choice on this screen is per-browser and never leaves it** — except the reminder
 * switches, which have to reach the server because the server is what sends them. The look is
 * localStorage and nothing else: no account, no sync, nothing about it in the masjid's store.
 */
import { Check, MoonStar, Palette, Smartphone, Sun, SunMoon, Vibrate } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { navigate } from './App';
import { ONBOARDING_PATH } from './base';
import { SKY_MODES, type SkyMode } from './periodTheme';
import { prefsStore, usePrefs } from './prefs';
import { ReminderSettings } from './Notify';
import { ContactCard } from './Contact';
import { hasContact, type Contact } from './contactLinks';
import { hapticsSupported } from './haptics';

const SKY_ICON: Record<SkyMode, LucideIcon> = { period: SunMoon, dark: MoonStar, light: Sun };

export function Settings({
  secure,
  jumuah,
  installed,
  contact,
  masjidName,
}: {
  secure: boolean;
  jumuah: string[];
  installed: boolean;
  /** null until the bootstrap has answered. Nothing is drawn on a maybe. */
  contact: Contact | null;
  masjidName: string;
}): JSX.Element {
  const { sky, haptics } = usePrefs();

  return (
    <main className="settings">
      <h1 className="settings__title">Settings</h1>

      {/* First, because it is the only thing on this screen that belongs to the MASJID rather
          than to the reader — and absent entirely for a masjid that has not filled any of it in,
          which is most of them. */}
      {contact && hasContact(contact) && <ContactCard contact={contact} name={masjidName} />}

      <section className="set-card">
        <h2 className="set-title">
          <Palette size={16} aria-hidden="true" />
          Appearance
        </h2>
        <p className="set-lead">
          This app usually looks like the time of day &mdash; dark before Fajr, light by mid-morning, dark again after
          Maghrib. Hold it one way if you&rsquo;d rather.
        </p>

        {/* REAL RADIOS, not chips or buttons with `role="radio"`.
         *
         *  Chips would be wrong twice over: these are three answers to ONE question where only
         *  one can be true, and chips are the shape this app uses for "pick as many as you
         *  like". And a <button role="radio"> looks right to a screen reader while behaving
         *  wrongly for a keyboard — the group should be one tab stop that the arrow keys move
         *  within, which is a dozen lines to implement badly and free from a real <input>. The
         *  input is visually hidden, so it also carries focus, forced-colours and the label's
         *  own click target with nothing else to remember. */}
        <fieldset className="set-options">
          <legend className="sr-only">Appearance</legend>
          {SKY_MODES.map((m) => {
            const on = sky === m.id;
            const Icon = SKY_ICON[m.id];
            return (
              <label key={m.id} className={on ? 'set-option set-option--on' : 'set-option'}>
                <input
                  className="sr-only"
                  type="radio"
                  name="sky"
                  value={m.id}
                  checked={on}
                  onChange={() => prefsStore.patch({ sky: m.id })}
                />
                <Icon size={18} aria-hidden="true" className="set-option__ico" />
                <span className="set-option__main">
                  <span className="set-option__label">{m.label}</span>
                  <span className="set-option__hint">{m.hint}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
      </section>

      {/* Only where there is something to switch off. On an iPhone the Vibration API does not
          exist at all (see haptics.ts), so this row would be a control for nothing — and a
          setting that does nothing is worse than a missing one, because somebody will use it and
          conclude the app ignores them. */}
      {hapticsSupported() && (
        <section className="set-card">
          <h2 className="set-title">
            <Vibrate size={16} aria-hidden="true" />
            Vibration
          </h2>
          <p className="set-lead">
            A small buzz when you tap something, swipe between days, or line up the Qibla. Your phone&rsquo;s own
            vibration setting still comes first.
          </p>
          <div className="notify__chips">
            <button
              className={haptics ? 'chip chip--on' : 'chip'}
              onClick={() => prefsStore.patch({ haptics: !haptics })}
              aria-pressed={haptics}
            >
              {haptics && <Check size={13} aria-hidden="true" />}
              Buzz on tap
            </button>
          </div>
        </section>
      )}

      <ReminderSettings secure={secure} jumuah={jumuah} />

      {/* Only when there is something to do about it. Somebody reading this inside the installed
          app does not need to be told to install it, and on a browser that cannot, the
          onboarding page says so honestly rather than this row promising something. */}
      {!installed && (
        <section className="set-card">
          <h2 className="set-title">
            <Smartphone size={16} aria-hidden="true" />
            Keep it on your phone
          </h2>
          <p className="set-lead">
            Added to your home screen it opens like any other app, and today&rsquo;s times are there even with no signal.
          </p>
          <button className="btn" onClick={() => navigate(ONBOARDING_PATH)}>
            Show me how
          </button>
        </section>
      )}
    </main>
  );
}
