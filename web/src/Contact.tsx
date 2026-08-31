// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * The masjid's own details, at the top of Settings.
 *
 * First on the screen because it is the only thing here that belongs to the MASJID — everything
 * below it is the reader's own choice about their own phone, and mixing the two would make the
 * masjid's phone number look like a setting somebody could change.
 *
 * **Nothing is drawn for a field that was left empty.** A masjid that filled in a phone number
 * and nothing else gets a card with a phone number on it, not a row of blanks and not a "no
 * website set" line. There is no card at all when there is nothing in it (`hasContact`), so this
 * component renders null for most masjids on most days and that is the intended outcome.
 *
 * Every link is `rel="noopener noreferrer"` and opens away from the app. The app's own
 * `referrer-policy: no-referrer` means none of them carries which masjid's page it came from.
 */
import { useState } from 'react';
import { Facebook, Globe, Instagram, Mail, MapPin, MessageCircle, Navigation, Phone, Send, X, Youtube } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  SOCIAL_LABEL,
  appleMapsHref,
  mailHref,
  mapsHref,
  safeUrl,
  socialsOf,
  telHref,
  type Contact as ContactInfo,
  type Social,
} from './contactLinks';
import { currentEnv, osOf } from './platform';
import { MasjidIcon } from './Masjid';

/**
 * Icons for the networks.
 *
 * lucide carries Instagram, Facebook and YouTube and does not carry WhatsApp, X or Telegram —
 * it dropped most brand marks, and drawing somebody else's logo by hand is a trademark somebody
 * else owns, not an asset this repository can license under AGPL. So those three get a neutral
 * shape that suggests the thing: a message bubble, a cross, a paper plane. **Every one of them
 * is labelled in text as well**, which is what actually identifies it — the icon is support.
 */
const SOCIAL_ICON: Record<Social, LucideIcon> = {
  whatsapp: MessageCircle,
  instagram: Instagram,
  facebook: Facebook,
  x: X,
  youtube: Youtube,
  telegram: Send,
};

export function ContactCard({ contact, name }: { contact: ContactInfo; name: string }): JSX.Element {
  const tel = telHref(contact.phone);
  const mail = mailHref(contact.email);
  const web = safeUrl(contact.website);
  const address = contact.address.trim();
  const socials = socialsOf(contact);

  return (
    <section className="set-card">
      {/* A masjid, not a map pin (Hasan, 2026-08-31). The pin already belongs to the address
          row below, and using it twice in one card made the heading look like a second address
          rather than like the name of the building the card is about. */}
      <h2 className="set-title">
        <MasjidIcon size={17} />
        {name || 'The masjid'}
      </h2>

      <ul className="contact">
        {tel && (
          <li>
            <a className="contact__row" href={tel}>
              <Phone size={16} aria-hidden="true" />
              {/* The number as the masjid WROTE it. The dialled string has the brackets and
                  spaces taken out of it; the readable one keeps them, because that is how
                  somebody recognises their own masjid's number. */}
              <span className="contact__val">{contact.phone}</span>
            </a>
          </li>
        )}
        {mail && (
          <li>
            <a className="contact__row" href={mail}>
              <Mail size={16} aria-hidden="true" />
              <span className="contact__val">{contact.email}</span>
            </a>
          </li>
        )}
        {web && (
          <li>
            <a className="contact__row" href={web} target="_blank" rel="noopener noreferrer">
              <Globe size={16} aria-hidden="true" />
              {/* The host, not the whole URL. "example.org" is what somebody checks against what
                  they expect; the query string on the end of a pasted link is noise that pushes
                  the useful part off a phone screen. */}
              <span className="contact__val">{hostOf(web)}</span>
            </a>
          </li>
        )}
        {address && (
          <li className="contact__row contact__row--static">
            <MapPin size={16} aria-hidden="true" />
            <span className="contact__val contact__val--address">{address}</span>
          </li>
        )}
      </ul>

      {address && <Directions address={address} />}

      {socials.length > 0 && (
        <div className="contact__socials">
          {socials.map(({ id, url }) => {
            const Icon = SOCIAL_ICON[id];
            return (
              <a key={id} className="chip" href={url} target="_blank" rel="noopener noreferrer">
                <Icon size={14} aria-hidden="true" />
                {SOCIAL_LABEL[id]}
              </a>
            );
          })}
        </div>
      )}
    </section>
  );
}

/**
 * "Directions" — and on an iPhone, directions in WHICH app.
 *
 * Everywhere else there is one sensible answer and the button just goes. On iOS there are two
 * real ones and picking for somebody is a guess about their phone: an iPhone without Google Maps
 * installed lands on a web page asking them to install it, having pressed a button that promised
 * directions.
 *
 * It expands in place rather than opening a dialog. Two links are not worth stopping the page
 * for, and the reader has already told us what they want by pressing — the second press is
 * choosing between two things, not confirming the first.
 */
function Directions({ address }: { address: string }): JSX.Element {
  const [choosing, setChoosing] = useState(false);
  const ios = osOf(currentEnv()) === 'ios';

  if (!ios) {
    return (
      <a className="btn contact__maps" href={mapsHref(address)} target="_blank" rel="noopener noreferrer">
        <Navigation size={15} aria-hidden="true" />
        Directions
      </a>
    );
  }

  if (!choosing) {
    return (
      <button className="btn contact__maps" onClick={() => setChoosing(true)} aria-expanded={false}>
        <Navigation size={15} aria-hidden="true" />
        Directions
      </button>
    );
  }

  return (
    <div className="contact__maps contact__choose">
      <p className="contact__choose-ask">Open in</p>
      <div className="contact__choose-row">
        <a className="btn btn--primary" href={appleMapsHref(address)} target="_blank" rel="noopener noreferrer">
          Apple Maps
        </a>
        <a className="btn" href={mapsHref(address)} target="_blank" rel="noopener noreferrer">
          Google Maps
        </a>
      </div>
    </div>
  );
}

/** The bit of a URL worth showing. Falls back to the whole thing rather than to nothing, since
 *  this only runs on a string `safeUrl` has already parsed once. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}
