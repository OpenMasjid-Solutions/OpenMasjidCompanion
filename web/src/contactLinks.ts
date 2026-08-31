// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * contactLinks.ts — turning what the masjid typed into things a thumb can tap.
 *
 * Not `contact.ts`: this repository is developed on a case-insensitive filesystem, where that
 * and `Contact.tsx` are the same name and an import resolves to whichever TypeScript saw first.
 * The same split as `Qibla.tsx`/`bearing.ts` and `Notify.tsx`/`reminders.ts`.
 *
 * The server's `contact.ts` decides what may be STORED; this decides what may become an `href`,
 * and the two are deliberately separate checks of the same thing. The volume outlives any one
 * build, so a value that a looser version once accepted has to be refused again on the way out
 * — the page must never be the only place a `javascript:` URL was going to be caught.
 *
 * Everything here is pure and none of it renders, so the rules can be tested without a browser.
 */

export const SOCIALS = ['whatsapp', 'instagram', 'facebook', 'x', 'youtube', 'telegram'] as const;
export type Social = (typeof SOCIALS)[number];

export interface Contact {
  phone: string;
  email: string;
  address: string;
  website: string;
  whatsapp: string;
  instagram: string;
  facebook: string;
  x: string;
  youtube: string;
  telegram: string;
}

export const SOCIAL_LABEL: Record<Social, string> = {
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Facebook',
  x: 'X',
  youtube: 'YouTube',
  telegram: 'Telegram',
};

/** http(s) or nothing. See the note at the top: this is the second of two checks, not the only
 *  one, and it exists because the first one happened in a different process on a different day. */
export function safeUrl(raw: string): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

/**
 * A phone number as a number to dial.
 *
 * The DISPLAYED text is whatever the masjid typed — "+44 (0)20 7946 0000" is how they write it
 * and how somebody will recognise it. The `tel:` is the same string with everything a dialler
 * cannot use taken out, keeping a leading `+` because dropping it breaks an international
 * number in the one case where it matters most.
 */
export function telHref(phone: string): string {
  const v = (phone ?? '').trim();
  if (!v) return '';
  const international = v.startsWith('+');
  /**
   * **`+44 (0)20 7946 0000` is one number, not two.**
   *
   * The bracketed zero is the TRUNK PREFIX: you dial it instead of the country code from inside
   * the country, never as well as it. Stripping punctuation and keeping the digit produces
   * `+4402079460000`, which does not reach anybody — and it is the way a very large number of
   * British masjids write their number down, so this is not an edge case, it is Tuesday.
   *
   * Only when the number is written in international form. Without a `+`, a leading 0 IS the
   * trunk prefix and is the thing that makes it dialable.
   */
  const body = international ? v.replace(/\(\s*0\s*\)/g, '') : v;
  const digits = body.replace(/\D/g, '');
  return digits ? `tel:${international ? '+' : ''}${digits}` : '';
}

export function mailHref(email: string): string {
  const v = (email ?? '').trim();
  // No angle brackets, quotes or newlines — a `mailto:` is a URL, and a newline in one is how a
  // header gets injected into whatever mail client opens it.
  return v && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) ? `mailto:${encodeURIComponent(v)}` : '';
}

/**
 * Directions to the masjid.
 *
 * A search rather than a pin, because what is stored is text somebody typed and not a
 * coordinate: handing the address to a map's own search is the thing most likely to find the
 * building, and it degrades to "here is roughly the street" rather than to a pin in the sea.
 *
 * Offered as a separate action rather than by making the address itself a link. Tapping it sends
 * the masjid's address to a mapping service, which is fine — it is a public address and the
 * musalli chose to — but it should be a choice, not something that happens because somebody
 * pressed the text to select it.
 *
 * **Two of them, because an iPhone has two** (Hasan, 2026-08-30). Sending an iPhone straight to
 * Google Maps is a guess about somebody else's phone: half of them do not have it installed and
 * land in a browser page asking them to, having pressed a button that said "Directions". Which
 * to open is a question only the reader can answer, so on iOS it is asked. Everywhere else there
 * is one answer and it is not worth asking.
 */
export function mapsHref(address: string): string {
  const v = mapQuery(address);
  return v ? `https://www.google.com/maps/search/?api=1&query=${v}` : '';
}

/** Apple's own. `?q=` is a search, matching the Google form above — and on an iPhone this opens
 *  the Maps app itself rather than a web page pretending to be it. */
export function appleMapsHref(address: string): string {
  const v = mapQuery(address);
  return v ? `https://maps.apple.com/?q=${v}` : '';
}

/** The address as one encoded line. The newlines a masjid typed are meaningful on the card and
 *  meaningless to a search box, so they are collapsed here and only here. */
function mapQuery(address: string): string {
  const v = (address ?? '').replace(/\s+/g, ' ').trim();
  return v ? encodeURIComponent(v) : '';
}

/** The links that are actually set, in the order they are drawn. */
export function socialsOf(c: Contact): { id: Social; url: string }[] {
  return SOCIALS.map((id) => ({ id, url: safeUrl(c[id]) })).filter((s) => s.url !== '');
}

/**
 * Is there anything worth drawing a card for?
 *
 * Checked against what SURVIVES sanitising, not against what is stored. A masjid whose only
 * entry is a link this app will not render has nothing to show, and an empty card headed
 * "Contact" would be worse than no card — it would look like something failed to load.
 */
export function hasContact(c: Contact | null | undefined): boolean {
  if (!c) return false;
  return !!(
    telHref(c.phone) ||
    mailHref(c.email) ||
    c.address.trim() ||
    safeUrl(c.website) ||
    socialsOf(c).length > 0
  );
}
