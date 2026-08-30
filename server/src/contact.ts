// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions

/**
 * contact.ts — how to reach the masjid.
 *
 * Asked for by Hasan on 2026-08-30. It is the smallest feature in this app and the one with the
 * clearest reason to exist: somebody who has just installed a masjid's prayer times is exactly
 * the person who will later need its phone number, and until now they had to go and find the
 * website they were trying not to have to open.
 *
 * **Every field is optional and nothing is invented.** A masjid that fills in a phone number and
 * nothing else gets a card with a phone number on it — not a row of empty placeholders, and not
 * a "no website set" line. The absence of a field is the masjid saying nothing, which is an
 * answer, and the musalli page renders exactly what it was given.
 *
 * This is the masjid's own public information, deliberately unlike everything else this app
 * stores: it is meant to be read by strangers. It is still validated as if it were hostile,
 * because it is typed into a form and rendered on a page — `safeUrl` refuses anything that is
 * not http(s), so a `javascript:` URL cannot become an `href` even if an older build let one
 * onto the volume.
 */
import { z } from 'zod';
import type { Store } from './store';

const KEY = 'masjid.contact';

/**
 * The networks offered.
 *
 * A fixed list rather than free-form "add a link", because each one gets an icon and a name on
 * the musalli page, and a list somebody can add to is a list this app cannot label. Adding one
 * later is an entry here and an entry in the web's icon map — a deliberate two-line change
 * rather than an accident.
 */
export const SOCIALS = ['whatsapp', 'instagram', 'facebook', 'x', 'youtube', 'telegram'] as const;
export type Social = (typeof SOCIALS)[number];

/** Generous. A phone number written the way a masjid writes it — "+44 (0)20 7946 0000 ext 2" —
 *  is longer than the digits suggest, and this is display text, not something we dial. */
const PHONE_MAX = 40;
const EMAIL_MAX = 120;
const ADDRESS_MAX = 250;
const URL_MAX = 300;

/**
 * A URL that is safe to put in an `href`, or '' .
 *
 * http(s) only. The obvious danger is `javascript:`, and the less obvious one is a scheme that
 * looks harmless — `data:`, `blob:`, `file:` — reaching a link somebody taps on their own phone.
 * Parsed with `URL` rather than matched with a regex, because a regex on a URL is a way of
 * being nearly right.
 */
export function safeUrl(raw: string): string {
  const v = (raw ?? '').trim();
  if (!v || v.length > URL_MAX) return '';
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : '';
  } catch {
    return '';
  }
}

/**
 * What somebody typed, turned into a URL if it plausibly was one.
 *
 * Masjids type "example.org", not "https://example.org", and refusing that is a form that says
 * "invalid" at somebody who gave a perfectly good answer. A bare host or path gets https:// put
 * in front of it and is then held to the same standard as anything else.
 */
export function coerceUrl(raw: string): string {
  const v = (raw ?? '').trim();
  if (!v) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return safeUrl(v);
  return safeUrl(`https://${v}`);
}

const urlField = z
  .string()
  .max(URL_MAX)
  .default('')
  .transform((v) => coerceUrl(v));

/** The fields, once, so reading and writing cannot drift apart. */
export const FIELDS = ['phone', 'email', 'address', 'website', ...SOCIALS] as const;

export const ContactSchema = z.object({
  phone: z.string().max(PHONE_MAX).default('').transform((v) => v.trim()),
  /** Checked loosely on purpose. A strict address grammar rejects real addresses, and the worst
   *  case of a wrong one here is a `mailto:` that opens a mail app with a typo in it. */
  email: z
    .string()
    .max(EMAIL_MAX)
    .default('')
    .transform((v) => v.trim())
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'that does not look like an email address'),
  /** Newlines are kept — an address is written on several lines and flattening it into one is a
   *  small disrespect to the only field on this form somebody may copy onto an envelope. */
  address: z.string().max(ADDRESS_MAX).default('').transform((v) => v.replace(/[ \t]+/g, ' ').trim()),
  website: urlField,
  whatsapp: urlField,
  instagram: urlField,
  facebook: urlField,
  x: urlField,
  youtube: urlField,
  telegram: urlField,
});

export type Contact = z.infer<typeof ContactSchema>;

export const EMPTY_CONTACT: Contact = {
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

/** Is there anything at all to show? The musalli page draws no card when this is false, rather
 *  than an empty one — see the note at the top of this file. */
export function hasAnyContact(c: Contact): boolean {
  return Object.values(c).some((v) => v !== '');
}

/**
 * Read what is stored, through the schema — FIELD BY FIELD.
 *
 * Parsed on the way out as well as on the way in, because the volume outlives this build: a row
 * written by a version with looser rules has to come back as something this app is willing to
 * render, and the page must not be the first thing to notice.
 *
 * **Each field is parsed on its own, and that is the whole point of doing it this way.** Parsing
 * the object as a unit meant one unreadable value — a number where a string should be, a field
 * from a future build — emptied the record, so a masjid could lose the phone number they had
 * typed correctly because something else on the row was wrong. One bad value now costs that
 * value and nothing else.
 *
 * The WRITE path deliberately keeps the whole-object schema: there, a bad email is something the
 * admin should be told about while they are looking at the form, not something quietly dropped.
 */
export function getContact(store: Store): Contact {
  const raw = store.getJson<unknown>(KEY, {});
  const out: Contact = { ...EMPTY_CONTACT };
  if (!raw || typeof raw !== 'object') return out;
  const row = raw as Record<string, unknown>;
  for (const key of FIELDS) {
    const one = ContactSchema.shape[key].safeParse(row[key]);
    if (one.success) out[key] = one.data;
  }
  return out;
}

export function setContact(store: Store, c: Contact): void {
  store.setJson(KEY, c);
}
